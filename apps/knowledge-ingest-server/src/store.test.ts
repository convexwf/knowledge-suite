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
    const second = fixture("22222222-2222-4222-8222-222222222222", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Second Title");

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
    expect(tableCount(storeRoot, "clips")).toBe(1);
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
      normalizedUrl: "https://example.com/article",
      state: "parsed",
      hasRawdoc: true,
      hasDocument: true,
      title: "Second Title",
      docId: second.document.doc_id,
      rawdocId: second.rawdoc.rawdoc_id
    });
    expect(status.captureSavedAt).toEqual(expect.any(String));
    expect(status.captureUpdatedAt).toEqual(expect.any(String));
    expect(status.parseUpdatedAt).toEqual(expect.any(String));

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      normalizedUrl: "https://example.com/article",
      state: "parsed",
      hasRawdoc: true,
      hasDocument: true,
      title: "Second Title",
      docId: second.document.doc_id,
      rawdocId: second.rawdoc.rawdoc_id
    });

    store.close();
  });

  it("remove deletes only derived artifacts and keeps the raw capture for reparse", async () => {
    const store = new KnowledgeStore(storeRoot);
    const clip = fixture("33333333-3333-4333-8333-333333333333", "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "Captured Title");

    const paths = await store.save(clip);
    expect(tableCount(storeRoot, "clips")).toBe(1);
    expect(tableCount(storeRoot, "documents")).toBe(1);
    expect(tableCount(storeRoot, "rawdocs")).toBe(1);
    expect(tableCount(storeRoot, "chunks")).toBeGreaterThan(0);

    const result = await store.deleteByUrl(clip.normalizedUrl, "remove");

    expect(result).toMatchObject({
      deleted: true,
      mode: "remove",
      previousState: "parsed",
      currentState: "captured",
      state: "captured",
      hasRawdoc: true,
      hasDocument: false,
      removedDocId: clip.document.doc_id,
      rawdocId: clip.rawdoc.rawdoc_id
    });
    expect(result.deletedFiles).toEqual([
      paths.documentPath,
      paths.markdownPath
    ]);
    expect(tableCount(storeRoot, "clips")).toBe(1);
    expect(tableCount(storeRoot, "documents")).toBe(0);
    expect(tableCount(storeRoot, "rawdocs")).toBe(1);
    expect(tableCount(storeRoot, "chunks")).toBe(0);
    await expect(access(join(storeRoot, paths.documentPath))).rejects.toThrow();
    await expect(access(join(storeRoot, paths.markdownPath))).rejects.toThrow();
    await expect(access(join(storeRoot, paths.rawHtmlPath))).resolves.toBeUndefined();
    await expect(access(join(storeRoot, paths.rawdocPath))).resolves.toBeUndefined();

    const status = await store.status(clip.normalizedUrl);
    expect(status).toMatchObject({
      state: "captured",
      hasRawdoc: true,
      hasDocument: false,
      rawdocId: clip.rawdoc.rawdoc_id
    });
    expect(status.docId).toBeUndefined();
    expect(status.parseUpdatedAt).toBeUndefined();

    const capture = await store.loadCaptureByUrl(clip.normalizedUrl);
    expect(capture.html).toContain("Captured Title");
    expect(capture.rawdoc.rawdoc_id).toBe(clip.rawdoc.rawdoc_id);

    store.close();
  });

  it("purge deletes clip rows, capture rows, and all capture files", async () => {
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
      state: "empty",
      hasRawdoc: false,
      hasDocument: false,
      removedRawdocId: clip.rawdoc.rawdoc_id
    });
    expect(purged.deletedFiles).toEqual([
      paths.rawHtmlPath,
      paths.rawdocPath
    ]);
    expect(tableCount(storeRoot, "clips")).toBe(0);
    expect(tableCount(storeRoot, "documents")).toBe(0);
    expect(tableCount(storeRoot, "rawdocs")).toBe(0);
    expect(tableCount(storeRoot, "chunks")).toBe(0);
    await expect(access(join(storeRoot, paths.rawHtmlPath))).rejects.toThrow();
    await expect(access(join(storeRoot, paths.rawdocPath))).rejects.toThrow();

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

    const results = await store.search("retrieval systems", { limit: 5 });
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

    store.close();
  });

  it("migrates the v2 clips table into the capture and derived split schema", async () => {
    const database = new DatabaseSync(join(storeRoot, "index.sqlite3"));
    database.exec(`
      CREATE TABLE clips (
        url_hash TEXT PRIMARY KEY,
        normalized_url TEXT NOT NULL UNIQUE,
        original_url TEXT,
        canonical_url TEXT,
        doc_id TEXT,
        rawdoc_id TEXT NOT NULL,
        page_title TEXT,
        parser_version TEXT,
        parser_method TEXT,
        content_hash TEXT,
        saved_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE documents (
        doc_id TEXT PRIMARY KEY,
        rawdoc_id TEXT NOT NULL,
        title TEXT NOT NULL,
        source_url TEXT,
        normalized_url TEXT,
        language TEXT,
        authors_json TEXT,
        published_at TEXT,
        parser_version TEXT NOT NULL,
        parser_method TEXT NOT NULL,
        parser_profile TEXT,
        content_hash TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE rawdocs (
        rawdoc_id TEXT PRIMARY KEY,
        source_uri TEXT NOT NULL,
        normalized_url TEXT,
        input_mode TEXT NOT NULL,
        content_type TEXT,
        content_length INTEGER,
        html_hash TEXT,
        captured_at TEXT,
        fetched_at TEXT,
        created_at TEXT NOT NULL
      );

      INSERT INTO clips (
        url_hash,
        normalized_url,
        original_url,
        canonical_url,
        doc_id,
        rawdoc_id,
        page_title,
        parser_version,
        parser_method,
        content_hash,
        saved_at,
        updated_at
      )
      VALUES (
        'hash-v2',
        'https://example.com/v2',
        'https://example.com/v2?utm_source=x',
        'https://example.com/v2',
        'doc-v2',
        'raw-v2',
        'Migrated Title',
        'knowledge-ingest-server/0.1',
        'defuddle',
        'content-hash',
        '2026-05-10T00:00:00.000Z',
        '2026-05-11T00:00:00.000Z'
      );

      PRAGMA user_version = 2;
    `);
    database.close();

    const store = new KnowledgeStore(storeRoot);
    await store.ensure();

    const status = await store.status("https://example.com/v2?utm_source=x");
    expect(status).toMatchObject({
      normalizedUrl: "https://example.com/v2",
      state: "parsed",
      hasRawdoc: true,
      hasDocument: true,
      originalUrl: "https://example.com/v2?utm_source=x",
      canonicalUrl: "https://example.com/v2",
      title: "Migrated Title",
      docId: "doc-v2",
      rawdocId: "raw-v2",
      captureSavedAt: "2026-05-10T00:00:00.000Z",
      captureUpdatedAt: "2026-05-11T00:00:00.000Z",
      parseUpdatedAt: "2026-05-11T00:00:00.000Z"
    });

    expectStoreSchema(storeRoot);
    store.close();
  });

  it("deletes the legacy path-based store instead of migrating old documents", async () => {
    await mkdir(join(storeRoot, "docs"), { recursive: true });
    await mkdir(join(storeRoot, "rawdocs"), { recursive: true });
    await writeFile(join(storeRoot, "docs", "legacy.md"), "legacy markdown", "utf8");
    await writeFile(join(storeRoot, "rawdocs", "legacy.meta.json"), "{}", "utf8");

    const database = new DatabaseSync(join(storeRoot, "index.sqlite3"));
    database.exec(`
      CREATE TABLE clips (
        url_hash TEXT PRIMARY KEY,
        normalized_url TEXT NOT NULL,
        saved_at TEXT NOT NULL,
        title TEXT,
        doc_id TEXT,
        raw_html_path TEXT,
        rawdoc_path TEXT,
        markdown_path TEXT,
        document_path TEXT
      );
    `);
    database.close();

    const store = new KnowledgeStore(storeRoot);
    await store.ensure();

    await expect(access(join(storeRoot, "docs", "legacy.md"))).rejects.toThrow();
    await expect(access(join(storeRoot, "rawdocs", "legacy.meta.json"))).rejects.toThrow();
    expect(await store.status("https://example.com/legacy")).toMatchObject({
      state: "empty",
      hasRawdoc: false,
      hasDocument: false
    });

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
      "batch_items",
      "batch_jobs",
      "chunks",
      "chunks_fts",
      "clips",
      "collection_items",
      "collections",
      "documents",
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

    expect(columnsByTable.clips).toEqual([
      "url_hash",
      "normalized_url",
      "original_url",
      "canonical_url",
      "rawdoc_id",
      "active_doc_id",
      "page_title",
      "capture_saved_at",
      "capture_updated_at",
      "parse_updated_at"
    ]);
    expect(columnsByTable.documents).toEqual([
      "doc_id",
      "rawdoc_id",
      "title",
      "source_url",
      "normalized_url",
      "language",
      "authors_json",
      "published_at",
      "parser_version",
      "parser_method",
      "parser_profile",
      "content_hash",
      "created_at",
      "updated_at"
    ]);
    expect(columnsByTable.rawdocs).toEqual([
      "rawdoc_id",
      "source_uri",
      "normalized_url",
      "input_mode",
      "content_type",
      "content_length",
      "html_hash",
      "captured_at",
      "fetched_at",
      "created_at"
    ]);
    expect(columnsByTable.chunks).toEqual([
      "chunk_id",
      "doc_id",
      "rawdoc_id",
      "chunk_index",
      "title",
      "source_url",
      "normalized_url",
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
    ]);
    expect(columnsByTable.collections).toEqual([
      "collection_id",
      "title",
      "root_url",
      "normalized_root_url",
      "source_type",
      "state",
      "created_at",
      "updated_at"
    ]);
    expect(columnsByTable.collection_items).toEqual([
      "collection_item_id",
      "collection_id",
      "normalized_url",
      "doc_id",
      "rawdoc_id",
      "title",
      "order_index",
      "depth",
      "parent_item_id",
      "source",
      "state",
      "created_at",
      "updated_at"
    ]);
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

    const userVersion = database.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(userVersion.user_version).toBe(6);

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

function fixture(docId: string, rawdocId: string, title: string): {
  normalizedUrl: string;
  html: string;
  rawdoc: RawDoc;
  document: KnowledgeDocument;
  markdown: string;
} {
  const normalizedUrl = "https://example.com/article";
  const html = `<!doctype html><title>${title}</title><article>${title}</article>`;

  return {
    normalizedUrl: "https://example.com/article?utm_source=x",
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
        originalUrl: "https://example.com/article?utm_source=x",
        canonicalUrl: normalizedUrl,
        normalizedUrl
      }
    },
    document: {
      doc_id: docId,
      meta: {
        title,
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
