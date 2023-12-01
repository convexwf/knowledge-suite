import { DatabaseSync } from "node:sqlite";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KnowledgeDocument, RawDoc } from "@uknowledge/knowledge-schema";
import { KnowledgeStore } from "./store.js";

describe("KnowledgeStore", () => {
  let storeRoot: string;

  beforeEach(async () => {
    storeRoot = await mkdtemp(join(tmpdir(), "knowledge-store-test-"));
  });

  afterEach(async () => {
    await rm(storeRoot, { recursive: true, force: true });
  });

  it("stores UUID-named objects and points a URL to the newest parsed result", async () => {
    const store = new KnowledgeStore(storeRoot);
    const first = fixture("11111111-1111-4111-8111-111111111111", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "First Title");
    const second = fixture(
      "22222222-2222-4222-8222-222222222222",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "Second Title",
      "Second Title - Example Site"
    );

    const firstPaths = await store.save(first);
    expectStoreSchema(storeRoot);
    expect(firstPaths).toEqual({
      rawHtmlPath: "rawdocs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.html",
      rawdocPath: "rawdocs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json",
      documentPath: "documents/11111111-1111-4111-8111-111111111111.json",
      markdownPath: "markdown/11111111-1111-4111-8111-111111111111.md"
    });
    await expect(access(join(storeRoot, firstPaths.documentPath))).resolves.toBeUndefined();
    const rawdocJson = JSON.parse(await readFile(join(storeRoot, firstPaths.rawdocPath), "utf8"));
    const documentJson = JSON.parse(await readFile(join(storeRoot, firstPaths.documentPath), "utf8"));
    expect(rawdocJson).not.toHaveProperty("storage_path");
    expect(documentJson.meta.source).not.toHaveProperty("path");

    const secondPaths = await store.save(second);
    expect(tableCount(storeRoot, "items")).toBe(1);
    expect(tableCount(storeRoot, "documents")).toBe(1);
    expect(tableCount(storeRoot, "rawdocs")).toBe(1);
    expect(tableCount(storeRoot, "chunks")).toBeGreaterThan(0);
    await expect(access(join(storeRoot, firstPaths.documentPath))).rejects.toThrow();
    await expect(access(join(storeRoot, firstPaths.markdownPath))).rejects.toThrow();
    await expect(access(join(storeRoot, firstPaths.rawHtmlPath))).rejects.toThrow();
    await expect(access(join(storeRoot, firstPaths.rawdocPath))).rejects.toThrow();
    await expect(access(join(storeRoot, secondPaths.documentPath))).resolves.toBeUndefined();

    const status = await store.status("https://example.com/article?utm_source=x");
    expect(status).toMatchObject({
      itemId: expect.stringMatching(/^url:sha256:/),
      sourceType: "url",
      normalizedUrl: "https://example.com/article",
      state: "parsed",
      title: "Second Title - Example Site",
      pageTitle: "Second Title - Example Site",
      contentTitle: "Second Title",
      displayTitle: "Second Title - Example Site",
      activeDocId: second.document.doc_id,
      activeRawdocId: second.rawdoc.rawdoc_id
    });
    expect(status.createdAt).toEqual(expect.any(String));
    expect(status.updatedAt).toEqual(expect.any(String));
    expect(status.parsedAt).toEqual(expect.any(String));

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      itemId: expect.stringMatching(/^url:sha256:/),
      sourceType: "url",
      normalizedUrl: "https://example.com/article",
      state: "parsed",
      title: "Second Title - Example Site",
      pageTitle: "Second Title - Example Site",
      contentTitle: "Second Title",
      displayTitle: "Second Title - Example Site",
      activeDocId: second.document.doc_id,
      activeRawdocId: second.rawdoc.rawdoc_id
    });

    store.close();
  });

  it("remove deletes only derived artifacts and keeps the raw capture for reparse", async () => {
    const store = new KnowledgeStore(storeRoot);
    const clip = fixture("33333333-3333-4333-8333-333333333333", "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "Captured Title");

    const paths = await store.save(clip);
    expect(tableCount(storeRoot, "items")).toBe(1);
    expect(tableCount(storeRoot, "documents")).toBe(1);
    expect(tableCount(storeRoot, "rawdocs")).toBe(1);
    expect(tableCount(storeRoot, "chunks")).toBeGreaterThan(0);

    const result = await store.deleteByUrl(clip.normalizedUrl, "remove");

    expect(result).toMatchObject({
      deleted: true,
      mode: "remove",
      previousState: "parsed",
      currentState: "captured",
      removedDocId: clip.document.doc_id
    });
    expect(result.deletedFiles).toEqual(
      expect.arrayContaining([paths.documentPath, paths.markdownPath])
    );
    expect(tableCount(storeRoot, "items")).toBe(1);
    expect(tableCount(storeRoot, "documents")).toBe(0);
    expect(tableCount(storeRoot, "rawdocs")).toBe(1);
    expect(tableCount(storeRoot, "chunks")).toBe(0);
    await expect(access(join(storeRoot, paths.documentPath))).rejects.toThrow();
    await expect(access(join(storeRoot, paths.markdownPath))).rejects.toThrow();
    await expect(access(join(storeRoot, paths.rawHtmlPath))).resolves.toBeUndefined();
    await expect(access(join(storeRoot, paths.rawdocPath))).resolves.toBeUndefined();

    const status = await store.status(clip.normalizedUrl);
    expect(status).toMatchObject({
      itemId: expect.stringMatching(/^url:sha256:/),
      state: "captured",
      activeRawdocId: clip.rawdoc.rawdoc_id
    });
    expect(status?.activeDocId).toBeUndefined();
    expect(status?.parsedAt).toBeUndefined();

    const capture = await store.loadCaptureByUrl(clip.normalizedUrl);
    expect(capture.html).toContain("Captured Title");
    expect(capture.rawdoc.rawdoc_id).toBe(clip.rawdoc.rawdoc_id);

    store.close();
  });

  it("purge deletes item rows, capture rows, and all capture files", async () => {
    const store = new KnowledgeStore(storeRoot);
    const clip = fixture("44444444-4444-4444-8444-444444444444", "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "Purge Title");
    const paths = await store.save(clip);

    const removed = await store.deleteByUrl(clip.normalizedUrl, "remove");
    expect(removed.currentState).toBe("captured");

    const purged = await store.deleteByUrl(clip.normalizedUrl, "purge");

    expect(purged).toMatchObject({
      deleted: true,
      mode: "purge",
      previousState: "captured",
      currentState: "empty",
      removedRawdocId: clip.rawdoc.rawdoc_id
    });
    expect(purged.deletedFiles).toEqual([
      paths.rawHtmlPath,
      paths.rawdocPath
    ]);
    expect(tableCount(storeRoot, "items")).toBe(0);
    expect(tableCount(storeRoot, "documents")).toBe(0);
    expect(tableCount(storeRoot, "rawdocs")).toBe(0);
    expect(tableCount(storeRoot, "chunks")).toBe(0);
    await expect(access(join(storeRoot, paths.rawHtmlPath))).rejects.toThrow();
    await expect(access(join(storeRoot, paths.rawdocPath))).rejects.toThrow();

    store.close();
  });

  it("purge deletes imported EPUB assets with derived artifacts", async () => {
    const store = new KnowledgeStore(storeRoot);
    const coverPath = join(storeRoot, "cover.jpg");
    await writeFile(coverPath, "cover bytes");

    const rawdoc: RawDoc = {
      rawdoc_id: "55555555-5555-4555-8555-555555555555",
      source_type: "epub",
      source_uri: "file:///books/example.epub",
      fetch_time: "2026-05-12T00:00:00.000Z",
      content_type: "application/epub+zip",
      content_length: 10,
      metadata: {
        parserMethod: "pandoc_epub",
        parserProfile: "epub"
      }
    };
    const document: KnowledgeDocument = {
      doc_id: "66666666-6666-4666-8666-666666666666",
      meta: {
        title: "Imported EPUB",
        source: {
          type: "epub",
          url: rawdoc.source_uri,
          rawdoc_id: rawdoc.rawdoc_id
        },
        authors: ["Ada"],
        ingested_at: "2026-05-12T00:00:00.000Z",
        parser_version: "knowledge-ingest-server/epub-0.1:pandoc_epub"
      },
      sections: [
        {
          section_id: "cover",
          type: "figure",
          assets: [{ path: coverPath, caption: "Cover" }]
        },
        {
          section_id: "body",
          type: "paragraph",
          content: "Imported EPUB content."
        }
      ]
    };

    const documentWithAssets = await store.prepareDocumentAssets(document);
    const assetPath = documentWithAssets.sections[0].assets?.[0].path;
    expect(assetPath).toMatch(/^assets\/[a-f0-9]+\.jpg$/);
    expect(documentWithAssets.meta.cover_asset_id).toBe(documentWithAssets.sections[0].assets?.[0].asset_id);
    expect(documentWithAssets.meta.statistics).toMatchObject({
      sectionCount: 2,
      figureCount: 1,
      imageCount: 1,
      assetCount: 1,
      paragraphCount: 1
    });
    await store.saveImportItem({
      itemId: "epub:sha256:555555",
      sourceType: "epub",
      sourceUri: rawdoc.source_uri,
      rawdocId: rawdoc.rawdoc_id,
      identityHash: "555555",
      rawContentPath: "rawdocs/55555555-5555-4555-8555-555555555555.epub",
      content: Buffer.from("epub bytes"),
      rawdoc,
      document: documentWithAssets,
      markdown: "# Imported EPUB\n\n![Cover](" + assetPath + ")\n",
      contentExt: "epub",
      epubMetadata: { title: "Imported EPUB", coverAssetId: documentWithAssets.sections[0].assets?.[0].asset_id }
    });
    await expect(access(join(storeRoot, assetPath!))).resolves.toBeUndefined();

    const purged = await store.deleteItem("epub:sha256:555555", "purge");

    await expect(access(join(storeRoot, assetPath!))).rejects.toThrow();
    expect(tableCount(storeRoot, "items")).toBe(0);
    expect(tableCount(storeRoot, "epub_metadata")).toBe(0);

    store.close();
  });

  it("scans and clears the whole local store", async () => {
    const store = new KnowledgeStore(storeRoot);
    const clip = fixture("77777777-7777-4777-8777-777777777777", "77777777-aaaa-4aaa-8aaa-777777777777", "Clear Title");
    const paths = await store.save(clip);

    const scan = await store.scanMaintenance();
    expect(scan.totals.rows).toBeGreaterThanOrEqual(4);
    expect(scan.totals.contentFiles).toBe(4);
    expect(scan.tables.webItems).toBe(1);
    expect(scan.tables.rawdocs).toBe(1);
    expect(scan.tables.documents).toBe(1);
    expect(scan.tables.chunks).toBeGreaterThan(0);
    expect(scan.files).toMatchObject({
      rawdocs: 2,
      documents: 1,
      markdown: 1
    });

    const cleared = await store.clearAll();
    expect(cleared.cleared).toBe(true);
    expect(cleared.before.totals.contentFiles).toBe(4);
    expect(cleared.after.totals.rows).toBe(0);
    expect(cleared.after.totals.contentFiles).toBe(0);
    expect(tableCount(storeRoot, "items")).toBe(0);
    expect(tableCount(storeRoot, "rawdocs")).toBe(0);
    expect(tableCount(storeRoot, "documents")).toBe(0);
    expect(tableCount(storeRoot, "chunks")).toBe(0);
    await expect(access(join(storeRoot, paths.rawHtmlPath))).rejects.toThrow();
    await expect(access(join(storeRoot, paths.rawdocPath))).rejects.toThrow();
    await expect(access(join(storeRoot, paths.documentPath))).rejects.toThrow();
    await expect(access(join(storeRoot, paths.markdownPath))).rejects.toThrow();
    await expect(store.status(clip.normalizedUrl)).resolves.toBeNull();

    store.close();
  });

  it("clears parsed results while preserving raw captures", async () => {
    const store = new KnowledgeStore(storeRoot);
    const clip = fixture("12121212-1212-4212-8212-121212121212", "12121212-aaaa-4aaa-8aaa-121212121212", "Parsed Clear Title");
    const paths = await store.save(clip);

    const scan = await store.scanMaintenance();
    expect(scan.parsedResults).toMatchObject({
      parsedWebItems: 1,
      documentRows: 1,
      derivedFiles: 2
    });
    expect(scan.parsedResults.chunkRows).toBeGreaterThan(0);

    const cleared = await store.clearParsedResults();

    expect(cleared).toMatchObject({
      cleared: true,
      mode: "parsed",
      before: {
        parsedResults: {
          parsedWebItems: 1,
          documentRows: 1
        }
      },
      after: {
        tables: {
          webItems: 1,
          rawdocs: 1,
          documents: 0,
          chunks: 0
        },
        files: {
          rawdocs: 2,
          documents: 0,
          markdown: 0,
          assets: 0,
          totalContentFiles: 2
        },
        parsedResults: {
          parsedWebItems: 0,
          documentRows: 0,
          chunkRows: 0,
          derivedFiles: 0
        }
      }
    });
    expect(tableCount(storeRoot, "items")).toBe(1);
    expect(tableCount(storeRoot, "rawdocs")).toBe(1);
    expect(tableCount(storeRoot, "documents")).toBe(0);
    expect(tableCount(storeRoot, "chunks")).toBe(0);
    await expect(access(join(storeRoot, paths.rawHtmlPath))).resolves.toBeUndefined();
    await expect(access(join(storeRoot, paths.rawdocPath))).resolves.toBeUndefined();
    await expect(access(join(storeRoot, paths.documentPath))).rejects.toThrow();
    await expect(access(join(storeRoot, paths.markdownPath))).rejects.toThrow();
    await expect(store.status(clip.normalizedUrl)).resolves.toMatchObject({
      state: "captured",
      activeRawdocId: clip.rawdoc.rawdoc_id
    });

    store.close();
  });

  it("creates all database tables with the v3 capture and derived columns", async () => {
    const store = new KnowledgeStore(storeRoot);
    await store.ensure();

    expectStoreSchema(storeRoot);

    store.close();
  });

  it("builds searchable chunks and returns section-level search results", async () => {
    const store = new KnowledgeStore(storeRoot);
    const clip = fixture("55555555-5555-4555-8555-555555555555", "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "Retrieval Title");

    await store.save(clip);

    const results = await store.search("retrieval systems", { limit: 5, trace: true });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      docId: clip.document.doc_id,
      rawdocId: clip.rawdoc.rawdoc_id,
      title: "Retrieval Title",
      sourceUrl: "https://example.com/article",
      normalizedUrl: "https://example.com/article",
      parserMethod: "defuddle"
    });
    expect(results[0].sectionIds.length).toBeGreaterThan(0);
    expect(results[0].snippet.toLowerCase()).toContain("retrieval");
    expect(results[0].trace).toMatchObject({
      queryTerms: ["retrieval", "systems"],
      matchedTerms: ["retrieval", "systems"],
      termCoverage: 1
    });

    store.close();
  });

  it("reranks broad FTS matches by query term coverage", async () => {
    const store = new KnowledgeStore(storeRoot);
    const target = fixture(
      "88888888-8888-4888-8888-888888888888",
      "88888888-aaaa-4aaa-8aaa-888888888888",
      "Grounded Retrieval",
      "Grounded Retrieval",
      "https://example.com/grounded"
    );
    const noisy = fixture(
      "99999999-9999-4999-8999-999999999999",
      "99999999-aaaa-4aaa-8aaa-999999999999",
      "Noisy Retrieval",
      "Noisy Retrieval",
      "https://example.com/noisy"
    );
    noisy.document.sections = [
      { section_id: "heading-1", type: "heading", level: 1, content: "Retrieval" },
      {
        section_id: "para-1",
        type: "paragraph",
        content: "Retrieval retrieval retrieval retrieval retrieval only repeats one broad term."
      }
    ];

    await store.save(noisy);
    await store.save(target);

    const results = await store.search("retrieval citations", { limit: 5, trace: true });
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0]).toMatchObject({
      normalizedUrl: "https://example.com/grounded",
      trace: {
        matchedTerms: ["retrieval", "citations"],
        termCoverage: 1
      }
    });
    expect(results.find((result) => result.normalizedUrl === "https://example.com/noisy")?.trace?.termCoverage).toBe(0.5);

    store.close();
  });

  it("packs ranked chunks into citation-ready context", async () => {
    const store = new KnowledgeStore(storeRoot);
    const clip = fixture("12121212-1212-4121-8121-121212121212", "abababab-abab-4bab-8bab-abababababab", "Context Title");

    await store.save(clip);

    const pack = await store.retrieveContext("retrieval systems", { limit: 3, maxChars: 2000, trace: true });
    expect(pack).toMatchObject({
      query: "retrieval systems",
      retriever: "sqlite_fts",
      packer: "section_chunk_v1",
      budget: {
        maxChars: 2000
      }
    });
    expect(pack.budget.usedChars).toBe(pack.contextText.length);
    expect(pack.budget.usedChars).toBeLessThanOrEqual(2000);
    expect(pack.contextText).toContain("[1] Context Title");
    expect(pack.contextText).toContain("Source: https://example.com/article");
    expect(pack.contextText).toContain("retrieval systems use chunking and citations");
    expect(pack.citations).toHaveLength(1);
    expect(pack.citations[0]).toMatchObject({
      citationId: expect.any(String),
      marker: "[1]",
      rank: 1,
      docId: clip.document.doc_id,
      rawdocId: clip.rawdoc.rawdoc_id,
      sourceUrl: "https://example.com/article",
      normalizedUrl: "https://example.com/article",
      truncated: false,
      trace: {
        termCoverage: 1
      }
    });
    expect(pack.citations[0].sectionIds.length).toBeGreaterThan(0);
    expect(pack.citations[0].content).toContain("Title: Context Title");

    store.close();
  });

  it("applies context character budget with truncation", async () => {
    const store = new KnowledgeStore(storeRoot);
    const clip = fixture(
      "34343434-3434-4434-8434-343434343434",
      "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
      "Long Context",
      "Long Context",
      "https://example.com/long-context"
    );
    clip.document.sections = [
      { section_id: "heading-1", type: "heading", level: 1, content: "Long Retrieval" },
      {
        section_id: "para-1",
        type: "paragraph",
        content: `retrieval citations ${"context packer ".repeat(120)}`
      }
    ];

    await store.save(clip);

    const pack = await store.retrieveContext("retrieval citations", { limit: 1, maxChars: 500 });
    expect(pack.budget.maxChars).toBe(500);
    expect(pack.budget.usedChars).toBeLessThanOrEqual(500);
    expect(pack.contextText.length).toBeLessThanOrEqual(500);
    expect(pack.citations).toHaveLength(1);
    expect(pack.citations[0]).toMatchObject({
      citationId: expect.any(String),
      truncated: true
    });
    expect(pack.citations[0].content).toContain("[truncated]");

    store.close();
  });

});

