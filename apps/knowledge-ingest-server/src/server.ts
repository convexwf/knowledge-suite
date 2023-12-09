import cors from "@fastify/cors";
import fastify from "fastify";
import {
  AIAnnotationGenerateRequestSchema,
  AnnotationSchema,
  BatchDiscoverRequestSchema,
  BatchJobCreateRequestSchema,
  BatchJobItem,
  KnowledgeCapturePreviewRequestSchema,
  KnowledgeCaptureReparseRequestSchema,
  KnowledgeCaptureSaveRequestSchema,
  KnowledgeDocument,
  KnowledgeItem,
  normalizeUrlForKnowledge,
  RawDoc,
  EpubImportResponse,
  StoreClearParsedRequestSchema,
  StoreClearRequestSchema,
  urlHash
} from "@uknowledge/knowledge-schema";
import { createAIProvider } from "./ai-annotation/provider.js";
import { taskManager } from "./ai-annotation/task.js";
import { loadConfig, ServerConfig } from "./config.js";
import { parseEpub, type CalibreMetadata, type PandocRunner, type TocEntry } from "./epub.js";
import { ResolvedInput, resolveKnowledgeCaptureInput } from "./input.js";
import { documentToMarkdown } from "./markdown.js";
import { parsePage, type ParsedPage } from "./parser.js";
import { KnowledgeStore } from "./store.js";

type RuntimeServerConfig = Omit<ServerConfig, "maxImportBytes"> & {
  maxImportBytes?: number;
  epubPandocRunner?: PandocRunner;
};

