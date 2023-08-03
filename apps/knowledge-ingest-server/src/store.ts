import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { access, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ClipListItem,
  ClipStatus,
  ClipSaveResponse,
  KnowledgeDocument,
  normalizeUrlForKnowledge,
  RawDoc,
  urlHash
} from "@uknowledge/knowledge-schema";
import { resolveInsideRoot } from "./path-guard.js";

interface ClipRow {
  url_hash: string;
  normalized_url: string;
  original_url: string | null;
  canonical_url: string | null;
  doc_id: string;
  rawdoc_id: string;
  page_title: string | null;
  parser_version: string;
  parser_method: string;
  content_hash: string | null;
  saved_at: string;
  updated_at: string;
}

interface SavePaths {
  rawHtmlPath: string;
  rawdocPath: string;
  documentPath: string;
  markdownPath: string;
}

const STORE_SCHEMA_VERSION = 2;

export class KnowledgeStore {
  private database?: DatabaseSync;

  constructor(private readonly root: string) {}

  async ensure(): Promise<void> {
    await Promise.all([
      mkdir(join(this.root, "rawdocs"), { recursive: true }),
      mkdir(join(this.root, "documents"), { recursive: true }),
      mkdir(join(this.root, "markdown"), { recursive: true }),
      mkdir(join(this.root, "assets"), { recursive: true })
    ]);
    await this.resetLegacyStoreIfNeeded();
    this.ensureDatabase();
  }

  async status(normalizedUrl: string): Promise<ClipStatus> {
    await this.ensure();
    const normalized = normalizeUrlForKnowledge(normalizedUrl);
    const hash = urlHash(normalized);
    const row = this.database!.prepare(`
      SELECT url_hash, normalized_url, original_url, canonical_url, doc_id, rawdoc_id, page_title,
        parser_version, parser_method, content_hash, saved_at, updated_at
      FROM clips
      WHERE url_hash = ?
    `).get(hash) as ClipRow | undefined;

    if (!row) {
      return {
        normalizedUrl: normalized,
        urlHash: hash,
        saved: false
      };
    }

    return this.toStatus(row);
  }