function expectStoreSchema(root: string): void {
  const database = new DatabaseSync(join(root, "index.sqlite3"));
  try {
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);

    const publicTables = tables.filter((table) => !table.startsWith("chunks_fts_"));
    expect(publicTables).toEqual([
      "annotations",
      "batch_items",
      "batch_jobs",
      "chunks",
      "chunks_fts",
      "collection_memberships",
      "documents",
      "epub_metadata",
      "item_aliases",
      "items",
      "rawdocs"
    ]);

    const columnsByTable = Object.fromEntries(
      tables.map((table) => [
        table,
        database
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((column) => (column as { name: string }).name)
      ])
    );

    expect(columnsByTable.items).toEqual(expect.arrayContaining([
      "item_id",
      "item_type",
      "source_type",
      "identity_key",
      "title",
      "subtitle",
      "creators_json",
      "language",
      "tags_json",
      "state",
      "member_visibility_mode",
      "active_capture_id",
      "active_doc_id",
      "created_at",
      "updated_at",
      "parsed_at"
    ]));
    expect(columnsByTable.item_aliases).toEqual(expect.arrayContaining([
      "alias_id",
      "item_id",
      "alias_type",
      "alias_value",
      "is_primary",
      "created_at"
    ]));
    expect(columnsByTable.documents).toEqual(expect.arrayContaining([
      "doc_id",
      "item_id",
      "capture_id",
      "title",
      "page_title",
      "source_url",
      "language",
      "authors_json",
      "published_at",
      "parser_version",
      "parser_method",
      "parser_profile",
      "content_hash",
      "created_at",
      "updated_at"
    ]));
    expect(columnsByTable.rawdocs).toEqual(expect.arrayContaining([
      "capture_id",
      "item_id",
      "source_uri",
      "source_type",
      "input_mode",
      "content_type",
      "content_length",
      "content_hash",
      "content_ext",
      "page_title",
      "captured_at",
      "fetched_at",
      "created_at"
    ]));
    expect(columnsByTable.chunks).toEqual(expect.arrayContaining([
      "chunk_id",
      "doc_id",
      "item_id",
      "capture_id",
      "chunk_index",
      "title",
      "page_title",
      "source_url",
      "heading_path",
      "section_ids_json",
      "text",
      "token_estimate",
      "char_count",
      "parser_version",
      "parser_method",
      "parser_profile",
      "content_hash",
      "created_at",
      "updated_at"
    ]));
    expect(columnsByTable.collection_memberships).toEqual(expect.arrayContaining([
      "membership_id",
      "collection_item_id",
      "member_item_id",
      "order_index",
      "depth",
      "parent_membership_id",
      "inclusion_mode",
      "inclusion_reason",
      "source_rule_id",
      "created_at",
      "updated_at"
    ]));
    expect(columnsByTable.batch_jobs).toEqual([
      "job_id",
      "collection_id",
      "source_page_url",
      "mode",
      "state",
      "total_count",
      "saved_count",
      "skipped_count",
      "failed_count",
      "cancelled_count",
      "options_json",
      "created_at",
      "started_at",
      "finished_at"
    ]);
    expect(columnsByTable.batch_items).toEqual([
      "item_id",
      "job_id",
      "collection_id",
      "url",
      "normalized_url",
      "source",
      "title_hint",
      "state",
      "rawdoc_id",
      "doc_id",
      "error_code",
      "error_message",
      "attempt_count",
      "created_at",
      "updated_at"
    ]);
    expect(columnsByTable.epub_metadata).toEqual([
      "item_id",
      "isbn",
      "publisher",
      "published_at",
      "identifiers_json",
      "cover_asset_id",
      "chapter_count",
      "metadata_json"
    ]);
    expect(columnsByTable.annotations).toEqual(expect.arrayContaining([
      "annotation_id",
      "doc_id",
      "section_id",
      "type",
      "text_ref",
      "note",
      "color",
      "label",
      "ai_model",
      "summary_level",
      "orphaned",
      "created_at",
      "updated_at"
    ]));

    const userVersion = database.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(userVersion.user_version).toBe(11);

    for (const columns of Object.values(columnsByTable)) {
      expect(columns.filter((column) => column.endsWith("_path") && column !== "heading_path")).toEqual([]);
    }
  } finally {
    database.close();
  }
}

