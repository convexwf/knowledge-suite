import cors from "@fastify/cors";
import fastify from "fastify";
import {
  ClipInputSchema,
  ClipSaveRequestSchema
} from "@uknowledge/knowledge-schema";
import { loadConfig, ServerConfig } from "./config.js";
import { resolveClipInput } from "./input.js";
import { documentToMarkdown } from "./markdown.js";
import { parsePage } from "./parser.js";
import { KnowledgeStore } from "./store.js";

export async function buildServer(config: ServerConfig = loadConfig()) {
  const app = fastify({ logger: true });
  const store = new KnowledgeStore(config.storeRoot);
  await store.ensure();

  await app.register(cors, {
    origin: true
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
    storeRoot: config.storeRoot
  }));

  app.get("/api/clip/status", async (request) => {
    const query = request.query as { url?: string };
    if (!query.url) {
      throw new Error("url is required");
    }
    return store.status(query.url);
  });

  app.post("/api/clip/preview", async (request) => {
    const input = ClipInputSchema.parse(request.body);
    const resolved = await resolveClipInput(input);
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
    const resolved = await resolveClipInput(input);
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

  return app;
}
