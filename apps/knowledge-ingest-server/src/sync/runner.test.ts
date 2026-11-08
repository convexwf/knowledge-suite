import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KnowledgeDocument, RawDoc } from "@uknowledge/knowledge-schema";
import { buildServer } from "../server.js";
import { KnowledgeStore } from "../store.js";

const TOKEN = "sync-test-token";
const ITEM_URL = "https://example.com/synced-article";

describe("knowledge store sync runner", () => {
  let sourceRoot: string;
  let destinationRoot: string;
  let sourceApp: FastifyInstance | undefined;
  let destinationApp: FastifyInstance | undefined;

  beforeEach(async () => {
    sourceRoot = await mkdtemp(join(tmpdir(), "knowledge-sync-source-"));
    destinationRoot = await mkdtemp(join(tmpdir(), "knowledge-sync-destination-"));
  });

  afterEach(async () => {
    await destinationApp?.close();
    await sourceApp?.close();
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(destinationRoot, { recursive: true, force: true });
  });

  it("pulls packages, rawdocs, metadata, annotations, progress, and collections", async () => {
    const seeded = await seedSource(sourceRoot);
    sourceApp = await buildServer({
      host: "127.0.0.1",
      port: 0,
      token: TOKEN,
      storeRoot: sourceRoot,
      fetchTimeoutMs: 2000,
      maxHtmlBytes: 1024 * 1024
    });
    await sourceApp.listen({ host: "127.0.0.1", port: 0 });
    const sourcePort = (sourceApp.server.address() as AddressInfo).port;

    destinationApp = await buildServer({
      host: "127.0.0.1",
      port: 0,
      token: TOKEN,
      storeRoot: destinationRoot,
      fetchTimeoutMs: 2000,
      maxHtmlBytes: 1024 * 1024,
      sync: {
        enabled: true,
        sourceUrl: `http://127.0.0.1:${sourcePort}`,
        sourceToken: TOKEN,
        at: "19:00"
      }
    });

    const run = await destinationApp.inject({
      method: "POST",
      url: "/api/sync/run",
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({
      status: "ok",
      catalogItems: 1,
      packagesUpdated: 1,
      packagesUnchanged: 0,
      annotations: 1,
      readingProgress: 1,
      collections: 1,
      collectionMembers: 1,
      failedItems: 0,
      errors: []
    });

    const sourceCatalog = await sourceApp.inject({
      method: "GET",
      url: "/api/sync/catalog",
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    const destinationCatalog = await destinationApp.inject({
      method: "GET",
      url: "/api/sync/catalog",
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(destinationCatalog.json().items[0].contentHash)
      .toBe(sourceCatalog.json().items[0].contentHash);

    const detail = await destinationApp.inject({
      method: "GET",
      url: `/api/items/${encodeURIComponent(seeded.itemId)}`,
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(detail.json()).toMatchObject({
      item: {
        itemId: seeded.itemId,
        owner: "xiaojing",
        tags: ["sync", "fixture"],
        activeDocId: seeded.docId,
        activeRawdocId: seeded.rawdocId
      },
      rawdoc: { rawdoc_id: seeded.rawdocId },
      document: { doc_id: seeded.docId }
    });

    const annotations = await destinationApp.inject({
      method: "GET",
      url: `/api/items/${encodeURIComponent(seeded.itemId)}/annotations`,
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(annotations.json().annotations).toEqual([
      expect.objectContaining({
        annotation_id: "annotation-1",
        section_id: "para-1",
        type: "highlight"
      })
    ]);

    const progress = await destinationApp.inject({
      method: "GET",
      url: `/api/items/${encodeURIComponent(seeded.itemId)}/reading-progress`,
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(progress.json().progress).toMatchObject({ sectionId: "para-2", revision: 1 });

    const collection = await destinationApp.inject({
      method: "GET",
      url: `/api/collections/${encodeURIComponent(seeded.collectionId)}`,
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(collection.json()).toMatchObject({
      collection: { collectionId: seeded.collectionId, title: "Synced collection", itemCount: 1 },
      items: [{ itemId: seeded.itemId, orderIndex: 0, depth: 0 }]
    });

    const rawdoc = await destinationApp.inject({
      method: "GET",
      url: `/api/sync/items/${encodeURIComponent(seeded.itemId)}/rawdoc`,
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(rawdoc.statusCode).toBe(200);
    expect(rawdoc.headers["x-content-ext"]).toBe("html");
    expect(rawdoc.body).toContain("Synced article body");

    const secondRun = await destinationApp.inject({
      method: "POST",
      url: "/api/sync/run",
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(secondRun.json()).toMatchObject({
      status: "ok",
      packagesUpdated: 0,
      packagesUnchanged: 1
    });
  });
});

async function seedSource(root: string): Promise<{
  itemId: string;
  docId: string;
  rawdocId: string;
  collectionId: string;
}> {
  const store = new KnowledgeStore(root);
  const docId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const rawdocId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const collectionId = "col:sha256:sync-fixture";
  const html = `<!doctype html>
<html lang="en"><head><title>Synced article - Example</title></head>
<body><article><h1>Synced article</h1><p>Synced article body for the package.</p></article></body></html>`;
  const document: KnowledgeDocument = {
    doc_id: docId,
    meta: {
      title: "Synced article",
      page_title: "Synced article - Example",
      tags: ["sync", "fixture"],
      source: { type: "html", url: ITEM_URL, rawdoc_id: rawdocId },
      authors: ["Ada"],
      ingested_at: "2026-11-08T00:00:00.000Z",
      parser_version: "knowledge-ingest-server/0.1:defuddle"
    },
    sections: [
      { section_id: "para-1", type: "paragraph", content: "Synced article body for the package." },
      { section_id: "para-2", type: "paragraph", content: "Second section for reading progress." }
    ]
  };
  const rawdoc: RawDoc = {
    rawdoc_id: rawdocId,
    source_type: "url",
    source_uri: ITEM_URL,
    fetch_time: "2026-11-08T00:00:00.000Z",
    content_type: "text/html",
    content_length: Buffer.byteLength(html)
  };
  await store.save({
    normalizedUrl: ITEM_URL,
    html,
    rawdoc,
    document,
    markdown: "# Synced article\n\nSynced article body for the package.\n",
    owner: "xiaojing"
  });
  const item = await store.status(ITEM_URL);
  if (!item) throw new Error("source item was not saved");
  await store.updateReadingProgress(item.itemId, "para-2", 0);
  await store.saveAnnotation(docId, {
    annotation_id: "annotation-1",
    doc_id: docId,
    section_id: "para-1",
    type: "highlight",
    text_ref: "Synced article body",
    note: "keep this",
    created_at: "2026-11-08T00:00:00.000Z",
    updated_at: "2026-11-08T00:00:00.000Z"
  });
  await store.upsertCollection({
    collectionId,
    title: "Synced collection",
    sourceType: "virtual_collection"
  });
  await store.replaceCollectionMembers(collectionId, [{
    memberItemId: item.itemId,
    orderIndex: 0,
    depth: 0,
    inclusionMode: "manual",
    inclusionReason: "fixture"
  }]);
  store.close();
  return { itemId: item.itemId, docId, rawdocId, collectionId };
}
