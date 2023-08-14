import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../apps/knowledge-ingest-server/dist/server.js";

const storeRoot = await mkdtemp(join(tmpdir(), "knowledge-retrieval-store-"));

const html = `<!doctype html>
<html lang="en">
  <head>
    <title>Retrieval Smoke Article</title>
  </head>
  <body>
    <article>
      <h1>Retrieval Smoke Article</h1>
      <h2>Chunking</h2>
      <p>Contextual retrieval relies on chunking, citations, and ranking to return grounded evidence.</p>
      <h2>Search</h2>
      <p>SQLite FTS is a practical baseline for local retrieval experiments and parser validation.</p>
    </article>
  </body>
</html>`;

const app = await buildServer({
  host: "127.0.0.1",
  port: 0,
  token: "smoke-token",
  storeRoot,
  fetchTimeoutMs: 5000,
  maxHtmlBytes: 1024 * 1024
});

try {
  const save = await app.inject({
    method: "POST",
    url: "/api/clip/save",
    headers: { authorization: "Bearer smoke-token" },
    payload: {
      inputMode: "browser_html",
      snapshot: {
        pageUrl: "https://example.com/retrieval?utm_source=smoke#top",
        canonicalUrl: "https://example.com/retrieval",
        title: "Retrieval Smoke Article",
        html,
        capturedAt: new Date().toISOString(),
        meta: { author: "Integration Bot" }
      }
    }
  });

  const saved = save.json();
  if (save.statusCode !== 200 || saved.saved !== true) {
    throw new Error(`Expected save to succeed, got ${save.statusCode}: ${save.body}`);
  }

  const search = await app.inject({
    method: "GET",
    url: "/api/search?q=SQLite%20FTS&limit=3",
    headers: { authorization: "Bearer smoke-token" }
  });
  const body = search.json();
  if (search.statusCode !== 200) {
    throw new Error(`Expected search to succeed, got ${search.statusCode}: ${search.body}`);
  }
  if (body.retriever !== "sqlite_fts") {
    throw new Error(`Expected sqlite_fts retriever, got ${JSON.stringify(body)}`);
  }
  if (!Array.isArray(body.results) || body.results.length === 0) {
    throw new Error(`Expected search results, got ${JSON.stringify(body)}`);
  }

  assertIncludes(body.results[0].snippet, "SQLite", "retrieval snippet");
  assertIncludes(body.results[0].title, "Retrieval Smoke Article", "retrieval title");
  console.log("knowledge retrieval smoke passed");
} finally {
  await app.close();
  await rm(storeRoot, { recursive: true, force: true });
}

function assertIncludes(value, needle, label) {
  if (!String(value).includes(needle)) {
    throw new Error(`Expected ${label} to include ${needle}`);
  }
}