  async list(limit = 50): Promise<ClipListItem[]> {
    await this.ensure();
    const boundedLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
    const rows = this.database!.prepare(`
      SELECT url_hash, normalized_url, original_url, canonical_url, doc_id, rawdoc_id, page_title,
        parser_version, parser_method, content_hash, saved_at, updated_at
      FROM clips
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(boundedLimit) as unknown as ClipRow[];

    return rows.map((row) => {
      const paths = pathsFor(row.doc_id, row.rawdoc_id);
      return {
        normalizedUrl: row.normalized_url,
        urlHash: row.url_hash,
        savedAt: row.saved_at,
        updatedAt: row.updated_at,
        title: row.page_title ?? undefined,
        docId: row.doc_id,
        rawdocId: row.rawdoc_id,
        parserVersion: row.parser_version,
        parserMethod: row.parser_method,
        markdownPath: paths.markdownPath,
        documentPath: paths.documentPath
      };
    });
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }

  async deleteByUrl(normalizedUrl: string, deleteFiles = true): Promise<ClipStatus & { deleted: boolean; deletedPaths: string[] }> {
    await this.ensure();
    const normalized = normalizeUrlForKnowledge(normalizedUrl);
    const hash = urlHash(normalized);
    const row = this.findClip(hash);

    if (!row) {
      return {
        normalizedUrl: normalized,
        urlHash: hash,
        saved: false,
        deleted: false,
        deletedPaths: []
      };
    }

    this.database!.prepare("DELETE FROM clips WHERE url_hash = ?").run(hash);

    const deletedPaths: string[] = [];
    if (deleteFiles) {
      for (const relativePath of Object.values(pathsFor(row.doc_id, row.rawdoc_id))) {
        await this.deleteFile(relativePath);
        deletedPaths.push(relativePath);
      }
    }

    return {
      ...this.toStatus(row),
      saved: false,
      deleted: true,
      deletedPaths
    };
  }

  async save(params: {
    normalizedUrl: string;
    html: string;
    rawdoc: RawDoc;
    document: KnowledgeDocument;
    markdown: string;
  }): Promise<ClipSaveResponse["paths"]> {
    await this.ensure();

    const normalized = normalizeUrlForKnowledge(params.normalizedUrl);
    const hash = urlHash(normalized);
    const previous = this.findClip(hash);
    const paths = pathsFor(params.document.doc_id, params.rawdoc.rawdoc_id);
    const parserInfo = parserInfoFor(params.document, params.rawdoc);
    const now = new Date().toISOString();
    const contentHash = sha256(params.markdown);
    const authorsJson = JSON.stringify(params.document.meta.authors ?? []);
    const rawMetadata = params.rawdoc.metadata ?? {};

    await Promise.all([
      this.writeText(paths.rawHtmlPath, params.html),
      this.writeJson(paths.rawdocPath, params.rawdoc),
      this.writeJson(paths.documentPath, params.document),
      this.writeText(paths.markdownPath, params.markdown)
    ]);

    try {
      this.database!.exec("BEGIN");
      this.database!.prepare(`
        INSERT INTO rawdocs (
          rawdoc_id,
          source_uri,
          normalized_url,
          input_mode,
          content_type,
          content_length,
          html_hash,
          captured_at,
          fetched_at,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(rawdoc_id) DO UPDATE SET
          source_uri = excluded.source_uri,
          normalized_url = excluded.normalized_url,
          input_mode = excluded.input_mode,
          content_type = excluded.content_type,
          content_length = excluded.content_length,
          html_hash = excluded.html_hash,
          captured_at = excluded.captured_at,
          fetched_at = excluded.fetched_at
      `).run(
        params.rawdoc.rawdoc_id,
        params.rawdoc.source_uri,
        normalized,
        typeof rawMetadata.inputMode === "string" ? rawMetadata.inputMode : "browser_html",
        params.rawdoc.content_type ?? "text/html",
        params.rawdoc.content_length ?? Buffer.byteLength(params.html),
        sha256(params.html),
        typeof rawMetadata.capturedAt === "string" ? rawMetadata.capturedAt : null,
        params.rawdoc.fetch_time,
        now
      );

      this.database!.prepare(`
        INSERT INTO documents (
          doc_id,
          rawdoc_id,
          title,
          source_url,
          normalized_url,
          language,
          authors_json,
          published_at,
          parser_version,
          parser_method,
          parser_profile,
          content_hash,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(doc_id) DO UPDATE SET
          rawdoc_id = excluded.rawdoc_id,
          title = excluded.title,
          source_url = excluded.source_url,
          normalized_url = excluded.normalized_url,
          language = excluded.language,
          authors_json = excluded.authors_json,
          published_at = excluded.published_at,
          parser_version = excluded.parser_version,
          parser_method = excluded.parser_method,
          parser_profile = excluded.parser_profile,
          content_hash = excluded.content_hash,
          updated_at = excluded.updated_at
      `).run(
        params.document.doc_id,
        params.rawdoc.rawdoc_id,
        params.document.meta.title,
        params.document.meta.source.url ?? params.rawdoc.source_uri,
        normalized,
        params.document.meta.language ?? null,
        authorsJson,
        params.document.meta.published_at ?? null,
        parserInfo.version,
        parserInfo.method,
        parserInfo.profile,
        contentHash,
        now,
        now
      );

      this.database!.prepare(`
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
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(url_hash) DO UPDATE SET
          normalized_url = excluded.normalized_url,
          original_url = excluded.original_url,
          canonical_url = excluded.canonical_url,
          doc_id = excluded.doc_id,
          rawdoc_id = excluded.rawdoc_id,
          page_title = excluded.page_title,
          parser_version = excluded.parser_version,
          parser_method = excluded.parser_method,
          content_hash = excluded.content_hash,
          updated_at = excluded.updated_at
      `).run(
        hash,
        normalized,
        params.rawdoc.source_uri,
        params.document.meta.source.url ?? params.rawdoc.source_uri,
        params.document.doc_id,
        params.rawdoc.rawdoc_id,
        params.document.meta.title,
        parserInfo.version,
        parserInfo.method,
        contentHash,
        previous?.saved_at ?? now,
        now
      );
      this.database!.exec("COMMIT");
    } catch (error) {
      this.database!.exec("ROLLBACK");
      throw error;
    }

    if (previous && (previous.doc_id !== params.document.doc_id || previous.rawdoc_id !== params.rawdoc.rawdoc_id)) {
      await this.deleteObjectFiles(previous);
    }

    return paths;
  }

  private ensureDatabase(): void {
    if (this.database) {
      return;
    }

    const database = new DatabaseSync(this.databasePath);
    database.exec(`
      CREATE TABLE IF NOT EXISTS clips (
        url_hash TEXT PRIMARY KEY,
        normalized_url TEXT NOT NULL UNIQUE,
        original_url TEXT,
        canonical_url TEXT,
        doc_id TEXT NOT NULL,
        rawdoc_id TEXT NOT NULL,
        page_title TEXT,
        parser_version TEXT NOT NULL,
        parser_method TEXT NOT NULL,
        content_hash TEXT,
        saved_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_clips_doc_id ON clips(doc_id);
      CREATE INDEX IF NOT EXISTS idx_clips_rawdoc_id ON clips(rawdoc_id);

      CREATE TABLE IF NOT EXISTS documents (
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

      CREATE INDEX IF NOT EXISTS idx_documents_rawdoc_id ON documents(rawdoc_id);
      CREATE INDEX IF NOT EXISTS idx_documents_content_hash ON documents(content_hash);

      CREATE TABLE IF NOT EXISTS rawdocs (
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

      CREATE INDEX IF NOT EXISTS idx_rawdocs_normalized_url ON rawdocs(normalized_url);
      CREATE INDEX IF NOT EXISTS idx_rawdocs_html_hash ON rawdocs(html_hash);

      PRAGMA user_version = ${STORE_SCHEMA_VERSION};
    `);
    this.database = database;
  }

  private async resetLegacyStoreIfNeeded(): Promise<void> {
    if (this.database) {
      return;
    }

    try {
      await access(this.databasePath);
    } catch {
      return;
    }

    const database = new DatabaseSync(this.databasePath);
    try {
      const clipsTable = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'clips'")
        .get() as { name: string } | undefined;
      if (!clipsTable) {
        return;
      }

      const columns = database.prepare("PRAGMA table_info(clips)").all() as unknown as Array<{ name: string }>;
      const hasNewSchema = columns.some((column) => column.name === "rawdoc_id") &&
        columns.some((column) => column.name === "parser_version") &&
        columns.some((column) => column.name === "parser_method");
      if (hasNewSchema) {
        return;
      }
    } finally {
      database.close();
    }

    await Promise.all([
      unlink(this.databasePath).catch(ignoreMissing),
      rm(join(this.root, "docs"), { recursive: true, force: true }),
      rm(join(this.root, "rawdocs"), { recursive: true, force: true }),
      rm(join(this.root, "documents"), { recursive: true, force: true }),
      rm(join(this.root, "markdown"), { recursive: true, force: true })
    ]);

    await Promise.all([
      mkdir(join(this.root, "rawdocs"), { recursive: true }),
      mkdir(join(this.root, "documents"), { recursive: true }),
      mkdir(join(this.root, "markdown"), { recursive: true })
    ]);
  }

  private findClip(hash: string): ClipRow | undefined {
    return this.database!.prepare(`
      SELECT url_hash, normalized_url, original_url, canonical_url, doc_id, rawdoc_id, page_title,
        parser_version, parser_method, content_hash, saved_at, updated_at
      FROM clips
      WHERE url_hash = ?
    `).get(hash) as ClipRow | undefined;
  }

  private toStatus(row: ClipRow): ClipStatus {
    const paths = pathsFor(row.doc_id, row.rawdoc_id);
    return {
      normalizedUrl: row.normalized_url,
      urlHash: row.url_hash,
      saved: true,
      savedAt: row.saved_at,
      updatedAt: row.updated_at,
      title: row.page_title ?? undefined,
      docId: row.doc_id,
      rawdocId: row.rawdoc_id,
      parserVersion: row.parser_version,
      parserMethod: row.parser_method,
      markdownPath: paths.markdownPath,
      documentPath: paths.documentPath
    };
  }

  private async deleteObjectFiles(row: Pick<ClipRow, "doc_id" | "rawdoc_id">): Promise<void> {
    for (const relativePath of Object.values(pathsFor(row.doc_id, row.rawdoc_id))) {
      await this.deleteFile(relativePath);
    }
  }

  private async writeText(relativePath: string, content: string): Promise<void> {
    const path = resolveInsideRoot(this.root, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }

  private async writeJson(relativePath: string, content: unknown): Promise<void> {
    await this.writeText(relativePath, JSON.stringify(content, null, 2) + "\n");
  }

  private get databasePath(): string {
    return join(this.root, "index.sqlite3");
  }

  private async deleteFile(relativePath: string): Promise<void> {
    const path = resolveInsideRoot(this.root, relativePath);
    await unlink(path).catch(ignoreMissing);
  }
}

function pathsFor(docId: string, rawdocId: string): SavePaths {
  return {
    rawHtmlPath: `rawdocs/${rawdocId}.html`,
    rawdocPath: `rawdocs/${rawdocId}.json`,
    documentPath: `documents/${docId}.json`,
    markdownPath: `markdown/${docId}.md`
  };
}

function parserInfoFor(document: KnowledgeDocument, rawdoc: RawDoc): { version: string; method: string; profile: string | null } {
  const rawParserMethod = rawdoc.metadata?.parserMethod;
  const combinedVersion = document.meta.parser_version ?? "knowledge-ingest-server/0.1";
  const separatorIndex = combinedVersion.lastIndexOf(":");
  const method = typeof rawParserMethod === "string"
    ? rawParserMethod
    : separatorIndex > -1
      ? combinedVersion.slice(separatorIndex + 1)
      : "unknown";
  const version = separatorIndex > -1 ? combinedVersion.slice(0, separatorIndex) : combinedVersion;

  return {
    version,
    method,
    profile: typeof rawdoc.metadata?.parserProfile === "string" ? rawdoc.metadata.parserProfile : null
  };
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function ignoreMissing(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
    throw error;
  }
}