function tableCount(root: string, table: string): number {
  const database = new DatabaseSync(join(root, "index.sqlite3"));
  try {
    return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  } finally {
    database.close();
  }
}

function fixture(docId: string, rawdocId: string, title: string, pageTitle = title, normalizedUrl = "https://example.com/article"): {
  normalizedUrl: string;
  html: string;
  rawdoc: RawDoc;
  document: KnowledgeDocument;
  markdown: string;
} {
  const html = `<!doctype html><title>${pageTitle}</title><article>${title}</article>`;
  const originalUrl = `${normalizedUrl}?utm_source=x`;

  return {
    normalizedUrl: originalUrl,
    html,
    rawdoc: {
      rawdoc_id: rawdocId,
      source_type: "url",
      source_uri: normalizedUrl,
      fetch_time: "2026-05-12T00:00:00.000Z",
      content_type: "text/html",
      content_length: Buffer.byteLength(html),
      metadata: {
        inputMode: "browser_html",
        parserMethod: "defuddle",
        pageTitle,
        contentTitle: title,
        displayTitle: pageTitle,
        originalUrl,
        canonicalUrl: normalizedUrl,
        normalizedUrl
      }
    },
    document: {
      doc_id: docId,
      meta: {
        title,
        page_title: pageTitle,
        source: {
          type: "html",
          url: normalizedUrl,
          rawdoc_id: rawdocId
        },
        authors: ["Ada"],
        ingested_at: "2026-05-12T00:00:00.000Z",
        parser_version: "knowledge-ingest-server/0.1:defuddle"
      },
      sections: [
        { section_id: "heading-1", type: "heading", level: 1, content: "Intro" },
        {
          section_id: "para-1",
          type: "paragraph",
          content: `${title} explains how retrieval systems use chunking and citations to return grounded answers.`
        },
        {
          section_id: "para-2",
          type: "paragraph",
          content: "A second section mentions SQLite FTS search, parser diagnostics, and evaluation loops."
        }
      ]
    },
    markdown: `# ${title}\n\n${title} explains how retrieval systems use chunking and citations to return grounded answers.\n`
  };
}
