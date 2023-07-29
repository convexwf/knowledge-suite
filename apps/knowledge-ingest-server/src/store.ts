import { DatabaseSync } from "node:sqlite";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ClipListItem,
  ClipStatus,
  ClipSaveResponse,
  KnowledgeDocument,
  normalizeUrlForKnowledge,
  RawDoc,
  slugifyTitle,
  urlHash
} from "@uknowledge/knowledge-schema";
import { resolveInsideRoot } from "./path-guard.js";

interface ClipRow {
  normalized_url: string;
  url_hash: string;
  saved_at: string;
  title: string | null;
  doc_id: string | null;
  raw_html_path: string | null;
  rawdoc_path: string | null;
  markdown_path: string | null;
  document_path: string | null;
}

export class KnowledgeStore {
  private database?: DatabaseSync;

  constructor(private readonly root: string) {}

  async ensure(): Promise<void> {
    await Promise.all([
      mkdir(join(this.root, "rawdocs"), { recursive: true }),
      mkdir(join(this.root, "docs"), { recursive: true }),
      mkdir(join(this.root, "index"), { recursive: true })
    ]);
    this.ensureDatabase();
  }

  async status(normalizedUrl: string): Promise<ClipStatus> {
    await this.ensure();
    const normalized = normalizeUrlForKnowledge(normalizedUrl);
    const hash = urlHash(normalized);
    const row = this.database!.prepare(`
      SELECT normalized_url, url_hash, saved_at, title, doc_id, raw_html_path, rawdoc_path, markdown_path, document_path
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

    return {
      normalizedUrl: row.normalized_url,
      urlHash: row.url_hash,
      saved: true,
      savedAt: row.saved_at,
      title: row.title ?? undefined,
      docId: row.doc_id ?? undefined,
      markdownPath: row.markdown_path ?? undefined,
      documentPath: row.document_path ?? undefined
    };
  }

  async list(limit = 50): Promise<ClipListItem[]> {
    await this.ensure();
    const boundedLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
    const rows = this.database!.prepare(`
      SELECT normalized_url, url_hash, saved_at, title, doc_id, raw_html_path, rawdoc_path, markdown_path, document_path
      FROM clips
      ORDER BY saved_at DESC
      LIMIT ?
    `).all(boundedLimit) as unknown as ClipRow[];

    return rows.map((row) => ({
      normalizedUrl: row.normalized_url,
      urlHash: row.url_hash,
      savedAt: row.saved_at,
      title: row.title ?? undefined,
      docId: row.doc_id ?? undefined,
      markdownPath: row.markdown_path ?? undefined,
      documentPath: row.document_path ?? undefined
    }));
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }

  async deleteByUrl(normalizedUrl: string, deleteFiles = true): Promise<ClipStatus & { deleted: boolean; deletedPaths: string[] }> {
    await this.ensure();
    const before = await this.status(normalizedUrl);
    if (!before.saved) {
      return {
        ...before,
        deleted: false,
        deletedPaths: []
      };
    }

    const row = this.database!.prepare(`
      SELECT normalized_url, url_hash, saved_at, title, doc_id, raw_html_path, rawdoc_path, markdown_path, document_path
      FROM clips
      WHERE url_hash = ?
    `).get(before.urlHash) as ClipRow | undefined;

    this.database!.prepare("DELETE FROM clips WHERE url_hash = ?").run(before.urlHash);

    const deletedPaths: string[] = [];
    if (deleteFiles && row) {
      for (const relativePath of [
        row.raw_html_path,
        row.rawdoc_path,
        row.markdown_path,
        row.document_path
      ]) {
        if (!relativePath) {
          continue;
        }
        await this.deleteFile(relativePath);
        deletedPaths.push(relativePath);
      }
    }

    return {
      ...before,
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
    const slug = `${slugifyTitle(params.document.meta.title)}-${params.document.doc_id.slice(0, 8)}`;
    const rawHtmlPath = `rawdocs/${params.rawdoc.rawdoc_id}.html`;
    const rawdocPath = `rawdocs/${params.rawdoc.rawdoc_id}.meta.json`;
    const documentPath = `docs/${slug}.json`;
    const markdownPath = `docs/${slug}.md`;

    await Promise.all([
      this.writeText(rawHtmlPath, params.html),
      this.writeJson(rawdocPath, params.rawdoc),
      this.writeJson(documentPath, params.document),
      this.writeText(markdownPath, params.markdown)
    ]);

    this.database!.prepare(`
      INSERT INTO clips (
        url_hash,
        normalized_url,
        saved_at,
        title,
        doc_id,
        raw_html_path,
        rawdoc_path,
        markdown_path,
        document_path
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(url_hash) DO UPDATE SET
        normalized_url = excluded.normalized_url,
        saved_at = excluded.saved_at,
        title = excluded.title,
        doc_id = excluded.doc_id,
        raw_html_path = excluded.raw_html_path,
        rawdoc_path = excluded.rawdoc_path,
        markdown_path = excluded.markdown_path,
        document_path = excluded.document_path
    `).run(
      urlHash(normalized),
      normalized,
      new Date().toISOString(),
      params.document.meta.title,
      params.document.doc_id,
      rawHtmlPath,
      rawdocPath,
      markdownPath,
      documentPath
    );

    return { rawHtmlPath, rawdocPath, documentPath, markdownPath };
  }

  private ensureDatabase(): void {
    if (this.database) {
      return;
    }

    const database = new DatabaseSync(this.databasePath);
    database.exec(`
      CREATE TABLE IF NOT EXISTS clips (
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

      CREATE INDEX IF NOT EXISTS idx_clips_normalized_url ON clips(normalized_url);
    `);
    this.addColumnIfMissing(database, "raw_html_path");
    this.addColumnIfMissing(database, "rawdoc_path");
    this.database = database;
  }

  private addColumnIfMissing(database: DatabaseSync, column: "raw_html_path" | "rawdoc_path"): void {
    const columns = database.prepare("PRAGMA table_info(clips)").all() as unknown as Array<{ name: string }>;
    if (!columns.some((info) => info.name === column)) {
      database.exec(`ALTER TABLE clips ADD COLUMN ${column} TEXT`);
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
    await unlink(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    });
  }
}
