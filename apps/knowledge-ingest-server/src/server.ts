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
  RawDoc
} from "@uknowledge/knowledge-schema";
import { loadConfig, ServerConfig } from "./config.js";
import { ResolvedInput, resolveClipInput } from "./input.js";
import { documentToMarkdown } from "./markdown.js";
import { parsePage, type ParsedPage } from "./parser.js";
import { KnowledgeStore } from "./store.js";

export async function buildServer(config: ServerConfig = loadConfig()) {
  const app = fastify({
    logger: true,
    bodyLimit: config.maxHtmlBytes
  });
  const store = new KnowledgeStore(config.storeRoot);
  await store.ensure();

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
      maxHtmlBytes: config.maxHtmlBytes
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
        parserMethod: query.parserMethod
      })
    };
  });

  app.delete("/api/clip", async (request) => {
    const query = request.query as { url?: string; mode?: "purge" | "remove" };
    if (!query.url) {
      throw new Error("url is required");
    }
    return store.deleteByUrl(query.url, query.mode === "purge" ? "purge" : "remove");
  });

  app.post("/api/clip/preview", async (request) => {
    const input = ClipInputSchema.parse(request.body);
    const resolved = await resolveClipInput(input, config);
    const parsed = await parsePage(resolved);
    const status = await store.status(resolved.normalizedUrl);
    return {
      ...previewPayload(parsed),
      status
    };
  });

  app.post("/api/clip/save", async (request) => {
    const input = ClipSaveRequestSchema.parse(request.body);
    const resolved = await resolveClipInput(input, config);
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
      const resolved = await resolveClipInput({ inputMode: "server_fetch", url: item.url }, config);
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
    "Unsafe relative path"
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
