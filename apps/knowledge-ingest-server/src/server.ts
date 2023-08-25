import cors from "@fastify/cors";
import fastify from "fastify";
import {
  BatchDiscoverRequestSchema,
  BatchJobCreateRequestSchema,
  BatchJobItem,
  ClipInputSchema,
  ClipReparseRequestSchema,
  ClipSaveRequestSchema,
  normalizeUrlForKnowledge,
  RawDoc,
  EpubImportResponse,
  StoreClearParsedRequestSchema,
  StoreClearRequestSchema
} from "@uknowledge/knowledge-schema";
import { loadConfig, ServerConfig } from "./config.js";
import { parseEpub, type PandocRunner } from "./epub.js";
import { ResolvedInput, resolveClipInput } from "./input.js";
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
  await store.ensure();

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

  app.get("/api/clip/status", async (request) => {
    const query = request.query as { url?: string };
    if (!query.url) {
      throw new Error("url is required");
    }
    return store.status(query.url);
  });

  app.get("/api/clips", async (request) => {
    const query = request.query as { limit?: string };
    return {
      clips: await store.list(query.limit ? Number(query.limit) : undefined)
    };
  });

  app.get("/api/items", async (request) => {
    const query = request.query as { sourceType?: string; limit?: string };
    return {
      items: await store.listItems({
        sourceType: query.sourceType,
        limit: query.limit ? Number(query.limit) : undefined
      })
    };
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

  app.get("/api/assets/:assetId", async (request, reply) => {
    const params = request.params as { assetId: string };
    const asset = await store.loadAsset(params.assetId);
    await reply.type(asset.contentType).send(asset.bytes);
  });

  app.get("/api/collections", async (request) => {
    const query = request.query as { limit?: string };
    return {
      collections: await store.listCollections(query.limit ? Number(query.limit) : undefined)
    };
  });

  app.get("/api/collections/:collectionId", async (request) => {
    const params = request.params as { collectionId: string };
    return store.loadCollection(params.collectionId);
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

  app.delete("/api/clip", async (request) => {
    const query = request.query as { url?: string; mode?: "purge" | "remove" };
    if (!query.url) {
      throw new Error("url is required");
    }
    return store.deleteByUrl(query.url, query.mode === "purge" ? "purge" : "remove");
  });

  app.post("/api/clip/preview", { bodyLimit: config.maxHtmlBytes }, async (request) => {
    const input = ClipInputSchema.parse(request.body);
    const resolved = await resolveClipInput(input, effectiveConfig);
    const parsed = await parsePage(resolved);
    const status = await store.status(resolved.normalizedUrl);
    return {
      ...previewPayload(parsed),
      status
    };
  });

  app.post("/api/clip/save", { bodyLimit: config.maxHtmlBytes }, async (request) => {
    const input = ClipSaveRequestSchema.parse(request.body);
    const resolved = await resolveClipInput(input, effectiveConfig);
    const parsed = await parsePage(resolved, { selectedCandidateId: input.candidateId });
    const markdown = documentToMarkdown(parsed.document);
    const paths = await store.save({
      normalizedUrl: resolved.normalizedUrl,
      html: resolved.html,
      rawdoc: parsed.rawdoc,
      document: parsed.document,
      markdown
    });
    const status = await store.status(resolved.normalizedUrl);
    return {
      ...previewPayload(parsed),
      status,
      saved: true,
      paths
    };
  });

  app.post("/api/clip/reparse", async (request) => {
    const input = ClipReparseRequestSchema.parse(request.body);
    const capture = await store.loadCaptureByUrl(input.url);
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
    const status = await store.status(resolved.normalizedUrl);
    return {
      ...previewPayload(parsed),
      status,
      saved: true,
      paths
    };
  });

  app.post("/api/import/epub", async (request): Promise<EpubImportResponse> => {
    const input = parseEpubImportRequest(request.headers["content-type"], request.body);
    const parsed = await parseEpub(input.file, {
      sourceUri: input.sourceUri,
      titleHint: input.titleHint,
      tags: input.tags,
      pandocRunner: config.epubPandocRunner
    });
    try {
      const documentWithAssets = await store.prepareDocumentAssets(parsed.document);
      const markdown = documentToMarkdown(documentWithAssets);
      const paths = await store.saveImportItem({
        itemId: parsed.itemId,
        identityHash: parsed.identityHash,
        rawContent: input.file,
        rawdoc: parsed.rawdoc,
        document: documentWithAssets,
        markdown,
        contentExt: "epub"
      });
      const knowledgeItem = await store.loadItem(parsed.itemId);
      return {
        knowledgeItem,
        rawdoc: parsed.rawdoc,
        document: documentWithAssets,
        markdown,
        saved: true,
        paths
      };
    } finally {
      await parsed.cleanup();
    }
  });

  app.post("/api/items/:itemId/reparse", async (request): Promise<EpubImportResponse> => {
    const params = request.params as { itemId: string };
    const capture = await store.loadRawContentForItem(params.itemId);
    if (capture.rawdoc.source_type !== "epub") {
      throw new Error("reparse currently supports epub items only");
    }
    const parsed = await parseEpub(capture.content, {
      rawdocId: capture.rawdoc.rawdoc_id,
      sourceUri: capture.rawdoc.source_uri,
      pandocRunner: config.epubPandocRunner
    });
    try {
      const documentWithAssets = await store.prepareDocumentAssets(parsed.document);
      const markdown = documentToMarkdown(documentWithAssets);
      const rawdoc = {
        ...parsed.rawdoc,
        metadata: {
          ...parsed.rawdoc.metadata,
          reparsedFromItemId: capture.item.itemId
        }
      };
      const paths = await store.saveImportItem({
        itemId: capture.item.itemId,
        identityHash: capture.item.identityHash,
        rawContent: capture.content,
        rawdoc,
        document: documentWithAssets,
        markdown,
        contentExt: capture.contentExt
      });
      const knowledgeItem = await store.loadItem(capture.item.itemId);
      return {
        knowledgeItem,
        rawdoc,
        document: documentWithAssets,
        markdown,
        saved: true,
        paths
      };
    } finally {
      await parsed.cleanup();
    }
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
      const normalizedUrl = normalizeUrlForKnowledge(url.toString());
      if (seen.has(normalizedUrl)) {
        continue;
      }
      seen.add(normalizedUrl);
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
        status: status.state,
        docId: status.docId,
        rawdocId: status.rawdocId
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
      sourceType: "manual_section",
      state: "draft"
    });
    await store.replaceCollectionItems(collection.collectionId, items.map((item, index) => ({
      normalizedUrl: item.normalizedUrl,
      title: item.titleHint,
      source: item.source,
      orderIndex: index,
      depth: item.depth,
      state: "pending"
    })));
    const job = await store.createBatchJob({
      collectionId: collection.collectionId,
      sourcePageUrl: input.sourcePageUrl,
      mode: input.mode,
      options: input.options,
      items: items.map((item) => ({
        url: item.url,
        normalizedUrl: item.normalizedUrl,
        source: item.source,
        titleHint: item.titleHint
      }))
    });

    void runBatchJob(job.jobId, input.options ?? {});
    return job;
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

  return app;

  async function runBatchJob(jobId: string, options: { skipExisting?: boolean; maxConcurrency?: number }): Promise<void> {
    try {
      await store.updateBatchJobState(jobId, "running");
      const concurrency = Math.min(Math.max(Math.trunc(options.maxConcurrency ?? 3) || 3, 1), 10);
      const pendingItems = await store.listPendingBatchItems(jobId);
      let cursor = 0;

      const worker = async () => {
        while (cursor < pendingItems.length) {
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
    const lookupUrl = item.normalizedUrl ?? item.url;
    try {
      if (skipExisting) {
        const existing = await store.status(lookupUrl);
        if (existing.state === "parsed") {
          await store.updateBatchItem({
            itemId: item.itemId,
            state: "skipped",
            normalizedUrl: existing.normalizedUrl,
            rawdocId: existing.rawdocId,
            docId: existing.docId,
            title: existing.contentTitle ?? existing.title,
            pageTitle: existing.pageTitle
          });
          return;
        }
      }

      await store.updateBatchItem({ itemId: item.itemId, state: "fetching", incrementAttempt: true });
      const resolved = await resolveClipInput({ inputMode: "server_fetch", url: item.url }, effectiveConfig);
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
        docId: parsed.document.doc_id,
        title: parsed.document.meta.title,
        pageTitle: parsed.document.meta.page_title
      });
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
      tags: stringArray(record.tags)
    };
  }

  throw new Error("EPUB file is required");
}

function parseMultipartEpub(contentType: string, body: Buffer): {
  file: Buffer;
  sourceUri?: string;
  titleHint?: string;
  tags?: string[];
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
    tags: result.tags
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