export async function buildServer(config: RuntimeServerConfig = loadConfig()) {
  const maxImportBytes = config.maxImportBytes ?? 100 * 1024 * 1024;
  const effectiveConfig: ServerConfig = { ...config, maxImportBytes };
  const app = fastify({
    logger: true,
    bodyLimit: Math.max(config.maxHtmlBytes, maxImportBytes)
  });
  const store = new KnowledgeStore(config.storeRoot);
  const activeBatchRuns = new Set<Promise<void>>();
  let shuttingDown = false;
  await store.ensure();
  const recovered = await store.recoverStaleJobs();
  if (recovered > 0) {
    app.log.info(`Recovered ${recovered} stale batch job(s) from previous session.`);
  }

  app.addContentTypeParser([
    "application/epub+zip",
    "application/octet-stream"
  ], { parseAs: "buffer", bodyLimit: maxImportBytes }, (_request, body, done) => {
    done(null, body);
  });

  app.addContentTypeParser(/^multipart\/form-data/i, { parseAs: "buffer", bodyLimit: maxImportBytes }, (_request, body, done) => {
    done(null, body);
  });

  app.addHook("onClose", async () => {
    shuttingDown = true;
    await Promise.allSettled([...activeBatchRuns]);
    store.close();
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      callback(null, isAllowedCorsOrigin(origin));
    }
  });

  app.setErrorHandler(async (error, _request, reply) => {
    if (isBodyTooLargeError(error)) {
      await reply.code(413).send({
        error: "payload_too_large",
        message: `Current HTML upload is too large for direct browser transfer. The server limit is ${formatBytes(
          config.maxHtmlBytes
        )}. Switch the extension to Server Fetch mode for this page, or increase KNOWLEDGE_MAX_HTML_BYTES if the fetched HTML is also larger than this limit.`
      });
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    const statusCode = isClientInputError(message) ? 400 : 500;
    await reply.code(statusCode).send({
      error: statusCode === 400 ? "bad_request" : "internal_error",
      message
    });
  });

  app.addHook("preHandler", async (request, reply) => {
    if (request.url === "/api/health") {
      return;
    }

    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (token !== config.token) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "knowledge-ingest-server",
    version: "0.1.0",
    storeRoot: config.storeRoot,
    store: {
      type: "sqlite",
      indexPath: "index.sqlite3"
    },
    limits: {
      fetchTimeoutMs: config.fetchTimeoutMs,
      maxHtmlBytes: config.maxHtmlBytes,
      maxImportBytes
    }
  }));

  // ── Ingest routes ──────────────────────────────────────────────────────

  function itemStatus(item: KnowledgeItem | null, fallbackUrl: string) {
    if (!item) return {
      normalizedUrl: fallbackUrl, urlHash: urlHash(fallbackUrl),
      state: "empty", hasRawdoc: false, hasDocument: false,
      itemId: undefined, docId: undefined, rawdocId: undefined
    };
    const title = item.title ?? undefined;
    const normalizedUrl = item.normalizedUrl || fallbackUrl;
    return {
      normalizedUrl,
      urlHash: item.identityHash,
      state: item.state === "captured" ? "captured" as const : "parsed" as const,
      hasRawdoc: Boolean(item.activeRawdocId),
      hasDocument: Boolean(item.activeDocId),
      originalUrl: item.originalUrl,
      canonicalUrl: item.canonicalUrl,
      itemId: item.itemId,
      docId: item.activeDocId,
      rawdocId: item.activeRawdocId,
      title,
      pageTitle: item.pageTitle ?? title,
      contentTitle: item.contentTitle ?? title,
      displayTitle: item.displayTitle || title || new URL(normalizedUrl).hostname,
      captureSavedAt: item.createdAt,
      captureUpdatedAt: item.updatedAt,
      parseUpdatedAt: item.parsedAt
    };
  }

  app.get("/api/ingest/status", async (request) => {
    const query = request.query as { url?: string };
    if (!query.url) throw new Error("url is required");
    return itemStatus(await store.status(query.url), query.url);
  });

  app.delete("/api/ingest", async (request) => {
    const query = request.query as { url?: string; mode?: "purge" | "remove" };
    if (!query.url) throw new Error("url is required");
    return store.deleteByUrl(query.url, query.mode === "purge" ? "purge" : "remove");
  });

  app.post("/api/ingest/preview", { bodyLimit: config.maxHtmlBytes }, async (request) => {
    const input = KnowledgeCapturePreviewRequestSchema.parse(request.body);
    const resolved = await resolveKnowledgeCaptureInput(input, effectiveConfig);
    const parsed = await parsePage(resolved);
    const status = itemStatus(await store.status(resolved.normalizedUrl), resolved.normalizedUrl);
    return { ...previewPayload(parsed), status };
  });

  app.post("/api/ingest/save", { bodyLimit: config.maxHtmlBytes }, async (request) => {
    const input = KnowledgeCaptureSaveRequestSchema.parse(request.body);
    const resolved = await resolveKnowledgeCaptureInput(input, effectiveConfig);
    const parsed = await parsePage(resolved, { selectedCandidateId: input.candidateId });
    const markdown = documentToMarkdown(parsed.document);
    const paths = await store.save({
      normalizedUrl: resolved.normalizedUrl,
      html: resolved.html,
      rawdoc: parsed.rawdoc,
      document: parsed.document,
      markdown
    });
    const status = itemStatus(await store.status(resolved.normalizedUrl), resolved.normalizedUrl);
    return { ...previewPayload(parsed), status, saved: true, paths };
  });

  app.post("/api/ingest/reparse", async (request) => {
    const input = KnowledgeCaptureReparseRequestSchema.parse(request.body);
    const capture = await store.loadCaptureByUrl(input.url);
    const oldDocId = capture.item.activeDocId;
    const resolved = resolvedInputFromCapture(capture.rawdoc, capture.html);
    const parsed = await parsePage(resolved, { rawdocId: capture.rawdoc.rawdoc_id });
    const markdown = documentToMarkdown(parsed.document);
    const paths = await store.save({
      normalizedUrl: resolved.normalizedUrl,
      html: resolved.html,
      rawdoc: parsed.rawdoc,
      document: parsed.document,
      markdown
    });
    const status = itemStatus(await store.status(resolved.normalizedUrl), resolved.normalizedUrl);
    const annotationWarnings = await migrateAnnotationsForReparse(store, oldDocId, parsed.document);
    return { ...previewPayload(parsed), status, saved: true, paths, ...(annotationWarnings ? { annotationWarnings } : {}) };
  });

  app.get("/api/items", async (request) => {
    const query = request.query as { sourceType?: string; limit?: string };
    return store.listItems(query.sourceType, query.limit ? Number(query.limit) : undefined);
  });

  app.get("/api/items/:itemId", async (request) => {
    const params = request.params as { itemId: string };
    return store.loadItemDetail(params.itemId);
  });

  app.get("/api/documents/:docId", async (request) => {
    const params = request.params as { docId: string };
    return store.loadDocument(params.docId);
  });

  app.get("/api/documents/:docId/markdown", async (request, reply) => {
    const params = request.params as { docId: string };
    await reply.type("text/markdown; charset=utf-8").send(await store.loadMarkdown(params.docId));
  });

  app.get("/api/documents/:docId/annotations", async (request) => {
    const params = request.params as { docId: string };
    return { doc_id: params.docId, annotations: await store.loadAnnotations(params.docId) };
  });

  app.get("/api/items/:itemId/annotations", async (request) => {
    const params = request.params as { itemId: string };
    const detail = await store.loadItemDetail(params.itemId);
    const docId = detail.document?.doc_id ?? detail.item?.activeDocId;
    if (!docId) return { doc_id: null, annotations: [] };
    return { doc_id: docId, annotations: await store.loadAnnotations(docId) };
  });

  app.post("/api/documents/:docId/annotations", async (request) => {
    const params = request.params as { docId: string };
    const annotation = AnnotationSchema.parse(request.body);
    await store.saveAnnotation(params.docId, annotation);
    return { saved: true, annotation_id: annotation.annotation_id };
  });

  app.post("/api/items/:itemId/annotations", async (request) => {
    const params = request.params as { itemId: string };
    const detail = await store.loadItemDetail(params.itemId);
    const docId = detail.document?.doc_id ?? detail.item?.activeDocId;
    if (!docId) throw new Error("Item has no active document");
    const annotation = AnnotationSchema.parse(request.body);
    await store.saveAnnotation(docId, annotation);
    return { saved: true, annotation_id: annotation.annotation_id };
  });

  app.delete("/api/documents/:docId/annotations/:annotationId", async (request) => {
    const params = request.params as { docId: string; annotationId: string };
    await store.deleteAnnotation(params.docId, params.annotationId);
    return { deleted: true, annotation_id: params.annotationId };
  });

  app.delete("/api/items/:itemId/annotations/:annotationId", async (request) => {
    const params = request.params as { itemId: string; annotationId: string };
    const detail = await store.loadItemDetail(params.itemId);
    const docId = detail.document?.doc_id ?? detail.item?.activeDocId;
    if (!docId) throw new Error("Item has no active document");
    await store.deleteAnnotation(docId, params.annotationId);
    return { deleted: true, annotation_id: params.annotationId };
  });

  app.delete("/api/documents/:docId/annotations", async (request) => {
    const params = request.params as { docId: string };
    const before = await store.loadAnnotations(params.docId);
    const count = before.length;
    await store.deleteAnnotationsForDoc(params.docId);
    return { deleted: true, doc_id: params.docId, count };
  });

  app.delete("/api/items/:itemId/annotations", async (request, reply) => {
    const params = request.params as { itemId: string };
    const detail = await store.loadItemDetail(params.itemId);
    const docId = detail.document?.doc_id ?? detail.item?.activeDocId;
    if (!docId) {
      reply.code(404);
      return { error: "Item has no active document" };
    }
    const before = await store.loadAnnotations(docId);
    const count = before.length;
    await store.deleteAnnotationsForDoc(docId);
    return { deleted: true, doc_id: docId, count };
  });

  app.get("/api/annotations", async () => {
    const rows = await store.listAnnotationItems();
    return {
      items: rows.map((row) => ({
        itemId: row.item_id,
        docId: row.doc_id,
        normalizedUrl: row.normalized_url,
        title: row.title ?? null,
        displayTitle: row.page_title ?? row.title ?? row.normalized_url ?? row.item_id,
        count: row.annotation_count,
        types: row.types
      }))
    };
  });

  const aiEnabled = process.env.KNOWLEDGE_AI_ENABLED === "true";
  if (aiEnabled) {
    const aiModel = process.env.KNOWLEDGE_AI_OLLAMA_MODEL ?? "qwen2.5:7b";
    const aiProvider = createAIProvider({
      enabled: true,
      provider: process.env.KNOWLEDGE_AI_PROVIDER ?? "ollama",
      model: aiModel,
    });

    app.post("/api/documents/:docId/ai-annotations", async (request, reply) => {
      const params = request.params as { docId: string };
      const body = AIAnnotationGenerateRequestSchema.parse(request.body);
      const types = body.types ?? ["summary"];
      const force = body.force ?? false;

      // Pre-check Ollama
      const ollamaBaseUrl = process.env.KNOWLEDGE_AI_OLLAMA_BASE_URL ?? "http://localhost:11434";
      try {
        const healthResp = await fetch(`${ollamaBaseUrl}/v1/models`, {
          signal: AbortSignal.timeout(10000),
        });
        if (!healthResp.ok) {
          reply.code(503);
          return { error: `Ollama not available (status ${healthResp.status})` };
        }
        const healthData = await healthResp.json() as { data?: Array<{ id: string }> };
        const models = healthData.data?.map((m: { id: string }) => m.id) ?? [];
        if (!models.includes(aiModel)) {
          reply.code(503);
          return { error: `Model "${aiModel}" not found in Ollama. Available: ${models.join(", ")}` };
        }
      } catch (err) {
        reply.code(503);
        return { error: `Cannot reach Ollama at ${ollamaBaseUrl}: ${err instanceof Error ? err.message : String(err)}` };
      }

      const document = await store.loadDocument(params.docId);
      if (!document) {
        reply.code(404);
        return { error: "Document not found" };
      }

      let headingIds = body.section_ids;
      if (!headingIds || headingIds.length === 0) {
        headingIds = document.sections
          .filter((s) => s.type === "heading" && s.section_id)
          .map((s) => s.section_id!);
      }

      if (types.includes("summary")) {
        const invalidIds = headingIds.filter((id) => {
          const s = document.sections.find((sec) => sec.section_id === id);
          return !s || s.type !== "heading";
        });
        if (invalidIds.length > 0) {
          reply.code(400);
          return { error: `summary requires heading sections, invalid: ${invalidIds.join(", ")}` };
        }
      }

      const { task, replaced } = taskManager.createTask(
        aiProvider, store, document, aiModel, headingIds, force
      );
      void task.start();

      const state = task.toState();
      return { ...state, ...(replaced ? { replaced } : {}) };
    });

    // Item-first AI annotation route
    app.post("/api/items/:itemId/ai-annotations", async (request, reply) => {
      const params = request.params as { itemId: string };
      const body = AIAnnotationGenerateRequestSchema.parse(request.body);
      const detail = await store.loadItemDetail(params.itemId);
      const docId = detail.document?.doc_id ?? detail.item?.activeDocId;
      if (!docId) {
        reply.code(404);
        return { error: "Item has no active document" };
      }
      const document = await store.loadDocument(docId);
      if (!document) {
        reply.code(404);
        return { error: "Document not found" };
      }
      let headingIds = body.section_ids;
      if (!headingIds || headingIds.length === 0) {
        headingIds = document.sections
          .filter((s) => s.type === "heading" && s.section_id)
          .map((s) => s.section_id!);
      }
      const { task, replaced } = taskManager.createTask(
        aiProvider, store, document, aiModel, headingIds, body.force ?? false
      );
      void task.start();
      const state = task.toState();
      return { ...state, ...(replaced ? { replaced } : {}) };
    });

    app.get("/api/tasks/:taskId", async (request, reply) => {
      const params = request.params as { taskId: string };
      const task = taskManager.getTask(params.taskId);
      if (!task) {
        reply.code(404);
        return { error: "Task not found" };
      }
      return task.toState();
    });

    app.delete("/api/tasks/:taskId", async (request) => {
      const params = request.params as { taskId: string };
      const task = taskManager.getTask(params.taskId);
      if (!task) return { cancelled: false, error: "Task not found" };
      const completed = task.completed;
      taskManager.cancelTask(params.taskId);
      return { cancelled: true, task_id: params.taskId, completed };
    });

    app.patch("/api/tasks/:taskId/headings", async (request, reply) => {
      const params = request.params as { taskId: string };
      const body = request.body as { add?: string[]; remove?: string[] } | undefined;
      const task = taskManager.getTask(params.taskId);
      if (!task) { reply.code(404); return { error: "Task not found" }; }

      let added = 0;
      let removed = 0;
      if (body?.add) added = task.addHeadings(body.add, false);
      if (body?.remove) removed = task.removeHeadings(body.remove);
      return { added, removed, state: task.toState() };
    });

    app.post("/api/tasks/:taskId/pause", async (request, reply) => {
      const params = request.params as { taskId: string };
      const task = taskManager.getTask(params.taskId);
      if (!task) { reply.code(404); return { error: "Task not found" }; }
      task.pause();
      return task.toState();
    });

    app.post("/api/tasks/:taskId/resume", async (request, reply) => {
      const params = request.params as { taskId: string };
      const task = taskManager.getTask(params.taskId);
      if (!task) { reply.code(404); return { error: "Task not found" }; }
      task.resume();
      return task.toState();
    });
  }

  app.get("/api/assets/:assetId", async (request, reply) => {
    const params = request.params as { assetId: string };
    const asset = await store.loadAsset(params.assetId);
    await reply.type(asset.contentType).send(asset.bytes);
  });

  app.get("/api/collections", async (request) => {
    const query = request.query as { limit?: string };
    return store.listCollections(query.limit ? Number(query.limit) : undefined);
  });

  app.get("/api/collections/by-doc", async (request) => {
    const query = request.query as { docId?: string };
    if (!query.docId) {
      return { collections: [] };
    }
    return store.getCollectionsByDocId(query.docId);
  });

  app.get("/api/collections/used-doc-ids", async () => {
    return store.getUsedCollectionDocIds();
  });

  app.get("/api/collections/:collectionId/navigation", async (request) => {
    const params = request.params as { collectionId: string };
    const query = request.query as { itemId?: string };
    if (!query.itemId) {
      return { previous: null, next: null };
    }
    return store.getCollectionNavigation(params.collectionId, query.itemId);
  });

  app.get("/api/collections/:collectionId", async (request) => {
    const params = request.params as { collectionId: string };
    return store.loadCollection(params.collectionId);
  });

  app.delete("/api/collections/:collectionId", async (request) => {
    const params = request.params as { collectionId: string };
    return store.deleteCollection(params.collectionId);
  });

  app.get("/api/collections/check-name", async (request) => {
    const query = request.query as { title?: string };
    if (!query.title?.trim()) {
      return { exists: false };
    }
    return store.checkCollectionName(query.title);
  });

  app.get("/api/search", async (request) => {
    const query = request.query as {
      q?: string;
      limit?: string;
      docId?: string;
      url?: string;
      parserMethod?: string;
      trace?: string;
    };
    if (!query.q?.trim()) {
      throw new Error("q is required");
    }

    return {
      query: query.q,
      retriever: "sqlite_fts" as const,
      results: await store.search(query.q, {
        limit: query.limit ? Number(query.limit) : undefined,
        docId: query.docId,
        url: query.url,
        parserMethod: query.parserMethod,
        trace: query.trace === "true" || query.trace === "1"
      })
    };
  });

  app.get("/api/context", async (request) => {
    const query = request.query as {
      q?: string;
      limit?: string;
      maxChars?: string;
      docId?: string;
      url?: string;
      parserMethod?: string;
      trace?: string;
    };
    if (!query.q?.trim()) {
      throw new Error("q is required");
    }

    return store.retrieveContext(query.q, {
      limit: query.limit ? Number(query.limit) : undefined,
      maxChars: query.maxChars ? Number(query.maxChars) : undefined,
      docId: query.docId,
      url: query.url,
      parserMethod: query.parserMethod,
      trace: query.trace === "true" || query.trace === "1"
    });
  });

  app.get("/api/store/scan", async () => store.scanMaintenance());

  app.post("/api/store/clear", async (request) => {
    const parsed = StoreClearRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new Error("store clear confirmation is required");
    }
    return store.clearAll();
  });

  app.post("/api/store/clear-parsed", async (request) => {
    const parsed = StoreClearParsedRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new Error("store parsed-results clear confirmation is required");
    }
    return store.clearParsedResults();
  });

  app.post("/api/import/epub", async (request): Promise<EpubImportResponse> => {
    const input = parseEpubImportRequest(request.headers["content-type"], request.body);
    const parsed = await parseEpub(input.file, {
      sourceUri: input.sourceUri,
      titleHint: input.titleHint,
      tags: input.tags,
      metadataOpf: input.metadataOpf,
      cover: input.cover,
      pandocRunner: config.epubPandocRunner
    });
    try {
      const documentWithAssets = await store.prepareDocumentAssets(parsed.document);
      const markdown = documentToMarkdown(documentWithAssets);
      const result = await store.saveImportItem({
        itemId: parsed.itemId,
        sourceType: "epub",
        sourceUri: parsed.rawdoc.source_uri ?? input.file,
        rawdocId: parsed.rawdoc.rawdoc_id,
        rawdoc: parsed.rawdoc,
        rawContentPath: input.file,
        document: documentWithAssets,
        markdown,
        pageTitle: parsed.rawdoc.metadata?.pageTitle as string | undefined,
        identityHash: parsed.identityHash,
        content: input.file,
        contentExt: "epub",
        epubMetadata: parsed.epubMetadata
      });
      return {
        knowledgeItem: result.knowledgeItem,
        rawdoc: parsed.rawdoc,
        document: documentWithAssets,
        markdown,
        saved: true,
        paths: result.paths
      };
    } finally {
      await parsed.cleanup();
    }
  });

  app.post("/api/items/:itemId/reparse", async (request): Promise<EpubImportResponse> => {
    const params = request.params as { itemId: string };
    const capture = await store.loadRawContentForItem(params.itemId);
    const oldDocId = capture.item.activeDocId;

    if (capture.rawdoc.source_type === "epub") {
      const epubBuffer = capture.contentExt === "epub"
        ? Buffer.from(capture.content, "base64")
        : Buffer.from(capture.content);
      const parsed = await parseEpub(epubBuffer, {
        rawdocId: capture.rawdoc.rawdoc_id,
        sourceUri: capture.rawdoc.source_uri,
        calibreMetadata: calibreMetadataFromRawdoc(capture.rawdoc),
        pandocRunner: config.epubPandocRunner,
        toc: Array.isArray(capture.toc) ? capture.toc as TocEntry[] : undefined
      });
      try {
        if (oldDocId) {
          await store.deleteDerivedArtifacts(oldDocId);
        }
        const documentWithAssets = await store.prepareDocumentAssets(parsed.document);
        const markdown = documentToMarkdown(documentWithAssets);
        const rawdoc = {
          ...parsed.rawdoc,
          metadata: {
            ...parsed.rawdoc.metadata,
            reparsedFromItemId: capture.item.itemId
          }
        };
        const result = await store.saveReparseResult({
          itemId: capture.item.itemId,
          sourceType: capture.rawdoc.source_type,
          sourceUri: capture.rawdoc.source_uri,
          rawdocId: capture.rawdoc.rawdoc_id,
          rawdoc,
          document: documentWithAssets,
          markdown,
          pageTitle: capture.item.title,
          language: capture.item.language,
          creators: capture.item.creators,
          identityHash: capture.item.identityHash
        });
        const annotationWarnings = await migrateAnnotationsForReparse(
          store, oldDocId, documentWithAssets
        );
        return {
          knowledgeItem: result.knowledgeItem,
          rawdoc,
          document: documentWithAssets,
          markdown,
          saved: true as const,
          paths: result.paths,
          ...(annotationWarnings ? { annotationWarnings } : {})
        };
      } finally {
        await parsed.cleanup();
      }
    }

    const html = capture.content;
    const resolved = resolvedInputFromCapture(capture.rawdoc, html);
    const parsed = await parsePage(resolved, { rawdocId: capture.rawdoc.rawdoc_id });

    if (oldDocId) {
      await store.deleteDerivedArtifacts(oldDocId);
    }
    const documentWithAssets = await store.prepareDocumentAssets(parsed.document);
    const markdown = documentToMarkdown(documentWithAssets);
    const rawdoc = {
      ...parsed.rawdoc,
      metadata: {
        ...parsed.rawdoc.metadata,
        reparsedFromItemId: capture.item.itemId
      }
    };
    const result = await store.saveReparseResult({
      itemId: capture.item.itemId,
      sourceType: capture.rawdoc.source_type,
      sourceUri: capture.rawdoc.source_uri,
      rawdocId: capture.rawdoc.rawdoc_id,
      rawdoc,
      document: documentWithAssets,
      markdown,
      pageTitle: capture.item.title,
      language: capture.item.language,
      creators: capture.item.creators,
      identityHash: capture.item.identityHash
    });
    const annotationWarnings = await migrateAnnotationsForReparse(
      store, oldDocId, documentWithAssets
    );
    return {
      knowledgeItem: result.knowledgeItem,
      rawdoc,
      document: documentWithAssets,
      markdown,
      saved: true as const,
      paths: result.paths,
      ...(annotationWarnings ? { annotationWarnings } : {})
    };
  });

  app.delete("/api/items/:itemId", async (request) => {
    const params = request.params as { itemId: string };
    const query = request.query as { mode?: "purge" | "remove" };
    return store.deleteItem(params.itemId, query.mode === "purge" ? "purge" : "remove");
  });

  app.post("/api/batch/discover", async (request) => {
    const input = BatchDiscoverRequestSchema.parse(request.body);
    const scope = input.scope ?? { sameOrigin: true, maxItems: 50 };
    const pageUrl = new URL(input.pageUrl);
    const pathPrefix = scope.pathPrefix ?? defaultPathPrefix(pageUrl.pathname);
    const seen = new Set<string>();
    const items = [];

    for (let index = 0; index < input.candidates.length; index += 1) {
      const candidate = input.candidates[index];
      const url = new URL(candidate.url);
      if (scope.sameOrigin && url.origin !== pageUrl.origin) {
        continue;
      }
      // Keep hash for same-origin URLs (SPA routing), strip for cross-origin
      const dedupUrl = url.origin === pageUrl.origin ? url.toString() : normalizeUrlForKnowledge(url.toString());
      if (seen.has(dedupUrl)) {
        continue;
      }
      seen.add(dedupUrl);
      const normalizedUrl = normalizeUrlForKnowledge(url.toString());
      if (items.length >= (scope.maxItems ?? 50)) {
        break;
      }

      const status = await store.status(normalizedUrl);
      items.push({
        url: url.toString(),
        normalizedUrl,
        titleHint: candidate.titleHint ?? candidate.text,
        source: candidate.source,
        order: candidate.order ?? index,
        depth: candidate.depth ?? 0,
        selectedByDefault: url.pathname.startsWith(pathPrefix),
        status: status?.state ?? "empty",
        docId: status?.activeDocId,
        rawdocId: status?.activeRawdocId
      });
    }

    return {
      pageUrl: input.pageUrl,
      items,
      stats: {
        inputCount: input.candidates.length,
        dedupedCount: seen.size,
        selectedCount: items.filter((item) => item.selectedByDefault).length
      }
    };
  });

  app.post("/api/batch/jobs", async (request) => {
    const input = BatchJobCreateRequestSchema.parse(request.body);
    const rawItems: Array<{
      url: string;
      titleHint?: string;
      source?: string;
      order?: number;
      depth?: number;
    }> = input.items?.length
      ? input.items
      : (input.urls ?? []).map((url, index) => ({ url, order: index }));
    const seen = new Set<string>();
    const items = rawItems
      .map((item, index) => ({
        url: item.url,
        normalizedUrl: normalizeUrlForKnowledge(item.url),
        titleHint: item.titleHint,
        source: item.source,
        orderIndex: item.order ?? index,
        depth: item.depth ?? 0
      }))
      .filter((item) => {
        if (seen.has(item.normalizedUrl)) {
          return false;
        }
        seen.add(item.normalizedUrl);
        return true;
      })
      .sort((left, right) => left.orderIndex - right.orderIndex);

    const collection = await store.upsertCollection({
      collectionId: input.collection.strategy === "update" ? input.collection.collectionId : undefined,
      title: input.collection.title,
      rootUrl: input.collection.rootUrl,
      normalizedRootUrl: normalizeUrlForKnowledge(input.collection.rootUrl),
      sourceType: "manual_section"
    });
    await store.replaceCollectionItems(collection.collectionId, items.map((item, index) => ({
      normalizedUrl: item.normalizedUrl,
      title: item.titleHint,
      source: item.source,
      orderIndex: index,
      depth: item.depth
    })));
    const job = await store.createBatchJob({
      collectionId: collection.collectionId,
      sourcePageUrl: input.sourcePageUrl,
      mode: input.mode,
      totalCount: items.length,
      items: items.map((item) => ({
        url: item.url,
        normalizedUrl: item.normalizedUrl,
        source: item.source,
        titleHint: item.titleHint
      })),
      options: input.options
    });

    const fullJob = await store.loadBatchJob(job.jobId);

    const run = runBatchJob(job.jobId, input.options ?? {}).finally(() => {
      activeBatchRuns.delete(run);
    });
    activeBatchRuns.add(run);
    return { ...fullJob, collectionId: collection.collectionId };
  });

  app.get("/api/batch/jobs/:jobId", async (request) => {
    const params = request.params as { jobId: string };
    return store.loadBatchJob(params.jobId);
  });

  app.post("/api/batch/jobs/:jobId/cancel", async (request) => {
    const params = request.params as { jobId: string };
    await store.updateBatchJobState(params.jobId, "cancelled");
    return store.loadBatchJob(params.jobId);
  });

  app.post("/api/batch/jobs/:jobId/retry", async (request) => {
    const params = request.params as { jobId: string };
    const resetCount = await store.resetFailedBatchItems(params.jobId);
    if (resetCount === 0) {
      return store.loadBatchJob(params.jobId);
    }
    await store.updateBatchJobState(params.jobId, "queued");
    const job = await store.loadBatchJob(params.jobId);
    void runBatchJob(params.jobId, { skipExisting: true, maxConcurrency: 3 });
    return { ...job, retryCount: resetCount };
  });

  return app;

  async function runBatchJob(jobId: string, options: { skipExisting?: boolean; maxConcurrency?: number }): Promise<void> {
    try {
      if (shuttingDown) return;
      await store.updateBatchJobState(jobId, "running");
      const concurrency = Math.min(Math.max(Math.trunc(options.maxConcurrency ?? 3) || 3, 1), 10);
      const pendingItems = await store.listPendingBatchItems(jobId);
      let cursor = 0;

      const worker = async () => {
        while (cursor < pendingItems.length) {
          if (shuttingDown) return;
          const item = pendingItems[cursor];
          cursor += 1;
          await processBatchItem(item, Boolean(options.skipExisting ?? true));
        }
      };

      await Promise.all(Array.from({ length: Math.min(concurrency, pendingItems.length) }, () => worker()));
      const completed = await store.loadBatchJob(jobId);
      if (completed.state !== "succeeded") {
        await store.updateBatchJobState(jobId, "succeeded");
      }
    } catch (error) {
      await store.updateBatchJobState(jobId, "failed");
      app.log.error(error);
    }
  }

  async function processBatchItem(item: BatchJobItem, skipExisting: boolean): Promise<void> {
    if (shuttingDown) return;
    const lookupUrl = item.normalizedUrl ?? item.url;
    try {
      if (skipExisting) {
        const existing = await store.status(lookupUrl);
        if (existing && existing.state === "parsed") {
          await store.updateBatchItem({
            itemId: item.itemId,
            state: "skipped",
            normalizedUrl: lookupUrl,
            rawdocId: existing.activeRawdocId,
            docId: existing.activeDocId
          });
          return;
        }
      }

      await store.updateBatchItem({ itemId: item.itemId, state: "fetching", incrementAttempt: true });
      const resolved = await resolveKnowledgeCaptureInput({ inputMode: "server_fetch", url: item.url }, effectiveConfig);
      await store.updateBatchItem({ itemId: item.itemId, state: "parsing", normalizedUrl: resolved.normalizedUrl });
      const parsed = await parsePage(resolved);
      const markdown = documentToMarkdown(parsed.document);
      await store.updateBatchItem({ itemId: item.itemId, state: "saving", normalizedUrl: resolved.normalizedUrl });
      await store.save({
        normalizedUrl: resolved.normalizedUrl,
        html: resolved.html,
        rawdoc: parsed.rawdoc,
        document: parsed.document,
        markdown
      });
      await store.updateBatchItem({
        itemId: item.itemId,
        state: "saved",
        normalizedUrl: resolved.normalizedUrl,
        rawdocId: parsed.rawdoc.rawdoc_id,
        docId: parsed.document.doc_id
      });

      // Fix up collection membership when fetch followed a redirect
      // to a URL with a different normalizedUrl (e.g. cross-domain 302).
      // The collection member was inserted with the original URL's itemId,
      // but store.save() wrote to the redirected URL's itemId — leaving a
      // captured-but-empty member in the collection and the saved document
      // as an orphan standalone item.
      const originalNormalized = item.normalizedUrl ?? item.url;
      if (item.collectionId && resolved.normalizedUrl !== originalNormalized) {
        const oldMemberItemId = `url:sha256:${urlHash(originalNormalized)}`;
        const newMemberItemId = `url:sha256:${urlHash(resolved.normalizedUrl)}`;
        await store.updateCollectionMemberItem({
          collectionItemId: item.collectionId,
          oldMemberItemId,
          newMemberItemId
        });
      }
    } catch (error) {
      await store.updateBatchItem({
        itemId: item.itemId,
        state: "failed",
        errorCode: "batch_item_failed",
        errorMessage: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

function resolvedInputFromCapture(rawdoc: RawDoc, html: string): ResolvedInput {
  const metadata = rawdoc.metadata ?? {};
  const normalizedUrl = typeof metadata.normalizedUrl === "string" ? metadata.normalizedUrl : rawdoc.source_uri;
  return {
    inputMode: metadata.inputMode === "server_fetch" ? "server_fetch" : "browser_html",
    url: typeof metadata.canonicalUrl === "string" ? metadata.canonicalUrl : rawdoc.source_uri,
    originalUrl: typeof metadata.originalUrl === "string" ? metadata.originalUrl : rawdoc.source_uri,
    canonicalUrl: typeof metadata.canonicalUrl === "string" ? metadata.canonicalUrl : undefined,
    fetchUrl: typeof metadata.fetchUrl === "string" ? metadata.fetchUrl : undefined,
    normalizedUrl,
    html,
    pageTitle: typeof metadata.pageTitle === "string"
      ? metadata.pageTitle
      : typeof metadata.title === "string"
        ? metadata.title
        : undefined,
    title: typeof metadata.title === "string" ? metadata.title : undefined,
    meta: isStringRecord(metadata.meta) ? metadata.meta : {},
    capturedAt: typeof metadata.capturedAt === "string" ? metadata.capturedAt : rawdoc.fetch_time,
    selectionHtml: typeof metadata.selectionHtml === "string" ? metadata.selectionHtml : undefined
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(
    value &&
      typeof value === "object" &&
      Object.values(value as Record<string, unknown>).every((item) => typeof item === "string")
  );
}

function defaultPathPrefix(pathname: string): string {
  const normalized = pathname.endsWith("/") ? pathname : pathname.slice(0, pathname.lastIndexOf("/") + 1);
  return normalized || "/";
}

function previewPayload(parsed: ParsedPage) {
  return {
    ...parsed,
    markdown: documentToMarkdown(parsed.document),
    candidatePreviews: parsed.candidatePreviews.map((candidate) => ({
      ...candidate,
      markdown: documentToMarkdown(candidate.document)
    }))
  };
}

function parseEpubImportRequest(contentType: string | undefined, body: unknown): {
  file: Buffer;
  sourceUri?: string;
  titleHint?: string;
  tags?: string[];
  metadataOpf?: Buffer;
  cover?: { bytes: Buffer; filename?: string };
} {
  if (Buffer.isBuffer(body)) {
    if (contentType?.toLowerCase().startsWith("multipart/form-data")) {
      return parseMultipartEpub(contentType, body);
    }
    return { file: body };
  }

  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const encoded = typeof record.fileBase64 === "string" ? record.fileBase64 : undefined;
    if (!encoded) {
      throw new Error("fileBase64 is required");
    }
    return {
      file: Buffer.from(encoded, "base64"),
      sourceUri: stringValue(record.sourceUri),
      titleHint: stringValue(record.titleHint),
      tags: stringArray(record.tags),
      metadataOpf: bufferFromStringOrBase64(record.metadataOpf, record.metadataOpfBase64),
      cover: bufferFromBase64(record.coverBase64, stringValue(record.coverFilename))
    };
  }

  throw new Error("EPUB file is required");
}

function parseMultipartEpub(contentType: string, body: Buffer): {
  file: Buffer;
  sourceUri?: string;
  titleHint?: string;
  tags?: string[];
  metadataOpf?: Buffer;
  cover?: { bytes: Buffer; filename?: string };
} {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary) {
    throw new Error("multipart boundary is required");
  }

  const delimiter = `--${boundary}`;
  const raw = body.toString("binary");
  const result: {
    file?: Buffer;
    sourceUri?: string;
    titleHint?: string;
    tags?: string[];
    metadataOpf?: Buffer;
    cover?: { bytes: Buffer; filename?: string };
  } = {};

  for (const part of raw.split(delimiter)) {
    if (!part || part === "--\r\n" || part === "--") {
      continue;
    }
    const trimmed = part.replace(/^\r\n/, "").replace(/\r\n--$/, "");
    const separator = trimmed.indexOf("\r\n\r\n");
    if (separator < 0) {
      continue;
    }
    const headerText = trimmed.slice(0, separator);
    const dataText = trimmed.slice(separator + 4).replace(/\r\n$/, "");
    const name = /name="([^"]+)"/i.exec(headerText)?.[1];
    if (!name) {
      continue;
    }
    if (name === "file") {
      result.file = Buffer.from(dataText, "binary");
      continue;
    }
    if (name === "metadataOpf") {
      result.metadataOpf = Buffer.from(dataText, "binary");
      continue;
    }
    if (name === "cover") {
      result.cover = {
        bytes: Buffer.from(dataText, "binary"),
        filename: multipartFilename(headerText)
      };
      continue;
    }
    const value = Buffer.from(dataText, "binary").toString("utf8").trim();
    if (name === "sourceUri") {
      result.sourceUri = value;
    } else if (name === "titleHint") {
      result.titleHint = value;
    } else if (name === "tags") {
      result.tags = value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
    }
  }

  if (!result.file) {
    throw new Error("multipart field file is required");
  }
  return {
    file: result.file,
    sourceUri: result.sourceUri,
    titleHint: result.titleHint,
    tags: result.tags,
    metadataOpf: result.metadataOpf,
    cover: result.cover
  };
}

function bufferFromStringOrBase64(value: unknown, base64: unknown): Buffer | undefined {
  if (typeof value === "string") {
    return Buffer.from(value, "utf8");
  }
  if (typeof base64 === "string" && base64.trim()) {
    return Buffer.from(base64, "base64");
  }
  return undefined;
}

function bufferFromBase64(base64: unknown, filename?: string): { bytes: Buffer; filename?: string } | undefined {
  if (typeof base64 !== "string" || !base64.trim()) {
    return undefined;
  }
  return {
    bytes: Buffer.from(base64, "base64"),
    filename
  };
}

function multipartFilename(headerText: string): string | undefined {
  return /filename="([^"]+)"/i.exec(headerText)?.[1];
}

