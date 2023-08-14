import cors from "@fastify/cors";
import fastify from "fastify";
import {
  ClipInputSchema,
  ClipReparseRequestSchema,
  ClipSaveRequestSchema,
  RawDoc
} from "@uknowledge/knowledge-schema";
import { loadConfig, ServerConfig } from "./config.js";
import { ResolvedInput, resolveClipInput } from "./input.js";
import { documentToMarkdown } from "./markdown.js";
import { parsePage } from "./parser.js";
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
    const markdown = documentToMarkdown(parsed.document);
    const status = await store.status(resolved.normalizedUrl);
    return {
      ...parsed,
      markdown,
      status
    };
  });

  app.post("/api/clip/save", async (request) => {
    const input = ClipSaveRequestSchema.parse(request.body);
    const resolved = await resolveClipInput(input, config);
    const parsed = await parsePage(resolved);
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
      ...parsed,
      markdown,
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
      ...parsed,
      markdown,
      status,
      saved: true,
      paths
    };
  });

  return app;
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
