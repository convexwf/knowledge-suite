import { describe, expect, it } from "vitest";

import { buildReaderListEntries, normalizeSourceFilter, normalizeStructureFilter } from "../src/items-model.js";
import { CollectionSummary, KnowledgeItem } from "../src/types.js";

const sampleCollections: CollectionSummary[] = [
  {
    collectionId: "col-1",
    title: "LangGraph Docs",
    rootUrl: "https://example.com/docs",
    sourceType: "url",
    state: "active",
    itemCount: 3,
    createdAt: "2026-06-18T09:00:00.000Z",
    updatedAt: "2026-06-18T10:00:00.000Z"
  }
];

const sampleItems: KnowledgeItem[] = [
  {
    itemId: "standalone-1",
    sourceType: "epub",
    identityHash: "a",
    activeRawdocId: "raw-a",
    activeDocId: "doc-a",
    title: "Standalone EPUB",
    creators: ["Author A"],
    tags: [],
    state: "parsed",
    createdAt: "2026-06-18T08:00:00.000Z",
    updatedAt: "2026-06-18T11:00:00.000Z",
    collectionIds: []
  },
  {
    itemId: "collection-member",
    sourceType: "url",
    identityHash: "b",
    activeRawdocId: "raw-b",
    activeDocId: "doc-b",
    title: "Collection Member",
    creators: ["Author B"],
    tags: [],
    state: "parsed",
    createdAt: "2026-06-18T08:10:00.000Z",
    updatedAt: "2026-06-18T09:30:00.000Z",
    collectionIds: ["col-1"]
  }
];

describe("items model", () => {
  it("keeps collection members out of top-level standalone entries", () => {
    const entries = buildReaderListEntries({
      items: sampleItems,
      collections: sampleCollections,
      structureFilter: "all",
      sourceFilter: "all"
    });

    expect(entries).toHaveLength(2);
    expect(entries.find((entry) => entry.kind === "standalone")?.itemId).toBe("standalone-1");
    expect(entries.find((entry) => entry.kind === "collection")?.collectionId).toBe("col-1");
  });

  it("filters standalone and collection views independently", () => {
    const collectionOnly = buildReaderListEntries({
      items: sampleItems,
      collections: sampleCollections,
      structureFilter: "collections",
      sourceFilter: "all"
    });
    const standaloneOnly = buildReaderListEntries({
      items: sampleItems,
      collections: sampleCollections,
      structureFilter: "standalone",
      sourceFilter: "all"
    });

    expect(collectionOnly.map((entry) => entry.kind)).toEqual(["collection"]);
    expect(standaloneOnly.map((entry) => entry.kind)).toEqual(["standalone"]);
  });

  it("applies source filtering to both top-level object types", () => {
    const webEntries = buildReaderListEntries({
      items: sampleItems,
      collections: sampleCollections,
      structureFilter: "all",
      sourceFilter: "url"
    });
    const epubEntries = buildReaderListEntries({
      items: sampleItems,
      collections: sampleCollections,
      structureFilter: "all",
      sourceFilter: "epub"
    });

    expect(webEntries.map((entry) => entry.kind)).toEqual(["collection"]);
    expect(epubEntries.map((entry) => entry.kind)).toEqual(["standalone"]);
  });

  it("normalizes query-driven filters safely", () => {
    expect(normalizeStructureFilter("collections")).toBe("collections");
    expect(normalizeStructureFilter("weird")).toBe("all");
    expect(normalizeSourceFilter("pdf")).toBe("pdf");
    expect(normalizeSourceFilter("strange")).toBe("all");
  });
});
