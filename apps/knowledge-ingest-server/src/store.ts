import { DatabaseSync } from "node:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ClipStatus,
  ClipSaveResponse,
  KnowledgeDocument,
  normalizeUrlForKnowledge,
  RawDoc,
  slugifyTitle,
  urlHash
} from "@uknowledge/knowledge-schema";

interface ClipRow {
  normalized_url: string;
  url_hash: string;
  saved_at: string;
  title: string | null;
  doc_id: string | null;
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
      SELECT normalized_url, url_hash, saved_at, title, doc_id, markdown_path, document_path
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

  close(): void {
    this.database?.close();
    this.database = undefined;
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
        markdown_path,
        document_path
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(url_hash) DO UPDATE SET
        normalized_url = excluded.normalized_url,
        saved_at = excluded.saved_at,
        title = excluded.title,
        doc_id = excluded.doc_id,
        markdown_path = excluded.markdown_path,
        document_path = excluded.document_path
    `).run(
      urlHash(normalized),
      normalized,
      new Date().toISOString(),
      params.document.meta.title,
      params.document.doc_id,
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
        markdown_path TEXT,
        document_path TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_clips_normalized_url ON clips(normalized_url);
    `);
    this.database = database;
  }

  private async writeText(relativePath: string, content: string): Promise<void> {
    const path = join(this.root, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }

  private async writeJson(relativePath: string, content: unknown): Promise<void> {
    await this.writeText(relativePath, JSON.stringify(content, null, 2) + "\n");
  }

  private get databasePath(): string {
    return join(this.root, "index.sqlite3");
  }
}
