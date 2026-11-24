import { copyFile, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ShardedSearchIndex, type SearchChunkRecord } from "./search-index-store.js";

describe("ShardedSearchIndex", () => {
  let directory: string | undefined;
  let index: ShardedSearchIndex | undefined;

  afterEach(async () => {
    index?.close();
    index = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("reopens a shard after its database file is atomically replaced", async () => {
    directory = await mkdtemp(join(tmpdir(), "knowledge-search-index-test-"));
    index = new ShardedSearchIndex(directory, "default");
    await index.ensure();

    const itemId = "github:sha256:test-item";
    const docId = "doc-1";
    await index.replaceDocument(itemId, docId, [chunk(itemId, docId, "before replacement")]);

    const shardPath = index.shardForItem(itemId).databasePath;
    const replacementPath = `${shardPath}.replacement`;
    await copyFile(shardPath, replacementPath);
    await rename(replacementPath, shardPath);

    await index.replaceDocument(itemId, docId, [chunk(itemId, docId, "after replacement")]);
    const database = index.shardForItem(itemId).database;
    const row = database.prepare("SELECT text FROM chunks WHERE item_id = ? AND doc_id = ?").get(itemId, docId) as
      | { text: string }
      | undefined;

    expect(row?.text).toBe("after replacement");
  });
});

function chunk(itemId: string, docId: string, text: string): SearchChunkRecord {
  return {
    chunk_id: `${docId}:${text}`,
    doc_id: docId,
    item_id: itemId,
    capture_id: "capture-1",
    chunk_index: 0,
    title: "Test title",
    page_title: "Test page",
    source_url: null,
    normalized_url: null,
    source_type: "file",
    category: "default",
    heading_path: null,
    section_ids_json: "[]",
    text,
    token_estimate: 3,
    char_count: text.length,
    parser_version: "test",
    parser_method: "test",
    parser_profile: "test",
    content_hash: "test-hash",
    created_at: "2026-11-24T00:00:00.000Z",
    updated_at: "2026-11-24T00:00:00.000Z"
  };
}
