import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KnowledgeItem } from "@uknowledge/knowledge-schema";
import { KnowledgeStore } from "../store.js";

describe("sync store helpers", () => {
  let root: string;
  let store: KnowledgeStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "knowledge-sync-store-"));
    store = new KnowledgeStore(root);
  });

  afterEach(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  it("merges reading progress with newest updatedAt winning", async () => {
    const item = captureItem();
    await store.importSyncItemMetadata(item);

    await expect(store.mergeReadingProgress(item.itemId, {
      schemaVersion: 1,
      sectionId: "section-1",
      updatedAt: "2026-11-08T10:00:00.000Z",
      revision: 1
    })).resolves.toBe(true);

    await expect(store.mergeReadingProgress(item.itemId, {
      schemaVersion: 1,
      sectionId: "section-older",
      updatedAt: "2026-11-08T09:00:00.000Z",
      revision: 9
    })).resolves.toBe(false);
    expect((await store.loadReadingProgress(item.itemId))?.progress).toMatchObject({
      sectionId: "section-1",
      revision: 1
    });

    await expect(store.mergeReadingProgress(item.itemId, {
      schemaVersion: 1,
      sectionId: "section-2",
      updatedAt: "2026-11-08T11:00:00.000Z",
      revision: 2
    })).resolves.toBe(true);
    expect((await store.loadReadingProgress(item.itemId))?.progress).toMatchObject({
      sectionId: "section-2",
      revision: 2
    });
    expect((await store.loadItem(item.itemId))?.updatedAt).toBe(item.updatedAt);
  });
});

function captureItem(): KnowledgeItem {
  return {
    itemId: "url:sha256:sync-store-fixture",
    sourceType: "url",
    identityHash: "sync-store-fixture",
    activeRawdocId: "capture-1",
    activeDocId: "doc-1",
    normalizedUrl: "https://example.com/sync-store-fixture",
    title: "Sync store fixture",
    creators: [],
    tags: ["sync"],
    owner: "xiaojing",
    state: "parsed",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-08T08:00:00.000Z",
    parsedAt: "2026-11-01T00:00:00.000Z"
  };
}