function calibreMetadataFromRawdoc(rawdoc: RawDoc): CalibreMetadata | undefined {
  const value = rawdoc.metadata?.calibre;
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return {
    id: stringValue(record.id),
    uuid: stringValue(record.uuid),
    isbn: stringValue(record.isbn),
    douban: stringValue(record.douban),
    title: stringValue(record.title),
    titleSort: stringValue(record.titleSort),
    creators: stringArray(record.creators) ?? [],
    publisher: stringValue(record.publisher),
    publishedAt: stringValue(record.publishedAt),
    language: stringValue(record.language),
    subjects: stringArray(record.subjects) ?? [],
    description: stringValue(record.description),
    pages: numberValue(record.pages),
    wordCount: numberValue(record.wordCount),
    userMetadata: isObjectRecord(record.userMetadata) ? record.userMetadata : undefined
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map(String).map((item) => item.trim()).filter(Boolean);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isAllowedCorsOrigin(origin: string | undefined): boolean {
  if (!origin) {
    return true;
  }
  if (origin.startsWith("chrome-extension://")) {
    return true;
  }

  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1")
    );
  } catch {
    return false;
  }
}

function isClientInputError(message: string): boolean {
  return [
    "server_fetch does not support file://",
    "Expected HTML",
    "candidateId",
    "too large",
    "Timed out fetching",
    "Path escapes knowledge store",
    "Unsafe relative path",
    "unsupported_file_type",
    "pandoc_missing",
    "parse_failed",
    "EPUB file is required",
    "fileBase64 is required",
    "multipart",
    "Knowledge item does not exist",
    "Document does not exist",
    "Asset does not exist",
    "reparse currently supports epub items only",
    "store clear confirmation is required",
    "store parsed-results clear confirmation is required"
  ].some((needle) => message.includes(needle));
}

function isBodyTooLargeError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      (error as { code?: unknown }).code === "FST_ERR_CTP_BODY_TOO_LARGE"
  );
}

function formatBytes(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  if (Number.isInteger(mib)) {
    return `${mib} MiB`;
  }
  return `${bytes} bytes`;
}

async function migrateAnnotationsForReparse(
  store: KnowledgeStore,
  oldDocId: string | undefined,
  document: KnowledgeDocument
): Promise<Record<string, unknown> | null> {
  if (!oldDocId) return null;
  await store.migrateAnnotations(oldDocId, document.doc_id, document);
  return null;
}
