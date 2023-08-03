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

  it("stores UUID-named objects and moves a URL to the newest reparse result", async () => {
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
    await expect(access(join(storeRoot, firstPaths.documentPath))).rejects.toThrow();
    await expect(access(join(storeRoot, firstPaths.markdownPath))).rejects.toThrow();
    await expect(access(join(storeRoot, firstPaths.rawHtmlPath))).rejects.toThrow();
    await expect(access(join(storeRoot, firstPaths.rawdocPath))).rejects.toThrow();
    await expect(access(join(storeRoot, secondPaths.documentPath))).resolves.toBeUndefined();

    const status = await store.status("https://example.com/article?utm_source=x");
    expect(status).toMatchObject({
      saved: true,
      title: "Second Title",
      docId: second.document.doc_id,
      rawdocId: second.rawdoc.rawdoc_id,
      parserVersion: "knowledge-ingest-server/0.1",
      parserMethod: "defuddle",
      documentPath: secondPaths.documentPath,
      markdownPath: secondPaths.markdownPath
    });

    store.close();
  });

  it("creates all database tables with no stored path columns", async () => {
    const store = new KnowledgeStore(storeRoot);
    await store.ensure();

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
      saved: false
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

    expect(tables).toEqual(["clips", "documents", "rawdocs"]);

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
      "doc_id",
      "rawdoc_id",
      "page_title",
      "parser_version",
      "parser_method",
      "content_hash",
      "saved_at",
      "updated_at"
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

    for (const columns of Object.values(columnsByTable)) {
      expect(columns.filter((column) => column.includes("path"))).toEqual([]);
    }
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
        parserMethod: "defuddle"
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
      sections: [{ type: "paragraph", content: title }]
    },
    markdown: `# ${title}\n`
  };
}
