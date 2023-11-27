import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { access, copyFile, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join } from "node:path";
import {
  Annotation,
  AnnotationFile,
  AnnotationFileSchema,
  BatchItemState,
  BatchJobItem,
  BatchJobResponse,
  BatchJobState,
  CollectionItem,
  CollectionState,
  CollectionSummary,
  ContextCitation,
  ContextPackResponse,
  KnowledgeItem,
  KnowledgeItemDeleteMode,
  KnowledgeItemDeleteResponse,
  KnowledgeDocument,
  makeId,
  normalizeUrlForKnowledge,
  RawDoc,
  SearchResultItem,
  StoreClearParsedResponse,
  StoreClearResponse,
  StoreMaintenanceScan,
  urlHash
} from "@uknowledge/knowledge-schema";
import { buildChunks } from "./chunks.js";
import { resolveInsideRoot } from "./path-guard.js";

// ── Row interfaces (target model) ──────────────────────────────────────────

interface ItemRow {
  item_id: string;
  item_type: "document" | "collection";
  source_type: "url" | "singlefile_html" | "pdf" | "epub" | "virtual_collection";
  identity_key: string | null;
  title: string | null;
  subtitle: string | null;
  creators_json: string;
  language: string | null;
  tags_json: string;
  state: "empty" | "captured" | "parsed" | "stale" | "archived";
  member_visibility_mode: "hide_members" | "show_members" | null;
  active_capture_id: string | null;
  active_doc_id: string | null;
  created_at: string;
  updated_at: string;
  parsed_at: string | null;
}

interface ItemAliasRow {
  alias_id: string;
  item_id: string;
  alias_type: string;
  alias_value: string;
  is_primary: number;
  created_at: string;
}

interface ItemAliasInfo {
  normalizedUrl?: string;
  originalUrl?: string;
  canonicalUrl?: string;
  rootUrl?: string;
  normalizedRootUrl?: string;
}

interface RawdocRow {
  capture_id: string;
  item_id: string;
  source_uri: string;
  source_type: string;
  input_mode: string;
  content_type: string | null;
  content_length: number | null;
  content_hash: string | null;
  content_ext: string;
  page_title: string | null;
  captured_at: string | null;
  fetched_at: string | null;
  created_at: string;
}

interface DocumentRow {
  doc_id: string;
  item_id: string;
  capture_id: string;
  title: string;
  page_title: string | null;
  source_url: string | null;
  language: string | null;
  authors_json: string | null;
  published_at: string | null;
  parser_version: string;
  parser_method: string;
  parser_profile: string | null;
  content_hash: string | null;
  created_at: string;
  updated_at: string;
}

interface ActiveDocumentInfo {
  page_title: string | null;
  content_title: string | null;
}

interface CollectionMembershipRow {
  membership_id: string;
  collection_item_id: string;
  member_item_id: string;
  order_index: number;
  depth: number;
  parent_membership_id: string | null;
  inclusion_mode: string;
  inclusion_reason: string | null;
  source_rule_id: string | null;
  created_at: string;
  updated_at: string;
}

interface SearchChunkRow {
  chunk_id: string;
  doc_id: string;
  item_id: string;
  capture_id: string;
  chunk_index: number;
  title: string;
  page_title: string | null;
  source_url: string | null;
  heading_path: string | null;
  section_ids_json: string;
  text: string;
  token_estimate: number | null;
  char_count: number;
  parser_version: string | null;
  parser_method: string | null;
  parser_profile: string | null;
  content_hash: string;
  created_at: string;
  updated_at: string;
  score?: number;
  rank?: number;
}

// Keep batch rows for now (will be replaced by refresh_* tables later)
interface BatchJobRow {
  job_id: string;
  collection_id: string | null;
  source_page_url: string;
  mode: string;
  state: BatchJobState;
  total_count: number;
  saved_count: number;
  skipped_count: number;
  failed_count: number;
  cancelled_count: number;
  options_json: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface BatchItemRow {
  item_id: string;
  job_id: string;
  collection_id: string | null;
  url: string;
  normalized_url: string | null;
  source: string | null;
  title_hint: string | null;
  state: string;
  rawdoc_id: string | null;
  doc_id: string | null;
  error_code: string | null;
  error_message: string | null;
  attempt_count: number;
  created_at: string;
  updated_at: string;
}

interface DocumentStatistics {
  sectionCount: number;
  headingCount: number;
  paragraphCount: number;
  tableCount: number;
  figureCount: number;
  imageCount: number;
  assetCount: number;
  charCount: number;
}

type DocumentMetaWithDerivedInfo = KnowledgeDocument["meta"] & {
  cover_asset_id?: string;
  statistics?: DocumentStatistics;
};

interface EpubMetadataInput {
  isbn?: string;
  publisher?: string;
  publishedAt?: string;
  identifiers?: Record<string, string>;
  coverAssetId?: string;
  chapterCount?: number;
  metadata?: Record<string, unknown>;
}

interface SearchOptions {
  limit?: number;
  docId?: string;
  url?: string;
  parserMethod?: string;
  trace?: boolean;
}

interface ContextOptions extends SearchOptions {
  maxChars?: number;
}

interface CollectionItemDetail extends CollectionItem {
  creators?: string[];
  language?: string;
}

const STORE_SCHEMA_VERSION = 11;

// ── Helpers ────────────────────────────────────────────────────────────────

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf-8").digest("hex");
}

function sha256Buffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function safeJsonArray(raw: string): string[] {
  try { return JSON.parse(raw) as string[]; } catch { return []; }
}

function pageTitleFor(document: KnowledgeDocument, rawdoc: RawDoc): string {
  const metaTitle = document.meta.page_title;
  if (metaTitle && metaTitle !== document.meta.title) return metaTitle;
  const rawPageTitle = (rawdoc.metadata as Record<string, unknown> | undefined)?.pageTitle;
  if (typeof rawPageTitle === "string" && rawPageTitle !== document.meta.title) return rawPageTitle;
  return document.meta.title;
}

function titleFields(
  pageTitle: string | null,
  contentTitle: string | null,
  normalizedUrl: string
): { title: string; pageTitle?: string; contentTitle?: string; displayTitle: string } {
  const displayTitle = pageTitle || contentTitle || tryHostnameTitle(normalizedUrl);
  return {
    title: displayTitle,
    pageTitle: pageTitle ?? undefined,
    contentTitle: contentTitle ?? undefined,
    displayTitle
  };
}

function tryHostnameTitle(input: string): string {
  try { return new URL(input).hostname; } catch { return input.slice(0, 80) || "Untitled"; }
}

function parserInfoFor(document: KnowledgeDocument, rawdoc: RawDoc): {
  version: string;
  method: string;
  profile: string | null;
} {
  const meta = rawdoc.metadata as Record<string, unknown> | undefined;
  const parserVersion = document.meta.parser_version ?? "0.0.0";
  const inferredMethod = parserVersion.includes(":")
    ? parserVersion.slice(parserVersion.lastIndexOf(":") + 1)
    : "unknown";
  return {
    version: (meta?.parserVersion as string) ?? parserVersion,
    method: (meta?.parserMethod as string) ?? inferredMethod,
    profile: (meta?.parserProfile as string | undefined) ?? null
  };
}

function sanitizeExtension(ext: string): string {
  return ext.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10);
}

function pathsFor(docId: string, captureId: string) {
  return {
    rawHtmlPath: `rawdocs/${captureId}.html`,
    rawdocPath: `rawdocs/${captureId}.json`,
    documentPath: `documents/${docId}.json`,
    markdownPath: `markdown/${docId}.md`
  };
}

function pathsForActiveCapture(captureId: string) {
  return {
    rawHtmlPath: `rawdocs/${captureId}.html`,
    rawdocPath: `rawdocs/${captureId}.json`
  };
}

// ── KnowledgeStore ──────────────────────────────────────────────────────────

export class KnowledgeStore {
  private database?: DatabaseSync;

  constructor(private readonly root: string) {}

  // ── lifecycle ──────────────────────────────────────────────────────────

  async ensure(): Promise<void> {
    await Promise.all([
      mkdir(join(this.root, "rawdocs"), { recursive: true }),
      mkdir(join(this.root, "documents"), { recursive: true }),
      mkdir(join(this.root, "markdown"), { recursive: true }),
      mkdir(join(this.root, "assets"), { recursive: true })
    ]);
    this.ensureDatabase();
    this.migrateSchemaIfNeeded();
    this.ensureIndexes();
  }

  async close(): Promise<void> {
    this.database?.close();
    this.database = undefined;
  }

  private ensureDatabase(): void {
    if (this.database) return;
    this.database = new DatabaseSync(join(this.root, "index.sqlite3"));
    this.database.exec("PRAGMA foreign_keys = ON");
  }

  private ensureIndexes(): void {
    this.database!.exec(`
      CREATE INDEX IF NOT EXISTS idx_items_type_state ON items(item_type, state);
      CREATE INDEX IF NOT EXISTS idx_items_identity_key ON items(identity_key);
      CREATE INDEX IF NOT EXISTS idx_item_aliases_lookup ON item_aliases(alias_type, alias_value);
      CREATE INDEX IF NOT EXISTS idx_rawdocs_item ON rawdocs(item_id);
      CREATE INDEX IF NOT EXISTS idx_documents_item ON documents(item_id);
      CREATE INDEX IF NOT EXISTS idx_collection_memberships_collection ON collection_memberships(collection_item_id);
      CREATE INDEX IF NOT EXISTS idx_collection_memberships_member ON collection_memberships(member_item_id);
      CREATE INDEX IF NOT EXISTS idx_batch_items_job ON batch_items(job_id);
      CREATE INDEX IF NOT EXISTS idx_batch_items_state ON batch_items(state);
    `);
  }

  // ── schema migration ───────────────────────────────────────────────────

  private migrateSchemaIfNeeded(): void {
    const userVersion = this.database!.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
    const currentVersion = userVersion?.user_version ?? 0;
    if (currentVersion >= STORE_SCHEMA_VERSION) return;

    // Version 11+: target model — drop old tables, create new ones
    if (currentVersion < 11) {
      this.database!.exec("BEGIN");
      try {
        this.createTargetTables();
        this.database!.exec(`PRAGMA user_version = ${STORE_SCHEMA_VERSION}`);
        this.database!.exec("COMMIT");
      } catch (error) {
        this.database!.exec("ROLLBACK");
        throw error;
      }
      return;
    }

    this.database!.exec(`PRAGMA user_version = ${STORE_SCHEMA_VERSION}`);
  }

  private createTargetTables(): void {
    this.database!.exec(`
      CREATE TABLE IF NOT EXISTS items (
        item_id TEXT PRIMARY KEY,
        item_type TEXT NOT NULL CHECK(item_type IN ('document', 'collection')),
        source_type TEXT NOT NULL,
        identity_key TEXT,
        title TEXT,
        subtitle TEXT,
        creators_json TEXT NOT NULL DEFAULT '[]',
        language TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL DEFAULT 'empty',
        member_visibility_mode TEXT CHECK(member_visibility_mode IN ('hide_members', 'show_members')),
        active_capture_id TEXT,
        active_doc_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        parsed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS item_aliases (
        alias_id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        alias_type TEXT NOT NULL,
        alias_value TEXT NOT NULL,
        is_primary INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        UNIQUE(alias_type, alias_value),
        FOREIGN KEY(item_id) REFERENCES items(item_id)
      );

      CREATE TABLE IF NOT EXISTS rawdocs (
        capture_id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        source_uri TEXT NOT NULL,
        source_type TEXT NOT NULL,
        input_mode TEXT NOT NULL,
        content_type TEXT,
        content_length INTEGER,
        content_hash TEXT,
        content_ext TEXT NOT NULL DEFAULT 'html',
        page_title TEXT,
        captured_at TEXT,
        fetched_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(item_id) REFERENCES items(item_id)
      );

      CREATE TABLE IF NOT EXISTS documents (
        doc_id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        capture_id TEXT NOT NULL,
        title TEXT NOT NULL,
        page_title TEXT,
        source_url TEXT,
        language TEXT,
        authors_json TEXT,
        published_at TEXT,
        parser_version TEXT NOT NULL,
        parser_method TEXT NOT NULL,
        parser_profile TEXT,
        content_hash TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(item_id) REFERENCES items(item_id),
        FOREIGN KEY(capture_id) REFERENCES rawdocs(capture_id)
      );

      CREATE TABLE IF NOT EXISTS collection_memberships (
        membership_id TEXT PRIMARY KEY,
        collection_item_id TEXT NOT NULL,
        member_item_id TEXT NOT NULL,
        order_index INTEGER NOT NULL,
        depth INTEGER NOT NULL DEFAULT 0,
        parent_membership_id TEXT,
        inclusion_mode TEXT NOT NULL DEFAULT 'manual',
        inclusion_reason TEXT,
        source_rule_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(collection_item_id) REFERENCES items(item_id),
        FOREIGN KEY(member_item_id) REFERENCES items(item_id),
        UNIQUE(collection_item_id, member_item_id)
      );

      -- Legacy tables kept for batch (will be replaced by refresh_*)

      CREATE TABLE IF NOT EXISTS batch_jobs (
        job_id TEXT PRIMARY KEY,
        collection_id TEXT,
        source_page_url TEXT NOT NULL,
        mode TEXT NOT NULL,
        state TEXT NOT NULL,
        total_count INTEGER NOT NULL,
        saved_count INTEGER NOT NULL DEFAULT 0,
        skipped_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        cancelled_count INTEGER NOT NULL DEFAULT 0,
        options_json TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS batch_items (
        item_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        collection_id TEXT,
        url TEXT NOT NULL,
        normalized_url TEXT,
        source TEXT,
        title_hint TEXT,
        state TEXT NOT NULL,
        rawdoc_id TEXT,
        doc_id TEXT,
        error_code TEXT,
        error_message TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(job_id) REFERENCES batch_jobs(job_id)
      );

      CREATE TABLE IF NOT EXISTS epub_metadata (
        item_id TEXT PRIMARY KEY,
        isbn TEXT,
        publisher TEXT,
        published_at TEXT,
        identifiers_json TEXT,
        cover_asset_id TEXT,
        chapter_count INTEGER DEFAULT 0,
        metadata_json TEXT,
        FOREIGN KEY(item_id) REFERENCES items(item_id)
      );

      CREATE TABLE IF NOT EXISTS chunks (
        chunk_id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        capture_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        title TEXT NOT NULL,
        page_title TEXT,
        source_url TEXT,
        heading_path TEXT,
        section_ids_json TEXT NOT NULL,
        text TEXT NOT NULL,
        token_estimate INTEGER,
        char_count INTEGER NOT NULL,
        parser_version TEXT,
        parser_method TEXT,
        parser_profile TEXT,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        title,
        heading_path,
        text,
        content='chunks',
        content_rowid='rowid'
      );

      CREATE TABLE IF NOT EXISTS annotations (
        annotation_id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL,
        section_id TEXT NOT NULL,
        type TEXT NOT NULL,
        text_ref TEXT,
        note TEXT,
        color TEXT,
        label TEXT,
        ai_model TEXT,
        summary_level TEXT,
        orphaned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  // ── item CRUD ──────────────────────────────────────────────────────────

  async listItems(
    sourceType?: string,
  limit = 50
  ): Promise<{ items: (KnowledgeItem & { normalizedUrl?: string })[] }> {
    await this.ensure();
    const boundedLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 500);
    let query = "SELECT i.* FROM items i WHERE i.item_type = 'document'";
    const params: string[] = [];
    if (sourceType) {
      query += " AND i.source_type = ?";
      params.push(sourceType);
    }
    query += " ORDER BY COALESCE(i.parsed_at, i.updated_at) DESC LIMIT ?";
    params.push(String(boundedLimit));
    const rows = this.database!.prepare(query).all(...params) as unknown as ItemRow[];
    return {
      items: rows.map((row) => this.buildKnowledgeItem(row))
    };
  }

  async loadItem(itemId: string): Promise<KnowledgeItem | undefined> {
    await this.ensure();
    const row = this.database!.prepare("SELECT * FROM items WHERE item_id = ?").get(itemId) as unknown as ItemRow | undefined;
    return row ? this.buildKnowledgeItem(row) : undefined;
  }

  async loadItemDetail(itemId: string): Promise<{
    item: KnowledgeItem;
    rawdoc?: RawDoc;
    document?: KnowledgeDocument;
    collectionIds?: string[];
  }> {
    await this.ensure();
    const row = this.database!.prepare("SELECT * FROM items WHERE item_id = ?").get(itemId) as unknown as ItemRow | undefined;
    if (!row) throw new Error("Item not found");
    const item = this.buildKnowledgeItem(row);
    let rawdoc: RawDoc | undefined;
    let document: KnowledgeDocument | undefined;
    if (row.active_capture_id) {
      rawdoc = await this.readJson<RawDoc>(`rawdocs/${row.active_capture_id}.json`).catch(() => undefined);
    }
    if (row.active_doc_id) {
      document = await this.readJson<KnowledgeDocument>(`documents/${row.active_doc_id}.json`).catch(() => undefined);
    }
    const collectionRows = this.database!.prepare(
      "SELECT collection_item_id FROM collection_memberships WHERE member_item_id = ?"
    ).all(itemId as string) as unknown as { collection_item_id: string }[];
    return {
      item,
      rawdoc,
      document,
      collectionIds: collectionRows.map((r) => r.collection_item_id)
    };
  }

  async deleteItem(
    itemId: string,
    mode: KnowledgeItemDeleteMode
  ): Promise<KnowledgeItemDeleteResponse> {
    await this.ensure();
    const row = this.database!.prepare("SELECT * FROM items WHERE item_id = ?").get(itemId) as unknown as ItemRow | undefined;
    if (!row) throw new Error("Item not found");
    return mode === "remove" ? this.removeItem(row) : this.purgeItem(row);
  }

  private async removeItem(row: ItemRow): Promise<KnowledgeItemDeleteResponse> {
    if (!row.active_doc_id) {
      return {
        itemId: row.item_id,
        deleted: false,
        mode: "remove",
        previousState: row.state as "captured" | "parsed",
        currentState: "captured",
        deletedFiles: []
      };
    }
    const now = new Date().toISOString();
    const deletedFiles = await this.deleteDerivedArtifacts(row.active_doc_id);
    this.database!.exec("BEGIN");
    try {
      this.database!.prepare("DELETE FROM annotations WHERE doc_id = ?").run(row.active_doc_id);
      this.database!.prepare("DELETE FROM chunks WHERE doc_id = ?").run(row.active_doc_id);
      this.database!.prepare("DELETE FROM documents WHERE doc_id = ?").run(row.active_doc_id);
      this.database!.prepare(
        "UPDATE items SET active_doc_id = NULL, state = 'captured', updated_at = ?, parsed_at = NULL WHERE item_id = ?"
      ).run(now, row.item_id);
      this.database!.exec("COMMIT");
    } catch (error) {
      this.database!.exec("ROLLBACK");
      throw error;
    }
    return {
      itemId: row.item_id,
      deleted: true,
      mode: "remove",
      previousState: "parsed",
      currentState: "captured",
      deletedFiles,
      removedDocId: row.active_doc_id
    };
  }

  private async purgeItem(row: ItemRow): Promise<KnowledgeItemDeleteResponse> {
    const deletedFiles: string[] = [];
    if (row.active_doc_id) {
      deletedFiles.push(...await this.deleteAssetsForDoc(row.active_doc_id));
      deletedFiles.push(...await this.deleteDerivedArtifacts(row.active_doc_id));
    }
    if (row.active_capture_id) {
      deletedFiles.push(...await this.deleteCaptureArtifacts(row.active_capture_id));
    }
    this.database!.exec("BEGIN");
    try {
      this.database!.prepare("DELETE FROM item_aliases WHERE item_id = ?").run(row.item_id);
      this.database!.prepare("DELETE FROM epub_metadata WHERE item_id = ?").run(row.item_id);
      this.database!.prepare("DELETE FROM collection_memberships WHERE member_item_id = ? OR collection_item_id = ?").run(row.item_id, row.item_id);
      if (row.active_doc_id) {
        this.database!.prepare("DELETE FROM annotations WHERE doc_id = ?").run(row.active_doc_id);
        this.database!.prepare("DELETE FROM chunks WHERE doc_id = ?").run(row.active_doc_id);
        this.database!.prepare("DELETE FROM documents WHERE doc_id = ?").run(row.active_doc_id);
      }
      if (row.active_capture_id) {
        this.database!.prepare("DELETE FROM rawdocs WHERE capture_id = ?").run(row.active_capture_id);
      }
      this.database!.prepare("DELETE FROM items WHERE item_id = ?").run(row.item_id);
      this.database!.exec("COMMIT");
    } catch (error) {
      this.database!.exec("ROLLBACK");
      throw error;
    }
    return {
      itemId: row.item_id,
      deleted: true,
      mode: "purge",
      previousState: row.active_doc_id ? "parsed" : "captured",
      currentState: "empty",
      deletedFiles,
      removedDocId: row.active_doc_id ?? undefined,
      removedRawdocId: row.active_capture_id ?? undefined
    };
  }

  // ── alias helpers ──────────────────────────────────────────────────────

  private findItemByAlias(aliasType: string, aliasValue: string): ItemRow | undefined {
    const aliasRow = this.database!.prepare(
      "SELECT item_id FROM item_aliases WHERE alias_type = ? AND alias_value = ?"
    ).get(aliasType, aliasValue) as { item_id: string } | undefined;
    if (!aliasRow) return undefined;
    return this.database!.prepare("SELECT * FROM items WHERE item_id = ?").get(aliasRow.item_id) as unknown as ItemRow | undefined;
  }

  private findItemByUrlLikeAlias(inputUrl: string): ItemRow | undefined {
    const normalized = normalizeUrlForKnowledge(inputUrl);
    return this.findItemByAlias("normalized_url", normalized)
      ?? this.findItemByAlias("canonical_url", normalized)
      ?? this.findItemByAlias("canonical_url", inputUrl)
      ?? this.findItemByAlias("original_url", normalized)
      ?? this.findItemByAlias("original_url", inputUrl);
  }

  private upsertAlias(itemId: string, aliasType: string, aliasValue: string, isPrimary: boolean): void {
    this.database!.prepare(`
      INSERT INTO item_aliases (alias_id, item_id, alias_type, alias_value, is_primary, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(alias_type, alias_value) DO UPDATE SET
        item_id = excluded.item_id,
        is_primary = excluded.is_primary
    `).run(makeId(), itemId, aliasType, aliasValue, isPrimary ? 1 : 0, new Date().toISOString());
  }

  private loadAliasInfo(itemId: string): ItemAliasInfo {
    const rows = this.database!.prepare(
      "SELECT alias_type, alias_value FROM item_aliases WHERE item_id = ?"
    ).all(itemId) as unknown as Pick<ItemAliasRow, "alias_type" | "alias_value">[];
    const info: ItemAliasInfo = {};
    for (const row of rows) {
      switch (row.alias_type) {
        case "normalized_url":
          info.normalizedUrl = row.alias_value;
          break;
        case "original_url":
          info.originalUrl = row.alias_value;
          break;
        case "canonical_url":
          info.canonicalUrl = row.alias_value;
          break;
        case "root_url":
          info.rootUrl = row.alias_value;
          break;
        case "normalized_root_url":
          info.normalizedRootUrl = row.alias_value;
          break;
        default:
          break;
      }
    }
    return info;
  }

  private loadActiveDocumentInfo(docId: string | null): ActiveDocumentInfo | undefined {
    if (!docId) return undefined;
    const row = this.database!.prepare(
      "SELECT page_title, title AS content_title FROM documents WHERE doc_id = ?"
    ).get(docId) as ActiveDocumentInfo | undefined;
    return row;
  }

  private buildKnowledgeItem(row: ItemRow): KnowledgeItem {
    const aliases = this.loadAliasInfo(row.item_id);
    const documentInfo = this.loadActiveDocumentInfo(row.active_doc_id);
    const contentTitle = documentInfo?.content_title ?? row.title ?? null;
    const pageTitle = documentInfo?.page_title ?? row.title ?? null;
    const normalizedUrl = aliases.normalizedUrl;
    return toKnowledgeItem(row, {
      normalizedUrl,
      originalUrl: aliases.originalUrl,
      canonicalUrl: aliases.canonicalUrl,
      pageTitle,
      contentTitle,
      displayTitle: pageTitle || contentTitle || (normalizedUrl ? tryHostnameTitle(normalizedUrl) : row.item_id)
    });
  }

  private resolveSearchNormalizedUrl(itemId: string, sourceUrl: string | null): string | undefined {
    const aliases = this.loadAliasInfo(itemId);
    if (aliases.normalizedUrl) return aliases.normalizedUrl;
    const row = this.database!.prepare("SELECT source_type FROM items WHERE item_id = ?").get(itemId) as { source_type?: string } | undefined;
    if (row?.source_type === "url" || row?.source_type === "singlefile_html") {
      return sourceUrl ?? undefined;
    }
    return itemId;
  }

  // ── save (web clip) ────────────────────────────────────────────────────

  async save(params: {
    normalizedUrl: string;
    html: string;
    rawdoc: RawDoc;
    document: KnowledgeDocument;
    markdown: string;
  }): Promise<ReturnType<typeof pathsFor>> {
    await this.ensure();
    const normalized = normalizeUrlForKnowledge(params.normalizedUrl);
    const hash = urlHash(normalized);
    const itemId = `url:sha256:${hash}`;
    const previous = this.findItemByAlias("normalized_url", normalized);
    const captureId = params.rawdoc.rawdoc_id; // keep rawdoc_id for file storage
    const docId = params.document.doc_id;
    const paths = pathsFor(docId, captureId);
    const parserInfo = parserInfoFor(params.document, params.rawdoc);
    const now = new Date().toISOString();
    const contentHash = sha256(params.markdown);
    const authorsJson = JSON.stringify(params.document.meta.authors ?? []);
    const rawMetadata = params.rawdoc.metadata ?? {};
    const contentTitle = params.document.meta.title;
    const pageTitle = pageTitleFor(params.document, params.rawdoc);
    const sourceUrl = (params.document.meta.source.url ?? params.rawdoc.source_uri) || normalized;
    const originalUrl = typeof rawMetadata.originalUrl === "string" ? rawMetadata.originalUrl : params.rawdoc.source_uri;
    const canonicalUrl = typeof rawMetadata.canonicalUrl === "string" ? rawMetadata.canonicalUrl : null;
    const replacedDocId = previous?.active_doc_id && previous.active_doc_id !== docId
      ? previous.active_doc_id : undefined;
    const replacedCaptureId = previous?.active_capture_id && previous.active_capture_id !== captureId
      ? previous.active_capture_id : undefined;

    await Promise.all([
      this.writeText(paths.rawHtmlPath, params.html),
      this.writeJson(paths.rawdocPath, params.rawdoc),
      this.writeJson(paths.documentPath, params.document),
      this.writeText(paths.markdownPath, params.markdown)
    ]);

    this.database!.exec("BEGIN");
    try {
      // items
      const nowIso = now;
      this.database!.prepare(`
        INSERT INTO items (item_id, item_type, source_type, identity_key, title, creators_json, language, tags_json, state, active_capture_id, active_doc_id, created_at, updated_at, parsed_at)
        VALUES (?, 'document', ?, ?, ?, ?, ?, ?, 'parsed', ?, ?, ?, ?, ?)
        ON CONFLICT(item_id) DO UPDATE SET
          source_type = excluded.source_type,
          identity_key = excluded.identity_key,
          title = excluded.title,
          creators_json = excluded.creators_json,
          language = excluded.language,
          tags_json = excluded.tags_json,
          state = 'parsed',
          active_capture_id = excluded.active_capture_id,
          active_doc_id = excluded.active_doc_id,
          updated_at = excluded.updated_at,
          parsed_at = excluded.parsed_at
      `).run(
        itemId, params.rawdoc.source_type, hash, pageTitle, authorsJson,
        params.document.meta.language ?? null, JSON.stringify(params.document.meta.tags ?? []),
        captureId, docId,
        previous?.created_at ?? nowIso, nowIso, nowIso
      );

      // aliases — on reparse, only update the primary normalized_url alias
      // to avoid accumulating stale canonical/original URL aliases
      this.upsertAlias(itemId, "normalized_url", normalized, true);
      if (canonicalUrl) {
        this.upsertAlias(itemId, "canonical_url", canonicalUrl, false);
      }
      if (originalUrl) {
        this.upsertAlias(itemId, "original_url", originalUrl, false);
      }

      // rawdocs
      this.database!.prepare(`
        INSERT INTO rawdocs (capture_id, item_id, source_uri, source_type, input_mode, content_type, content_length, content_hash, content_ext, page_title, captured_at, fetched_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'html', ?, ?, ?, ?)
        ON CONFLICT(capture_id) DO UPDATE SET
          item_id = excluded.item_id,
          source_uri = excluded.source_uri,
          source_type = excluded.source_type,
          input_mode = excluded.input_mode,
          content_type = excluded.content_type,
          content_length = excluded.content_length,
          content_hash = excluded.content_hash,
          page_title = excluded.page_title,
          captured_at = excluded.captured_at,
          fetched_at = excluded.fetched_at
      `).run(
        captureId, itemId, params.rawdoc.source_uri, params.rawdoc.source_type,
        (rawMetadata.inputMode as string) ?? "browser_html",
        params.rawdoc.content_type ?? null, params.rawdoc.content_length ?? null,
        params.html ? sha256(params.html) : null,
        pageTitle, params.rawdoc.fetch_time ?? null, nowIso, nowIso
      );

      // documents
      this.database!.prepare(`
        INSERT INTO documents (doc_id, item_id, capture_id, title, page_title, source_url, language, authors_json, published_at, parser_version, parser_method, parser_profile, content_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(doc_id) DO UPDATE SET
          item_id = excluded.item_id,
          capture_id = excluded.capture_id,
          title = excluded.title,
          page_title = excluded.page_title,
          source_url = excluded.source_url,
          language = excluded.language,
          authors_json = excluded.authors_json,
          published_at = excluded.published_at,
          parser_version = excluded.parser_version,
          parser_method = excluded.parser_method,
          parser_profile = excluded.parser_profile,
          content_hash = excluded.content_hash,
          updated_at = excluded.updated_at
      `).run(
        docId, itemId, captureId, contentTitle, pageTitle, sourceUrl,
        params.document.meta.language ?? null, authorsJson,
        params.document.meta.published_at ?? null,
        parserInfo.version, parserInfo.method, parserInfo.profile, contentHash, nowIso, nowIso
      );

      // chunks
      this.replaceChunks(params.document, params.rawdoc, itemId, captureId, parserInfo, nowIso);

      // Cleanup replaced versions
      if (replacedDocId && replacedDocId !== docId) {
        this.database!.prepare("DELETE FROM chunks WHERE doc_id = ?").run(replacedDocId);
        this.database!.prepare("DELETE FROM documents WHERE doc_id = ?").run(replacedDocId);
      }
      if (replacedCaptureId && replacedCaptureId !== captureId) {
        this.database!.prepare("DELETE FROM rawdocs WHERE capture_id = ?").run(replacedCaptureId);
      }

      this.database!.exec("COMMIT");
    } catch (error) {
      this.database!.exec("ROLLBACK");
      throw error;
    }

    if (replacedDocId && replacedDocId !== docId) {
      await this.deleteDerivedArtifacts(replacedDocId);
    }
    if (replacedCaptureId && replacedCaptureId !== captureId) {
      await this.deleteCaptureArtifacts(replacedCaptureId);
    }

    return paths;
  }

  // ── save import (EPUB) ─────────────────────────────────────────────────

  async saveImportItem(params: {
    itemId: string;
    sourceType: "pdf" | "epub" | "singlefile_html" | "url";
    sourceUri: string;
    rawdocId: string;
    rawdoc?: RawDoc;
    rawContentPath: string | Buffer;
    document: KnowledgeDocument;
    markdown: string;
    pageTitle?: string;
    language?: string;
    creators?: string[];
    tags?: string[];
    identityHash?: string;
    content?: string | Buffer;
    contentExt?: string;
    epubMetadata?: EpubMetadataInput;
  }): Promise<{
    knowledgeItem: KnowledgeItem;
    rawdoc: RawDoc;
    document: KnowledgeDocument;
    markdown: string;
    saved: true;
    paths: { rawContentPath: string; rawdocPath: string; documentPath: string; markdownPath: string };
  }> {
    await this.ensure();
    const captureId = params.rawdocId;
    const docId = params.document.doc_id;
    const paths = pathsFor(docId, captureId);
    const parserInfo = parserInfoFor(params.document, {} as RawDoc);
    const now = new Date().toISOString();
    const contentHash = sha256(params.markdown);
    const creators = params.creators ?? params.document.meta.authors ?? [];
    const language = params.language ?? params.document.meta.language ?? null;
    const tags = params.tags ?? params.document.meta.tags ?? [];
    const authorsJson = JSON.stringify(creators);
    const previous = this.database!.prepare("SELECT * FROM items WHERE item_id = ?").get(params.itemId) as unknown as ItemRow | undefined;
    const replacedDocId = previous?.active_doc_id && previous.active_doc_id !== docId
      ? previous.active_doc_id : undefined;
    const replacedCaptureId = previous?.active_capture_id && previous.active_capture_id !== captureId
      ? previous.active_capture_id : undefined;

    const rawdoc = params.rawdoc ?? {
      rawdoc_id: captureId,
      source_type: params.sourceType,
      source_uri: params.sourceUri,
      fetch_time: now
    };
    await Promise.all([
      this.writeJson(paths.rawdocPath, rawdoc),
      this.writeJson(paths.documentPath, params.document),
      this.writeText(paths.markdownPath, params.markdown),
      // Save raw content for reparse (EPUB/PDF import)
      ...(params.content != null
        ? [this.writeBuffer(`rawdocs/${captureId}.${params.sourceType}`, Buffer.isBuffer(params.content) ? params.content : Buffer.from(params.content))]
        : [])
    ]);

    this.database!.exec("BEGIN");
    try {
      this.database!.prepare(`
        INSERT INTO items (item_id, item_type, source_type, identity_key, title, creators_json, language, tags_json, state, active_capture_id, active_doc_id, created_at, updated_at, parsed_at)
        VALUES (?, 'document', ?, ?, ?, ?, ?, ?, 'parsed', ?, ?, ?, ?, ?)
        ON CONFLICT(item_id) DO UPDATE SET
          source_type = excluded.source_type,
          title = excluded.title,
          creators_json = excluded.creators_json,
          language = excluded.language,
          tags_json = excluded.tags_json,
          state = 'parsed',
          active_capture_id = excluded.active_capture_id,
          active_doc_id = excluded.active_doc_id,
          updated_at = excluded.updated_at,
          parsed_at = excluded.parsed_at
      `).run(
        params.itemId, params.sourceType, params.identityHash ?? null, params.pageTitle ?? params.document.meta.title,
        authorsJson, language, JSON.stringify(tags),
        captureId, docId, previous?.created_at ?? now, now, now
      );

      this.database!.prepare(`
        INSERT INTO rawdocs (capture_id, item_id, source_uri, source_type, input_mode, content_type, content_length, content_hash, content_ext, page_title, captured_at, created_at)
        VALUES (?, ?, ?, ?, 'file_import', NULL, NULL, NULL, ?, ?, ?, ?)
        ON CONFLICT(capture_id) DO UPDATE SET
          item_id = excluded.item_id,
          source_uri = excluded.source_uri,
          source_type = excluded.source_type
      `).run(
        captureId, params.itemId, params.sourceUri, params.sourceType,
        params.sourceType === "epub" ? "epub" : "pdf",
        params.pageTitle ?? null, now, now
      );

      this.database!.prepare(`
        INSERT INTO documents (doc_id, item_id, capture_id, title, page_title, source_url, language, authors_json, published_at, parser_version, parser_method, parser_profile, content_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(doc_id) DO UPDATE SET
          item_id = excluded.item_id,
          capture_id = excluded.capture_id,
          title = excluded.title,
          page_title = excluded.page_title,
          language = excluded.language,
          authors_json = excluded.authors_json,
          parser_version = excluded.parser_version,
          parser_method = excluded.parser_method,
          parser_profile = excluded.parser_profile,
          content_hash = excluded.content_hash,
          updated_at = excluded.updated_at
      `).run(
        docId, params.itemId, captureId, params.document.meta.title,
        params.pageTitle ?? null, language, authorsJson,
        parserInfo.version, parserInfo.method, parserInfo.profile, contentHash, now, now
      );

      this.replaceChunks(params.document, { rawdoc_id: captureId, source_type: params.sourceType } as RawDoc, params.itemId, captureId, parserInfo, now);

      // Cleanup replaced versions
      if (replacedDocId) {
        this.database!.prepare("DELETE FROM chunks WHERE doc_id = ?").run(replacedDocId);
        this.database!.prepare("DELETE FROM documents WHERE doc_id = ?").run(replacedDocId);
      }
      if (replacedCaptureId) {
        this.database!.prepare("DELETE FROM rawdocs WHERE capture_id = ?").run(replacedCaptureId);
      }

      if (params.epubMetadata) {
        this.upsertEpubMetadata(params.itemId, params.epubMetadata);
      }

      if (params.sourceType === "url" || params.sourceType === "singlefile_html") {
        const normalizedUrl = normalizeUrlForKnowledge(params.sourceUri);
        this.upsertAlias(params.itemId, "normalized_url", normalizedUrl, true);
      }

      this.database!.exec("COMMIT");
    } catch (error) {
      this.database!.exec("ROLLBACK");
      throw error;
    }

    // Create file_path alias for EPUB/PDF imports so they're findable
    this.upsertAlias(params.itemId, "file_path", params.sourceUri, true);

    const item = this.buildKnowledgeItem(
      this.database!.prepare("SELECT * FROM items WHERE item_id = ?").get(params.itemId) as unknown as ItemRow
    );
    const returnedRawdoc: RawDoc = rawdoc;
    const storedRawContentPath = params.content != null
      ? `rawdocs/${captureId}.${params.contentExt ?? params.sourceType}`
      : String(params.rawContentPath);
    return {
      knowledgeItem: item!,
      rawdoc: returnedRawdoc,
      document: params.document,
      markdown: params.markdown,
      saved: true,
      paths: { rawContentPath: storedRawContentPath, rawdocPath: paths.rawdocPath, documentPath: paths.documentPath, markdownPath: paths.markdownPath }
    };
  }

  // ── reparse ────────────────────────────────────────────────────────────

  async saveReparseResult(params: {
    itemId: string;
    sourceType: string;
    sourceUri: string;
    rawdocId: string;
    rawdoc: RawDoc;
    document: KnowledgeDocument;
    markdown: string;
    pageTitle?: string;
    language?: string;
    creators?: string[];
    tags?: string[];
    identityHash?: string;
    epubMetadata?: EpubMetadataInput;
  }): Promise<{
    knowledgeItem: KnowledgeItem;
    rawdoc: RawDoc;
    document: KnowledgeDocument;
    markdown: string;
    saved: true;
    paths: { rawContentPath: string; rawdocPath: string; documentPath: string; markdownPath: string };
  }> {
    await this.ensure();
    const captureId = params.rawdocId;
    const docId = params.document.doc_id;
    const paths = pathsFor(docId, captureId);
    const parserInfo = parserInfoFor(params.document, {} as RawDoc);
    const now = new Date().toISOString();
    const contentHash = sha256(params.markdown);
    const creators = params.creators ?? params.document.meta.authors ?? [];
    const language = params.language ?? params.document.meta.language ?? null;
    const tags = params.tags ?? params.document.meta.tags ?? [];
    const authorsJson = JSON.stringify(creators);
    const previous = this.database!.prepare("SELECT * FROM items WHERE item_id = ?").get(params.itemId) as unknown as ItemRow | undefined;
    const replacedDocId = previous?.active_doc_id && previous.active_doc_id !== docId
      ? previous.active_doc_id : undefined;

    // Write updated derived files only — raw content is already on disk unchanged.
    await Promise.all([
      this.writeJson(paths.rawdocPath, params.rawdoc),
      this.writeJson(paths.documentPath, params.document),
      this.writeText(paths.markdownPath, params.markdown)
    ]);

    this.database!.exec("BEGIN");
    try {
      this.database!.prepare(`
        INSERT INTO items (item_id, item_type, source_type, identity_key, title, creators_json, language, tags_json, state, active_capture_id, active_doc_id, created_at, updated_at, parsed_at)
        VALUES (?, 'document', ?, ?, ?, ?, ?, ?, 'parsed', ?, ?, ?, ?, ?)
        ON CONFLICT(item_id) DO UPDATE SET
          source_type = excluded.source_type,
          title = excluded.title,
          creators_json = excluded.creators_json,
          language = excluded.language,
          tags_json = excluded.tags_json,
          state = 'parsed',
          active_capture_id = excluded.active_capture_id,
          active_doc_id = excluded.active_doc_id,
          updated_at = excluded.updated_at,
          parsed_at = excluded.parsed_at
      `).run(
        params.itemId, params.sourceType, params.identityHash ?? null, params.pageTitle ?? params.document.meta.title,
        authorsJson, language, JSON.stringify(tags),
        captureId, docId, previous?.created_at ?? now, now, now
      );

      this.database!.prepare(`
        INSERT INTO documents (doc_id, item_id, capture_id, title, page_title, source_url, language, authors_json, published_at, parser_version, parser_method, parser_profile, content_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(doc_id) DO UPDATE SET
          item_id = excluded.item_id,
          capture_id = excluded.capture_id,
          title = excluded.title,
          page_title = excluded.page_title,
          language = excluded.language,
          authors_json = excluded.authors_json,
          parser_version = excluded.parser_version,
          parser_method = excluded.parser_method,
          parser_profile = excluded.parser_profile,
          content_hash = excluded.content_hash,
          updated_at = excluded.updated_at
      `).run(
        docId, params.itemId, captureId, params.document.meta.title,
        params.pageTitle ?? null, language, authorsJson,
        parserInfo.version, parserInfo.method, parserInfo.profile, contentHash, now, now
      );

      this.replaceChunks(params.document, { rawdoc_id: captureId, source_type: params.sourceType } as RawDoc, params.itemId, captureId, parserInfo, now);

      // Cleanup replaced doc version
      if (replacedDocId) {
        this.database!.prepare("DELETE FROM chunks WHERE doc_id = ?").run(replacedDocId);
        this.database!.prepare("DELETE FROM documents WHERE doc_id = ?").run(replacedDocId);
      }

      if (params.epubMetadata) {
        this.upsertEpubMetadata(params.itemId, params.epubMetadata);
      }

      if (params.sourceType === "url" || params.sourceType === "singlefile_html") {
        const normalizedUrl = normalizeUrlForKnowledge(params.sourceUri);
        this.upsertAlias(params.itemId, "normalized_url", normalizedUrl, true);
      }

      this.database!.exec("COMMIT");
    } catch (error) {
      this.database!.exec("ROLLBACK");
      throw error;
    }

    // Derive rawContentPath from existing file — raw content is never rewritten on reparse.
    const rawContentExt = params.sourceType === "epub" ? "epub" : params.sourceType === "pdf" ? "pdf" : "html";
    const rawContentPath = `rawdocs/${captureId}.${rawContentExt}`;

    const item = this.buildKnowledgeItem(
      this.database!.prepare("SELECT * FROM items WHERE item_id = ?").get(params.itemId) as unknown as ItemRow
    );
    return {
      knowledgeItem: item!,
      rawdoc: params.rawdoc,
      document: params.document,
      markdown: params.markdown,
      saved: true,
      paths: { rawContentPath, rawdocPath: paths.rawdocPath, documentPath: paths.documentPath, markdownPath: paths.markdownPath }
    };
  }

  // ── reparse helpers ────────────────────────────────────────────────────

  async loadCaptureByUrl(inputUrl: string): Promise<{ clip: KnowledgeItem; html: string; rawdoc: RawDoc; itemId: string }> {
    await this.ensure();
    const row = this.findItemByUrlLikeAlias(inputUrl);
    if (!row || !row.active_capture_id) {
      throw new Error("Capture does not exist for this URL");
    }
    const html = await this.readText(`rawdocs/${row.active_capture_id}.html`);
    const rawdoc = JSON.parse(await this.readText(`rawdocs/${row.active_capture_id}.json`)) as RawDoc;
    return { clip: this.buildKnowledgeItem(row), html, rawdoc, itemId: row.item_id };
  }

  async loadRawContentForItem(itemId: string): Promise<{ item: KnowledgeItem; html: string; rawdoc: RawDoc; content: string; contentExt: string }> {
    await this.ensure();
    const row = this.database!.prepare("SELECT * FROM items WHERE item_id = ?").get(itemId) as unknown as ItemRow | undefined;
    if (!row || !row.active_capture_id) {
      throw new Error("Item has no active capture");
    }
    const captureId = row.active_capture_id;
    const rawdoc = JSON.parse(await this.readText(`rawdocs/${captureId}.json`)) as RawDoc;

    // EPUB/PDF: read raw binary from .epub/.pdf, return as Buffer for reparse
    if (rawdoc.source_type === "epub" || rawdoc.source_type === "pdf") {
      const ext = rawdoc.source_type;
      const bin = await readFile(resolveInsideRoot(this.root, `rawdocs/${captureId}.${ext}`));
      return {
        item: this.buildKnowledgeItem(row) as KnowledgeItem,
        html: "",
        rawdoc,
        content: bin.toString("base64"),
        contentExt: ext
      };
    }

    const html = await this.readText(`rawdocs/${captureId}.html`);
    return { item: this.buildKnowledgeItem(row) as KnowledgeItem, html, rawdoc, content: html, contentExt: "html" };
  }

  // ── collection membership ──────────────────────────────────────────────

  async replaceCollectionMembers(collectionItemId: string, members: Array<{
    memberItemId: string;
    orderIndex: number;
    depth: number;
    inclusionMode?: string;
    inclusionReason?: string;
  }>): Promise<CollectionItem[]> {
    await this.ensure();
    const now = new Date().toISOString();
    this.database!.exec("BEGIN");
    try {
      this.database!.prepare("DELETE FROM collection_memberships WHERE collection_item_id = ?").run(collectionItemId);
      const insert = this.database!.prepare(`
        INSERT INTO collection_memberships (membership_id, collection_item_id, member_item_id, order_index, depth, inclusion_mode, inclusion_reason, source_rule_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `);
      for (const m of members) {
        insert.run(
          makeId(), collectionItemId, m.memberItemId, m.orderIndex, m.depth,
          m.inclusionMode ?? "manual", m.inclusionReason ?? null, now, now
        );
      }
      if (members.length > 0) {
        this.database!.prepare(
          "UPDATE items SET state = 'active', updated_at = ? WHERE item_id = ?"
        ).run(now, collectionItemId);
      }
      this.database!.exec("COMMIT");
    } catch (error) {
      this.database!.exec("ROLLBACK");
      throw error;
    }
    return this.loadCollectionMembers(collectionItemId);
  }

  async loadCollection(
    collectionItemId: string
  ): Promise<{ collection: CollectionSummary; items: CollectionItemDetail[] }> {
    await this.ensure();
    const collection = this.loadCollectionSummary(collectionItemId);
    const items = await this.loadCollectionMembers(collectionItemId);
    return { collection, items };
  }

  private async loadCollectionMembers(collectionItemId: string): Promise<CollectionItemDetail[]> {
    const rows = this.database!.prepare(`
      SELECT
        cm.membership_id,
        cm.collection_item_id AS collection_id,
        COALESCE(i.item_id, cm.member_item_id) AS item_id,
        COALESCE((
          SELECT alias_value
          FROM item_aliases ia
          WHERE ia.item_id = i.item_id AND ia.alias_type = 'normalized_url'
          LIMIT 1
        ), '') AS normalized_url,
        i.active_doc_id AS doc_id,
        i.active_capture_id AS rawdoc_id,
        i.title,
        NULL AS page_title,
        cm.order_index,
        cm.depth,
        cm.parent_membership_id,
        cm.inclusion_reason AS source,
        'saved' AS state,
        i.creators_json,
        i.language,
        cm.created_at,
        i.updated_at
      FROM collection_memberships cm
      LEFT JOIN items i ON i.item_id = cm.member_item_id
      WHERE cm.collection_item_id = ?
      ORDER BY cm.order_index ASC, cm.created_at ASC
    `).all(collectionItemId) as unknown as (CollectionMembershipRow & {
      collection_id: string;
      item_id: string;
      normalized_url: string;
      doc_id: string | null;
      rawdoc_id: string | null;
      title: string | null;
      page_title: null;
      order_index: number;
      depth: number;
      parent_membership_id: string | null;
      source: string | null;
      state: string;
      creators_json: string | null;
      language: string | null;
      created_at: string;
      updated_at: string | null;
    })[];

    return rows.map((row) => {
      const titles = titleFields(null, row.title, row.normalized_url || "");
      return {
        collectionItemId: row.membership_id,
        collectionId: row.collection_id,
        itemId: row.item_id,
        normalizedUrl: row.normalized_url,
        docId: row.doc_id ?? undefined,
        rawdocId: row.rawdoc_id ?? undefined,
        ...titles,
        orderIndex: row.order_index,
        depth: row.depth,
        parentItemId: row.parent_membership_id ?? undefined,
        source: row.source ?? undefined,
        state: row.state as BatchItemState,
        creators: safeJsonArray(row.creators_json ?? "[]"),
        language: row.language ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at ?? row.created_at
      };
    });
  }

  async getCollectionsForItem(itemId: string): Promise<string[]> {
    await this.ensure();
    const rows = this.database!.prepare(
      "SELECT collection_item_id FROM collection_memberships WHERE member_item_id = ?"
    ).all(itemId as string) as unknown as { collection_item_id: string }[];
    return rows.map((r) => r.collection_item_id);
  }

  async getCollectionNavigation(
    collectionItemId: string,
    itemId: string
  ): Promise<{
    previous: { docId?: string; itemId: string; title?: string; normalizedUrl?: string } | null;
    next: { docId?: string; itemId: string; title?: string; normalizedUrl?: string } | null;
  }> {
    await this.ensure();
    const memberships = this.database!.prepare(
      "SELECT member_item_id, order_index FROM collection_memberships WHERE collection_item_id = ? ORDER BY order_index ASC"
    ).all(collectionItemId) as { member_item_id: string; order_index: number }[];
    const idx = memberships.findIndex((m) => m.member_item_id === itemId);
    if (idx < 0) return { previous: null, next: null };

    const toNav = (m: { member_item_id: string; order_index: number }) => {
      const item = this.database!.prepare("SELECT item_id, title, active_doc_id FROM items WHERE item_id = ?").get(m.member_item_id) as unknown as Pick<ItemRow, "item_id" | "title" | "active_doc_id"> | undefined;
      const alias = this.database!.prepare(
        "SELECT alias_value FROM item_aliases WHERE item_id = ? AND alias_type = 'normalized_url' LIMIT 1"
      ).get(m.member_item_id) as { alias_value: string } | undefined;
      return item ? {
        itemId: item.item_id,
        title: item.title ?? undefined,
        normalizedUrl: alias?.alias_value,
        docId: item.active_doc_id ?? undefined
      } : { itemId: m.member_item_id };
    };

    return {
      previous: idx > 0 ? toNav(memberships[idx - 1]) : null,
      next: idx < memberships.length - 1 ? toNav(memberships[idx + 1]) : null
    };
  }

  async getUsedCollectionMemberDocIds(): Promise<{ docIds: string[] }> {
    await this.ensure();
    const rows = this.database!.prepare(
      "SELECT DISTINCT i.active_doc_id FROM collection_memberships cm JOIN items i ON i.item_id = cm.member_item_id WHERE i.active_doc_id IS NOT NULL"
    ).all() as { active_doc_id: string }[];
    return { docIds: rows.map((r) => r.active_doc_id) };
  }

  // ── collection item CRUD ───────────────────────────────────────────────

  async upsertCollection(params: {
    collectionId?: string;
    title: string;
    sourceType?: string;
    rootUrl?: string;
    normalizedRootUrl?: string;
  }): Promise<{ collectionId: string; collection: CollectionSummary }> {
    await this.ensure();
    const now = new Date().toISOString();
    const normalizedRootUrl = params.normalizedRootUrl
      ?? (params.rootUrl ? normalizeUrlForKnowledge(params.rootUrl) : undefined);
    const identityKey = normalizedRootUrl ? urlHash(normalizedRootUrl) : null;

    // Deduplicate by identity_key when creating a new collection — same source
    // page should map to the same collection, preventing duplicates from
    // double-clicks or repeated batch saves.
    if (!params.collectionId && identityKey) {
      const existing = this.database!.prepare(
        "SELECT item_id FROM items WHERE item_type = 'collection' AND identity_key = ? LIMIT 1"
      ).get(identityKey) as { item_id: string } | undefined;
      if (existing) {
        // Reuse existing collection, update title in case it changed.
        this.database!.prepare(
          "UPDATE items SET title = ?, updated_at = ? WHERE item_id = ?"
        ).run(params.title, now, existing.item_id);
        return { collectionId: existing.item_id, collection: this.loadCollectionSummary(existing.item_id) };
      }
    }

    const id = params.collectionId ?? (identityKey ? `col:sha256:${identityKey}` : makeId());
    this.database!.prepare(`
      INSERT INTO items (item_id, item_type, source_type, identity_key, title, creators_json, tags_json, state, member_visibility_mode, created_at, updated_at)
      VALUES (?, 'collection', ?, ?, ?, '[]', '[]', 'active', 'show_members', ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET
        title = excluded.title,
        identity_key = excluded.identity_key,
        updated_at = excluded.updated_at
    `).run(id, params.sourceType ?? "virtual_collection", identityKey, params.title, now, now);
    if (params.rootUrl) {
      this.upsertAlias(id, "root_url", params.rootUrl, true);
    }
    if (normalizedRootUrl) {
      this.upsertAlias(id, "normalized_root_url", normalizedRootUrl, true);
    }
    return { collectionId: id, collection: this.loadCollectionSummary(id) };
  }

  private loadCollectionSummary(collectionItemId: string): CollectionSummary {
    const row = this.database!.prepare(
      "SELECT item_id, title, identity_key, source_type, state, created_at, updated_at FROM items WHERE item_id = ? AND item_type = 'collection'"
    ).get(collectionItemId) as unknown as ItemRow | undefined;
    if (!row) throw new Error("Collection not found");
    const memberCount = (this.database!.prepare(
      "SELECT COUNT(*) AS count FROM collection_memberships WHERE collection_item_id = ?"
    ).get(collectionItemId) as unknown as { count: number }).count;
    const aliases = this.loadAliasInfo(collectionItemId);
    return {
      collectionId: row.item_id,
      title: row.title ?? "",
      rootUrl: aliases.rootUrl ?? aliases.normalizedRootUrl,
      normalizedRootUrl: aliases.normalizedRootUrl,
      sourceType: row.source_type,
      state: row.state as CollectionState,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      itemCount: memberCount
    };
  }

  async listCollections(limit = 50): Promise<{ collections: CollectionSummary[] }> {
    await this.ensure();
    const rows = this.database!.prepare(
      "SELECT item_id FROM items WHERE item_type = 'collection' ORDER BY updated_at DESC LIMIT ?"
    ).all(Math.min(Math.max(Math.trunc(limit) || 50, 1), 200)) as { item_id: string }[];
    const collections = rows.map((r) => this.loadCollectionSummary(r.item_id));
    return { collections };
  }

  async checkCollectionName(title: string): Promise<{ exists: boolean }> {
    await this.ensure();
    const row = this.database!.prepare(
      "SELECT item_id FROM items WHERE item_type = 'collection' AND title = ?"
    ).get(title.trim()) as { item_id: string } | undefined;
    return { exists: Boolean(row) };
  }

  async deleteCollection(collectionItemId: string): Promise<{ deleted: boolean; collectionId: string }> {
    await this.ensure();
    this.database!.exec("BEGIN");
    try {
      this.database!.prepare("DELETE FROM collection_memberships WHERE collection_item_id = ?").run(collectionItemId);
      this.database!.prepare("DELETE FROM item_aliases WHERE item_id = ?").run(collectionItemId);
      this.database!.prepare("DELETE FROM items WHERE item_id = ?").run(collectionItemId);
      this.database!.exec("COMMIT");
    } catch (error) {
      this.database!.exec("ROLLBACK");
      throw error;
    }
    return { deleted: true, collectionId: collectionItemId };
  }

  // ── backward-compat wrappers for server.ts ────────────────────────────

  async status(inputUrl: string): Promise<KnowledgeItem | null> {
    await this.ensure();
    const row = this.findItemByUrlLikeAlias(inputUrl);
    if (!row) return null;
    return this.buildKnowledgeItem(row);
  }

  async list(limit = 50): Promise<KnowledgeItem[]> {
    await this.ensure();
    const result = await this.listItems(undefined, limit);
    return result.items;
  }

  async deleteByUrl(inputUrl: string, mode: KnowledgeItemDeleteMode): Promise<KnowledgeItemDeleteResponse> {
    await this.ensure();
    const row = this.findItemByUrlLikeAlias(inputUrl);
    if (!row) throw new Error("Item not found for this URL");
    return this.deleteItem(row.item_id, mode);
  }

  async replaceCollectionItems(collectionId: string, items: Array<{
    normalizedUrl: string;
    title?: string;
    pageTitle?: string;
    source?: string;
    orderIndex: number;
    depth: number;
    state?: string;
  }>): Promise<CollectionItem[]> {
    await this.ensure();
    const now = new Date().toISOString();
    for (const item of items) {
      const hash = urlHash(item.normalizedUrl);
      const memberItemId = `url:sha256:${hash}`;
      this.database!.prepare(`
        INSERT INTO items (item_id, item_type, source_type, identity_key, title, creators_json, tags_json, state, active_capture_id, active_doc_id, created_at, updated_at)
        VALUES (?, 'document', 'url', ?, ?, '[]', '[]', 'captured', NULL, NULL, ?, ?)
        ON CONFLICT(item_id) DO NOTHING
      `).run(memberItemId, hash, item.title ?? item.pageTitle ?? null, now, now);
      this.upsertAlias(memberItemId, "normalized_url", item.normalizedUrl, true);
    }
    const members = items.map((item, index) => ({
      memberItemId: `url:sha256:${urlHash(item.normalizedUrl)}`,
      orderIndex: item.orderIndex ?? index,
      depth: item.depth ?? 0,
      inclusionMode: "manual"
    }));
    return this.replaceCollectionMembers(collectionId, members);
  }

  async getCollectionsByDocId(docId: string): Promise<{ collections: Array<{ collectionId: string; title: string }> }> {
    await this.ensure();
    const docRow = this.database!.prepare("SELECT item_id FROM documents WHERE doc_id = ?").get(docId) as { item_id: string } | undefined;
    if (!docRow) return { collections: [] };
    const rows = this.database!.prepare(
      "SELECT cm.collection_item_id, i.title FROM collection_memberships cm JOIN items i ON i.item_id = cm.collection_item_id WHERE cm.member_item_id = ?"
    ).all(docRow.item_id) as { collection_item_id: string; title: string | null }[];
    return { collections: rows.map((r) => ({ collectionId: r.collection_item_id, title: r.title ?? "" })) };
  }

  async getUsedCollectionDocIds(): Promise<{ docIds: string[] }> {
    return this.getUsedCollectionMemberDocIds();
  }

  // ── epub metadata ──────────────────────────────────────────────────────

  private upsertEpubMetadata(itemId: string, input: EpubMetadataInput): void {
    this.database!.prepare(`
      INSERT INTO epub_metadata (item_id, isbn, publisher, published_at, identifiers_json, cover_asset_id, chapter_count, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET
        isbn = excluded.isbn,
        publisher = excluded.publisher,
        published_at = excluded.published_at,
        identifiers_json = excluded.identifiers_json,
        cover_asset_id = excluded.cover_asset_id,
        chapter_count = excluded.chapter_count,
        metadata_json = excluded.metadata_json
    `).run(
      itemId,
      input.isbn ?? null,
      input.publisher ?? null,
      input.publishedAt ?? null,
      JSON.stringify(input.identifiers ?? {}),
      input.coverAssetId ?? null,
      input.chapterCount ?? 0,
      JSON.stringify(input.metadata ?? {})
    );
  }

  // ── document loading ───────────────────────────────────────────────────

  async loadDocument(docId: string): Promise<KnowledgeDocument | undefined> {
    await this.ensure();
    return this.readJson<KnowledgeDocument>(`documents/${docId}.json`).catch(() => undefined);
  }

  async loadMarkdown(docId: string): Promise<string> {
    await this.ensure();
    return this.readText(`markdown/${docId}.md`);
  }

  async loadAsset(assetId: string): Promise<{ path: string; contentType: string; bytes: Buffer }> {
    const assetPath = resolveInsideRoot(this.root, `assets/${assetId}`);
    const bytes = await readFile(assetPath);
    const contentType = guessContentType(assetId);
    return { path: assetPath, contentType, bytes };
  }

  async prepareDocumentAssets(document: KnowledgeDocument): Promise<KnowledgeDocument> {
    await this.ensure();
    const next: KnowledgeDocument = JSON.parse(JSON.stringify(document)) as KnowledgeDocument;
    let firstAssetId: string | undefined;
    for (const section of next.sections) {
      for (const asset of section.assets ?? []) {
        if (!asset.path || !isAbsolute(asset.path)) continue;
        const bytes = await readFile(asset.path).catch(() => undefined);
        if (!bytes) continue;
        const extension = sanitizeExtension(extname(asset.path)) || "bin";
        const assetId = `${sha256Buffer(bytes).slice(0, 16)}.${extension}`;
        const target = resolveInsideRoot(this.root, `assets/${assetId}`);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(asset.path, target).catch(async (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
        asset.asset_id = assetId;
        asset.path = `assets/${assetId}`;
        firstAssetId ??= assetId;
      }
    }
    next.meta.cover_asset_id ??= firstAssetId;
    next.meta.statistics = computeDocumentStatistics(next);
    return next;
  }

  // ── batch (legacy, will be replaced by refresh_* ) ────────────────────

  async recoverStaleJobs(): Promise<number> {
    await this.ensure();
    const result = this.database!.prepare(
      "UPDATE batch_jobs SET state = 'failed' WHERE state = 'running'"
    ).run();
    this.database!.prepare(
      "UPDATE batch_items SET state = 'failed', error_code = 'stale', error_message = 'Job was interrupted', updated_at = ? WHERE state IN ('fetching', 'parsing', 'saving')"
    ).run(new Date().toISOString());
    return Number(result.changes);
  }

  async resetFailedBatchItems(jobId: string): Promise<number> {
    await this.ensure();
    const result = this.database!.prepare(
      "UPDATE batch_items SET state = 'pending', error_code = NULL, error_message = NULL, updated_at = ? WHERE job_id = ? AND state = 'failed'"
    ).run(new Date().toISOString(), jobId);
    return Number(result.changes);
  }

  async createBatchJob(params: {
    sourcePageUrl: string;
    collectionId?: string;
    mode: string;
    totalCount: number;
    items?: Array<{
      url: string;
      normalizedUrl: string;
      source?: string;
      titleHint?: string;
    }>;
    options?: Record<string, unknown>;
  }): Promise<{ jobId: string }> {
    await this.ensure();
    const jobId = makeId();
    const now = new Date().toISOString();
    this.database!.prepare(`
      INSERT INTO batch_jobs (job_id, collection_id, source_page_url, mode, state, total_count, options_json, created_at)
      VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)
    `).run(jobId, params.collectionId ?? null, params.sourcePageUrl, params.mode, params.totalCount, params.options ? JSON.stringify(params.options) : null, now);
    if (params.items?.length) {
      const insertItem = this.database!.prepare(`
        INSERT INTO batch_items (item_id, job_id, collection_id, url, normalized_url, source, title_hint, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `);
      for (const item of params.items) {
        insertItem.run(makeId(), jobId, params.collectionId ?? null, item.url, item.normalizedUrl, item.source ?? null, item.titleHint ?? null, now, now);
      }
    }
    return { jobId };
  }

  async listPendingBatchItems(jobId: string): Promise<BatchJobItem[]> {
    await this.ensure();
    const rows = this.database!.prepare(
      "SELECT * FROM batch_items WHERE job_id = ? AND state = 'pending' ORDER BY created_at ASC"
    ).all(jobId) as unknown as BatchItemRow[];
    return rows.map(toBatchJobItem);
  }

  async loadBatchJob(jobId: string): Promise<BatchJobResponse> {
    await this.ensure();
    const job = this.database!.prepare("SELECT * FROM batch_jobs WHERE job_id = ?").get(jobId) as BatchJobRow | undefined;
    if (!job) throw new Error("Batch job not found");
    const items = this.database!.prepare(
      "SELECT * FROM batch_items WHERE job_id = ? ORDER BY created_at ASC"
    ).all(jobId) as unknown as BatchItemRow[];
    return {
      collectionId: job.collection_id ?? undefined,
      jobId: job.job_id,
      state: job.state,
      total: job.total_count,
      saved: job.saved_count,
      skipped: job.skipped_count,
      failed: job.failed_count,
      cancelled: job.cancelled_count,
      items: items.map(toBatchJobItem)
    };
  }

  async updateBatchJobState(jobId: string, state: BatchJobState): Promise<void> {
    await this.ensure();
    const updates: Record<string, string | null> = { state };
    if (state === "running") updates.started_at = new Date().toISOString();
    if (state === "succeeded" || state === "failed" || state === "cancelled") updates.finished_at = new Date().toISOString();
    const setClauses = Object.entries(updates).map(([k]) => `${k} = ?`).join(", ");
    this.database!.prepare(`UPDATE batch_jobs SET ${setClauses} WHERE job_id = ?`).run(...Object.values(updates), jobId);
  }

  async updateBatchItem(params: {
    itemId: string;
    state?: BatchItemState;
    normalizedUrl?: string;
    rawdocId?: string;
    docId?: string;
    errorCode?: string;
    errorMessage?: string;
    incrementAttempt?: boolean;
  }): Promise<void> {
    await this.ensure();
    const sets: string[] = ["updated_at = ?"];
    const values: unknown[] = [new Date().toISOString()];
    if (params.state) { sets.push("state = ?"); values.push(params.state); }
    if (params.normalizedUrl) { sets.push("normalized_url = ?"); values.push(params.normalizedUrl); }
    if (params.rawdocId) { sets.push("rawdoc_id = ?"); values.push(params.rawdocId); }
    if (params.docId) { sets.push("doc_id = ?"); values.push(params.docId); }
    if (params.errorCode) { sets.push("error_code = ?"); values.push(params.errorCode); }
    if (params.errorMessage) { sets.push("error_message = ?"); values.push(params.errorMessage); }
    if (params.incrementAttempt) sets.push("attempt_count = attempt_count + 1");
    values.push(params.itemId);
    this.database!.prepare(`UPDATE batch_items SET ${sets.join(", ")} WHERE item_id = ?`).run(...values as string[]);
    // Update job counters
    if (params.state === "saved") {
      this.database!.prepare("UPDATE batch_jobs SET saved_count = saved_count + 1 WHERE job_id = (SELECT job_id FROM batch_items WHERE item_id = ?)").run(params.itemId);
    } else if (params.state === "skipped") {
      this.database!.prepare("UPDATE batch_jobs SET skipped_count = skipped_count + 1 WHERE job_id = (SELECT job_id FROM batch_items WHERE item_id = ?)").run(params.itemId);
    } else if (params.state === "failed") {
      this.database!.prepare("UPDATE batch_jobs SET failed_count = failed_count + 1 WHERE job_id = (SELECT job_id FROM batch_items WHERE item_id = ?)").run(params.itemId);
    } else if (params.state === "cancelled") {
      this.database!.prepare("UPDATE batch_jobs SET cancelled_count = cancelled_count + 1 WHERE job_id = (SELECT job_id FROM batch_items WHERE item_id = ?)").run(params.itemId);
    }
  }

  // ── search / context ───────────────────────────────────────────────────

  async search(query: string, options: SearchOptions = {}): Promise<SearchResultItem[]> {
    await this.ensure();
    const trimmed = query.trim();
    if (!trimmed) return [];
    const searchResults = this.searchChunks(trimmed, options);
    const results = await Promise.all(searchResults.map(async (c) => {
      const normalizedUrl = this.resolveSearchNormalizedUrl(c.item_id, c.source_url ?? null);
      return {
        chunkId: c.chunk_id,
        docId: c.doc_id,
        rawdocId: c.capture_id,
        sectionIds: safeJsonArray(c.section_ids_json ?? "[]"),
        title: c.title,
        pageTitle: c.page_title ?? undefined,
        contentTitle: c.title,
        displayTitle: c.page_title ?? c.title,
        sourceUrl: c.source_url ?? undefined,
        normalizedUrl,
        headingPath: c.heading_path ?? undefined,
        snippet: c.text.slice(0, 300),
        score: c.score ?? 0,
        parserVersion: c.parser_version ?? undefined,
        parserMethod: c.parser_method ?? undefined,
        parserProfile: c.parser_profile ?? undefined,
        ...(options.trace ? { trace: this.buildTrace(query, c) } : {})
      };
    }));
    return results;
  }

  async retrieveContext(query: string, options: ContextOptions = {}): Promise<ContextPackResponse> {
    await this.ensure();
    const trimmed = query.trim();
    const maxChars = options.maxChars ?? 6000;
    if (!trimmed) {
      return {
        query: "",
        retriever: "sqlite_fts",
        packer: "section_chunk_v1",
        budget: { maxChars, usedChars: 0 },
        contextText: "",
        citations: []
      };
    }
    const searchResults = this.searchChunks(trimmed, { ...options, limit: options.limit ?? 10 }) as unknown as SearchChunkRow[];
    let usedChars = 0;
    const citations: ContextCitation[] = [];
    for (const c of searchResults) {
      const normalizedUrl = this.resolveSearchNormalizedUrl(c.item_id, c.source_url ?? null);
      const baseContent = c.text.length > 800 ? c.text.slice(0, 800) + CONTEXT_TRUNCATION_SUFFIX : c.text;
      const marker: string = `[${citations.length + 1}]`;
      const displayTitle = c.page_title ?? c.title;
      const sourceLabel = c.source_url ?? "unknown";
      const prefix = `${marker} ${displayTitle}\nSource: ${sourceLabel}\n`;
      const remainingChars = maxChars - usedChars - prefix.length;
      if (remainingChars <= 0 && citations.length > 0) break;
      const content = baseContent.length > remainingChars && remainingChars > CONTEXT_TRUNCATION_SUFFIX.length
        ? `${baseContent.slice(0, remainingChars - CONTEXT_TRUNCATION_SUFFIX.length)}${CONTEXT_TRUNCATION_SUFFIX}`
        : baseContent;
      const citation: ContextCitation = {
        citationId: c.chunk_id,
        marker,
        rank: citations.length + 1,
        chunkId: c.chunk_id,
        docId: c.doc_id,
        rawdocId: c.capture_id,
        sectionIds: safeJsonArray(c.section_ids_json ?? "[]"),
        title: c.title,
        pageTitle: c.page_title ?? undefined,
        contentTitle: c.title,
        displayTitle,
        sourceUrl: c.source_url ?? undefined,
        normalizedUrl,
        headingPath: c.heading_path ?? undefined,
        content,
        score: c.score ?? 0,
        parserVersion: c.parser_version ?? undefined,
        parserMethod: c.parser_method ?? undefined,
        parserProfile: c.parser_profile ?? undefined,
        truncated: c.text.length > 800,
        ...(options.trace ? { trace: this.buildTrace(query, c) } : {})
      };
      if ((usedChars + prefix.length + content.length) > maxChars && citations.length > 0) break;
      citations.push(citation);
      usedChars += prefix.length + content.length;
    }
    const contextText = citations.map((citation) => (
      `${citation.marker} ${citation.displayTitle || citation.title}\n`
      + `Source: ${citation.normalizedUrl || citation.sourceUrl || "unknown"}\n`
      + `${citation.content}`
    )).join("\n\n");
    return {
      query: trimmed,
      retriever: "sqlite_fts",
      packer: "section_chunk_v1",
      budget: {
        maxChars,
        usedChars: contextText.length
      },
      contextText,
      citations
    };
  }

  private searchChunks(query: string, options: SearchOptions): SearchChunkRow[] {
    const { ftsQuery, params } = buildFtsQuery(query);
    let sql = "SELECT c.*, rank FROM chunks c JOIN chunks_fts fts ON c.rowid = fts.rowid WHERE chunks_fts MATCH ?";
    const allParams: unknown[] = [ftsQuery];
    if (options.docId) {
      sql += " AND c.doc_id = ?";
      allParams.push(options.docId);
    }
    sql += " ORDER BY rank LIMIT ?";
    allParams.push(Math.min(options.limit || 20, 50));
    return this.database!.prepare(sql).all(...allParams as string[]) as unknown as SearchChunkRow[];
  }

  private buildTrace(query: string, chunk: SearchChunkRow) {
    // simplified trace — matches original behavior
    const terms = extractQueryTerms(query);
    const matchedTerms = terms.filter((t) =>
      (typeof chunk.title === "string" && chunk.title.toLowerCase().includes(t)) ||
      (typeof chunk.text === "string" && chunk.text.toLowerCase().includes(t))
    );
    const titleMatches = terms.filter((t) => typeof chunk.title === "string" && chunk.title.toLowerCase().includes(t)).length;
    const headingMatches = terms.filter((t) => typeof chunk.heading_path === "string" && (chunk.heading_path as string).toLowerCase().includes(t)).length;
    const textLower = typeof chunk.text === "string" ? chunk.text.toLowerCase() : "";
    const hasAll = terms.every((t) => textLower.includes(t));
    return {
      queryTerms: terms,
      matchedTerms,
      termCoverage: terms.length > 0 ? matchedTerms.length / terms.length : 1,
      bm25Score: (chunk.score as number) ?? 0,
      rankingScore: (chunk.score as number) ?? 0,
      titleMatches,
      headingMatches,
      phraseMatched: hasAll
    };
  }

  // ── chunks ─────────────────────────────────────────────────────────────

  private replaceChunks(
    document: KnowledgeDocument,
    rawdoc: RawDoc,
    itemId: string,
    captureId: string,
    parserInfo: { version: string; method: string; profile: string | null },
    now: string
  ): void {
    this.database!.prepare("DELETE FROM chunks WHERE doc_id = ?").run(document.doc_id);
    const chunks = buildChunks(document);
    const insertChunk = this.database!.prepare(`
      INSERT INTO chunks (chunk_id, doc_id, item_id, capture_id, chunk_index, title, page_title, source_url, heading_path, section_ids_json, text, token_estimate, char_count, parser_version, parser_method, parser_profile, content_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      insertChunk.run(
        c.chunkId, document.doc_id, itemId, captureId, i,
        document.meta.title, document.meta.page_title ?? null,
        document.meta.source.url ?? null, c.headingPath ?? null,
        JSON.stringify(c.sectionIds), c.text, c.tokenEstimate, c.charCount,
        parserInfo.version, parserInfo.method, parserInfo.profile ?? null,
        c.contentHash, now, now
      );
    }
    this.database!.prepare("INSERT INTO chunks_fts(rowid, title, heading_path, text) SELECT rowid, title, heading_path, text FROM chunks WHERE doc_id = ?").run(document.doc_id);
  }

  // ── annotations ────────────────────────────────────────────────────────

  async loadAnnotations(docId: string): Promise<Annotation[]> {
    await this.ensure();
    const rows = this.database!.prepare(
      "SELECT * FROM annotations WHERE doc_id = ? AND orphaned = 0 ORDER BY created_at ASC"
    ).all(docId) as unknown as Annotation[];
    return rows;
  }

  async saveAnnotation(docId: string, annotation: Annotation): Promise<void> {
    await this.ensure();
    const now = new Date().toISOString();
    const target = resolveInsideRoot(this.root, `annotations/${docId}.json`);
    await mkdir(dirname(target), { recursive: true });
    let file: AnnotationFile;
    try {
      const raw = JSON.parse(await readFile(target, "utf-8")) as AnnotationFile;
      file = AnnotationFileSchema.parse(raw);
    } catch {
      file = { doc_id: docId, version: 0, updated_at: now, annotations: [] };
    }
    const existingIdx = file.annotations.findIndex((a) => a.annotation_id === annotation.annotation_id);
    const nextAnnotation = { ...annotation, updated_at: now, ...(!annotation.created_at ? { created_at: now } : {}) };
    if (existingIdx >= 0) {
      file.annotations[existingIdx] = nextAnnotation;
    } else {
      file.annotations.push(nextAnnotation);
    }
    file.version++;
    file.updated_at = now;
    await writeFile(target, JSON.stringify(file, null, 2), "utf-8");

    const dbAnnotation = {
      annotation_id: nextAnnotation.annotation_id,
      doc_id: docId,
      section_id: nextAnnotation.section_id,
      type: nextAnnotation.type,
      text_ref: getTextRef(nextAnnotation),
      note: getNote(nextAnnotation),
      color: getColor(nextAnnotation),
      label: getLabel(nextAnnotation),
      ai_model: getAiModel(nextAnnotation),
      summary_level: getSummaryLevel(nextAnnotation),
      orphaned: nextAnnotation.orphaned ? 1 : 0,
      created_at: nextAnnotation.created_at,
      updated_at: nextAnnotation.updated_at
    };
    this.database!.prepare(`
      INSERT INTO annotations (annotation_id, doc_id, section_id, type, text_ref, note, color, label, ai_model, summary_level, orphaned, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(annotation_id) DO UPDATE SET
        section_id = excluded.section_id,
        type = excluded.type,
        text_ref = excluded.text_ref,
        note = excluded.note,
        color = excluded.color,
        label = excluded.label,
        ai_model = excluded.ai_model,
        summary_level = excluded.summary_level,
        orphaned = excluded.orphaned,
        updated_at = excluded.updated_at
    `).run(
      dbAnnotation.annotation_id, dbAnnotation.doc_id, dbAnnotation.section_id,
      dbAnnotation.type, dbAnnotation.text_ref, dbAnnotation.note, dbAnnotation.color,
      dbAnnotation.label, dbAnnotation.ai_model, dbAnnotation.summary_level,
      dbAnnotation.orphaned, dbAnnotation.created_at, dbAnnotation.updated_at
    );
  }

  async deleteAnnotation(docId: string, annotationId: string): Promise<void> {
    await this.ensure();
    this.database!.prepare("DELETE FROM annotations WHERE annotation_id = ? AND doc_id = ?").run(annotationId, docId);
    const target = resolveInsideRoot(this.root, `annotations/${docId}.json`);
    try {
      const raw = JSON.parse(await readFile(target, "utf-8")) as AnnotationFile;
      raw.annotations = raw.annotations.filter((a) => a.annotation_id !== annotationId);
      raw.version++;
      raw.updated_at = new Date().toISOString();
      await writeFile(target, JSON.stringify(raw, null, 2), "utf-8");
    } catch { /* file might not exist */ }
  }

  async deleteAnnotationsForDoc(docId: string): Promise<void> {
    await this.ensure();
    this.database!.prepare("DELETE FROM annotations WHERE doc_id = ?").run(docId);
  }

  async migrateAnnotations(oldDocId: string, newDocId: string, _document: KnowledgeDocument): Promise<number> {
    await this.ensure();
    const annotations = this.database!.prepare(
      "SELECT * FROM annotations WHERE doc_id = ? AND orphaned = 0"
    ).all(oldDocId) as unknown as Annotation[];
    for (const a of annotations) {
      this.database!.prepare("UPDATE annotations SET doc_id = ? WHERE annotation_id = ?").run(newDocId, a.annotation_id);
    }
    return annotations.length;
  }

  async listAnnotationDocs(): Promise<
    Array<{ doc_id: string; title?: string; page_title?: string; annotation_count: number }>
  > {
    await this.ensure();
    const rows = this.database!.prepare(
      "SELECT a.doc_id, d.title, d.page_title, COUNT(*) AS annotation_count FROM annotations a LEFT JOIN documents d ON d.doc_id = a.doc_id WHERE a.orphaned = 0 GROUP BY a.doc_id ORDER BY annotation_count DESC"
    ).all() as { doc_id: string; title: string | null; page_title: string | null; annotation_count: number }[];
    return rows.map((r) => ({
      doc_id: r.doc_id,
      title: r.title ?? undefined,
      page_title: r.page_title ?? undefined,
      annotation_count: r.annotation_count
    }));
  }

  // ── maintenance ────────────────────────────────────────────────────────

  async scanMaintenance(): Promise<StoreMaintenanceScan> {
    await this.ensure();
    const databaseSize = (await stat(join(this.root, "index.sqlite3")).catch(() => ({ size: -1 }))).size;
    const rawdocFiles = await countFiles(join(this.root, "rawdocs"));
    const documentFiles = await countFiles(join(this.root, "documents"));
    const markdownFiles = await countFiles(join(this.root, "markdown"));
    const assetFiles = await countFiles(join(this.root, "assets"));
    const tables = {
      knowledgeItems: this.countRows("items"),
      clips: this.countRowsWhere("items", "item_type = 'document' AND source_type IN ('url', 'singlefile_html')"),
      epubMetadata: this.countRows("epub_metadata"),
      rawdocs: this.countRows("rawdocs"),
      documents: this.countRows("documents"),
      chunks: this.countRows("chunks"),
      collections: this.countRowsWhere("items", "item_type = 'collection'"),
      collectionItems: this.countRows("collection_memberships"),
      batchJobs: this.countRows("batch_jobs"),
      batchItems: this.countRows("batch_items")
    };
    const rows = Object.values(tables).reduce((sum, count) => sum + count, 0);
    const totalContentFiles = rawdocFiles + documentFiles + markdownFiles + assetFiles;
    const parsedItems = this.countRowsWhere("items", "active_doc_id IS NOT NULL");
    const collectionItemRefs = this.countRowsWhere("collection_memberships", "member_item_id IS NOT NULL");
    const batchItemRefs = this.countRowsWhere("batch_items", "doc_id IS NOT NULL");

    return {
      storeRoot: this.root,
      scannedAt: new Date().toISOString(),
      database: { exists: databaseSize >= 0, path: "index.sqlite3", sizeBytes: Math.max(databaseSize, 0) },
      tables,
      files: { rawdocs: rawdocFiles, documents: documentFiles, markdown: markdownFiles, assets: assetFiles, totalContentFiles },
      totals: { rows, contentFiles: totalContentFiles },
      parsedResults: {
        parsedItems,
        parsedClips: this.countRowsWhere("items", "item_type = 'document' AND source_type IN ('url', 'singlefile_html') AND active_doc_id IS NOT NULL"),
        documentRows: tables.documents,
        chunkRows: tables.chunks,
        collectionItemRefs,
        batchItemRefs,
        derivedFiles: documentFiles + markdownFiles + assetFiles
      }
    };
  }

  async clearAll(): Promise<StoreClearResponse> {
    await this.ensure();
    const before = await this.scanMaintenance();
    this.database!.exec("BEGIN");
    try {
      this.database!.exec(`
        DELETE FROM annotations;
        DELETE FROM collection_memberships;
        DELETE FROM batch_items;
        DELETE FROM batch_jobs;
        DELETE FROM chunks;
        DELETE FROM documents;
        DELETE FROM rawdocs;
        DELETE FROM item_aliases;
        DELETE FROM epub_metadata;
        DELETE FROM items;
      `);
      this.database!.exec("COMMIT");
    } catch (error) {
      this.database!.exec("ROLLBACK");
      throw error;
    }
    await rm(join(this.root, "rawdocs"), { recursive: true }).catch(ignoreMissing);
    await rm(join(this.root, "documents"), { recursive: true }).catch(ignoreMissing);
    await rm(join(this.root, "markdown"), { recursive: true }).catch(ignoreMissing);
    await rm(join(this.root, "assets"), { recursive: true }).catch(ignoreMissing);
    await rm(join(this.root, "annotations"), { recursive: true }).catch(ignoreMissing);
    const after = await this.scanMaintenance();
    return { cleared: true, mode: "all", before, after };
  }

  async clearParsedResults(): Promise<StoreClearParsedResponse> {
    await this.ensure();
    const before = await this.scanMaintenance();
    this.database!.exec("BEGIN");
    try {
      this.database!.exec(`
        DELETE FROM annotations;
        DELETE FROM chunks;
        DELETE FROM documents;
        UPDATE items SET active_doc_id = NULL, state = 'captured', parsed_at = NULL, updated_at = datetime('now');
      `);
      this.database!.exec("COMMIT");
    } catch (error) {
      this.database!.exec("ROLLBACK");
      throw error;
    }
    await rm(join(this.root, "documents"), { recursive: true }).catch(ignoreMissing);
    await rm(join(this.root, "markdown"), { recursive: true }).catch(ignoreMissing);
    await rm(join(this.root, "assets"), { recursive: true }).catch(ignoreMissing);
    await rm(join(this.root, "annotations"), { recursive: true }).catch(ignoreMissing);
    const after = await this.scanMaintenance();
    return { cleared: true, mode: "parsed", before, after };
  }

  async deleteDerivedArtifacts(docId: string): Promise<string[]> {
    const files: string[] = [];
    const markdownPath = resolveInsideRoot(this.root, `markdown/${docId}.md`);
    await unlink(markdownPath).then(() => files.push(`markdown/${docId}.md`)).catch(ignoreMissing);
    const annotationsPath = resolveInsideRoot(this.root, `annotations/${docId}.json`);
    await unlink(annotationsPath).then(() => files.push(`annotations/${docId}.json`)).catch(ignoreMissing);
    // delete document json
    const docPath = resolveInsideRoot(this.root, `documents/${docId}.json`);
    await unlink(docPath).then(() => files.push(`documents/${docId}.json`)).catch(ignoreMissing);
    return files;
  }

  async deleteCaptureArtifacts(captureId: string): Promise<string[]> {
    const files: string[] = [];
    for (const ext of ["html", "epub", "pdf", "json"]) {
      const p = resolveInsideRoot(this.root, `rawdocs/${captureId}.${ext}`);
      await unlink(p).then(() => files.push(`rawdocs/${captureId}.${ext}`)).catch(ignoreMissing);
    }
    return files;
  }

  async deleteAssetsForDoc(docId: string): Promise<string[]> {
    const files: string[] = [];
    try {
      const doc = JSON.parse(await readFile(resolveInsideRoot(this.root, `documents/${docId}.json`), "utf-8")) as KnowledgeDocument;
      for (const section of doc.sections) {
        for (const asset of section.assets ?? []) {
          if (asset.asset_id) {
            const assetPath = resolveInsideRoot(this.root, `assets/${asset.asset_id}`);
            await unlink(assetPath).then(() => files.push(`assets/${asset.asset_id}`)).catch(ignoreMissing);
          }
        }
      }
    } catch {
      // document JSON might already be deleted — ignore
    }
    return files;
  }

  // ── internal helpers ───────────────────────────────────────────────────

  private async readText(relativePath: string): Promise<string> {
    return readFile(resolveInsideRoot(this.root, relativePath), "utf-8");
  }

  private async readJson<T = unknown>(relativePath: string): Promise<T> {
    return JSON.parse(await this.readText(relativePath)) as T;
  }

  private async writeText(relativePath: string, data: string): Promise<void> {
    const path = resolveInsideRoot(this.root, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data, "utf-8");
  }

  private async writeJson(relativePath: string, data: unknown): Promise<void> {
    await this.writeText(relativePath, JSON.stringify(data, null, 2));
  }

  private async writeBuffer(relativePath: string, data: Buffer): Promise<void> {
    const path = resolveInsideRoot(this.root, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }

  private countRows(table: string): number {
    return (this.database!.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as unknown as { count: number }).count;
  }

  private countRowsWhere(table: string, where: string): number {
    return (this.database!.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get() as unknown as { count: number }).count;
  }
}

// ── Standalone functions ────────────────────────────────────────────────────

function toKnowledgeItem(
  row: ItemRow,
  extras: {
    normalizedUrl?: string;
    originalUrl?: string;
    canonicalUrl?: string;
    pageTitle?: string | null;
    contentTitle?: string | null;
    displayTitle?: string;
  } = {}
): KnowledgeItem {
  return {
    itemId: row.item_id,
    sourceType: row.source_type === "virtual_collection" ? "url" : row.source_type,
    identityHash: row.identity_key ?? "",
    activeRawdocId: row.active_capture_id ?? "",
    activeDocId: row.active_doc_id ?? undefined,
    normalizedUrl: extras.normalizedUrl,
    originalUrl: extras.originalUrl,
    canonicalUrl: extras.canonicalUrl,
    title: row.title ?? undefined,
    pageTitle: extras.pageTitle ?? undefined,
    contentTitle: extras.contentTitle ?? undefined,
    displayTitle: extras.displayTitle,
    subtitle: row.subtitle ?? undefined,
    creators: safeJsonArray(row.creators_json),
    language: row.language ?? undefined,
    tags: safeJsonArray(row.tags_json),
    state: row.state === "empty" ? "captured" : row.state === "stale" || row.state === "archived" ? "parsed" : row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    parsedAt: row.parsed_at ?? undefined
  };
}

function computeDocumentStatistics(document: KnowledgeDocument): DocumentStatistics {
  const statistics: DocumentStatistics = {
    sectionCount: document.sections.length,
    headingCount: 0,
    paragraphCount: 0,
    tableCount: 0,
    figureCount: 0,
    imageCount: 0,
    assetCount: 0,
    charCount: 0
  };

  for (const section of document.sections) {
    if (section.type === "heading") statistics.headingCount += 1;
    if (section.type === "paragraph") statistics.paragraphCount += 1;
    if (section.type === "table") statistics.tableCount += 1;
    if (section.type === "figure") statistics.figureCount += 1;

    if (typeof section.content === "string") {
      statistics.charCount += section.content.length;
    }
    for (const item of section.items ?? []) {
      statistics.charCount += typeof item === "string" ? item.length : item.text.length;
    }
    if (Array.isArray(section.rows)) {
      statistics.charCount += JSON.stringify(section.rows).length;
    }
    for (const asset of section.assets ?? []) {
      statistics.assetCount += 1;
      statistics.imageCount += 1;
      statistics.charCount += (asset.alt ?? "").length + (asset.caption ?? "").length;
    }
  }

  return statistics;
}

async function countFiles(path: string): Promise<number> {
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); } catch { return 0; }
  const counts = await Promise.all(entries.map(async (entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return countFiles(child);
    return entry.isFile() ? 1 : 0;
  }));
  return counts.reduce((sum, count) => sum + count, 0);
}

function guessContentType(assetId: string): string {
  const ext = extname(assetId).toLowerCase();
  const map: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp",
    ".pdf": "application/pdf"
  };
  return map[ext] ?? "application/octet-stream";
}

// ── Search/context helpers ─────────────────────────────────────────────────

function buildFtsQuery(input: string): { ftsQuery: string; params: unknown[] } {
  const trimmed = input.trim();
  const tokens = trimmed.split(/\s+/).filter(Boolean).map((t) => `"${t}"`);
  if (tokens.length === 0) return { ftsQuery: '""', params: [] };
  return { ftsQuery: tokens.join(" OR "), params: [] };
}

function extractQueryTerms(input: string): string[] {
  const terms = Array.from(input.matchAll(/[A-Za-z][A-Za-z0-9_.-]*|[0-9]+/g))
    .map((match) => normalizeForRanking(match[0].replace(/"/g, "")))
    .filter((term) => term && !RANKING_STOPWORDS.has(term));
  return [...new Set(terms)];
}

function normalizeForRanking(...parts: Array<string | null | undefined>): string {
  return parts
    .filter((part): part is string => typeof part === "string")
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const RANKING_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "for", "how", "in", "is", "of", "on", "or", "the", "to", "vs", "what", "when", "with"
]);

const CONTEXT_TRUNCATION_SUFFIX = "\n[truncated]";

function ignoreMissing(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

// Keep annotation helpers from original
function getTextRef(annotation: Annotation): string | null {
  return annotation.type === "highlight"
    ? annotation.text_ref
    : annotation.type === "note"
      ? (annotation.text_ref ?? null)
      : null;
}

function getNote(annotation: Annotation): string | null {
  return annotation.type === "highlight"
    ? (annotation.note ?? null)
    : annotation.type === "note" || annotation.type === "summary"
      ? annotation.note
      : null;
}

function getColor(annotation: Annotation): string | null {
  return annotation.type === "highlight" ? (annotation.color ?? null) : null;
}

function getLabel(annotation: Annotation): string | null {
  return annotation.type === "tag"
    ? annotation.label
    : annotation.type === "bookmark"
      ? (annotation.label ?? null)
      : null;
}

function getAiModel(annotation: Annotation): string | null {
  return annotation.type === "summary" ? annotation.ai_model : null;
}

function getSummaryLevel(_annotation: Annotation): string | null {
  return null;
}

function toBatchJobItem(row: BatchItemRow): BatchJobItem {
  return {
    itemId: row.item_id,
    jobId: row.job_id,
    collectionId: row.collection_id ?? undefined,
    url: row.url,
    normalizedUrl: row.normalized_url ?? undefined,
    source: row.source ?? undefined,
    titleHint: row.title_hint ?? undefined,
    state: row.state as BatchItemState,
    rawdocId: row.rawdoc_id ?? undefined,
    docId: row.doc_id ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
