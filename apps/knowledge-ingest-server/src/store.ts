import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { access, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ClipDeleteMode,
  ClipDeleteResponse,
  ClipListItem,
  ClipSaveResponse,
  ClipStatus,
  BatchItemState,
  BatchJobItem,
  BatchJobResponse,
  BatchJobState,
  CollectionItem,
  CollectionState,
  CollectionSummary,
  KnowledgeDocument,
  makeId,
  normalizeUrlForKnowledge,
  RawDoc,
  urlHash
} from "@uknowledge/knowledge-schema";
import { buildChunks } from "./chunks.js";
import { resolveInsideRoot } from "./path-guard.js";

interface ClipRow {
  url_hash: string;
  normalized_url: string;
  original_url: string | null;
  canonical_url: string | null;
  rawdoc_id: string;
  active_doc_id: string | null;
  page_title: string | null;
  capture_saved_at: string;
  capture_updated_at: string;
  parse_updated_at: string | null;
}

interface DocumentRow {
  doc_id: string;
  rawdoc_id: string;
}

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
  state: BatchItemState;
  rawdoc_id: string | null;
  doc_id: string | null;
  error_code: string | null;
  error_message: string | null;
  attempt_count: number;
  created_at: string;
  updated_at: string;
}

interface CollectionRow {
  collection_id: string;
  title: string;
  root_url: string | null;
  normalized_root_url: string | null;
  source_type: string;
  state: CollectionState;
  created_at: string;
  updated_at: string;
  item_count?: number;
}

interface CollectionItemRow {
  collection_item_id: string;
  collection_id: string;
  normalized_url: string;
  doc_id: string | null;
  rawdoc_id: string | null;
  title: string | null;
  order_index: number;
  depth: number;
  parent_item_id: string | null;
  source: string | null;
  state: BatchItemState;
  created_at: string;
  updated_at: string;
}

interface SearchRow {
  chunk_id: string;
  doc_id: string;
  rawdoc_id: string;
  section_ids_json: string;
  title: string;
  source_url: string | null;
  normalized_url: string | null;
  heading_path: string | null;
  parser_version: string | null;
  parser_method: string | null;
  parser_profile: string | null;
  score: number;
  snippet: string;
}

interface ChunkIndexRow {
  rowid: number;
  title: string;
  heading_path: string | null;
  text: string;
}

interface SearchResultItem {
  chunkId: string;
  docId: string;
  rawdocId: string;
  sectionIds: string[];
  title: string;
  sourceUrl?: string;
  normalizedUrl?: string;
  headingPath?: string;
  snippet: string;
  score: number;
  parserVersion?: string;
  parserMethod?: string;
  parserProfile?: string;
}

interface SavePaths {
  rawHtmlPath: string;
  rawdocPath: string;
  documentPath: string;
  markdownPath: string;
}

const STORE_SCHEMA_VERSION = 6;

interface SearchOptions {
  limit?: number;
  docId?: string;
  url?: string;
  parserMethod?: string;
}

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
    this.migrateSchemaIfNeeded();
    this.ensureIndexes();
  }

  async status(inputUrl: string): Promise<ClipStatus> {
    await this.ensure();
    const normalized = normalizeUrlForKnowledge(inputUrl);
    const hash = urlHash(normalized);
    const row = this.findClip(hash) ?? this.findClipByOriginalUrl(inputUrl);

    if (!row) {
      return {
        normalizedUrl: normalized,
        urlHash: hash,
        state: "empty",
        hasRawdoc: false,
        hasDocument: false
      };
    }

    return this.toStatus(row);
  }

  async list(limit = 50): Promise<ClipListItem[]> {
    await this.ensure();
    const boundedLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
    const rows = this.database!.prepare(`
      SELECT url_hash, normalized_url, original_url, canonical_url, rawdoc_id, active_doc_id, page_title,
        capture_saved_at, capture_updated_at, parse_updated_at
      FROM clips
      ORDER BY COALESCE(parse_updated_at, capture_updated_at) DESC
      LIMIT ?
    `).all(boundedLimit) as unknown as ClipRow[];

    return rows.map((row) => ({
      normalizedUrl: row.normalized_url,
      urlHash: row.url_hash,
      state: row.active_doc_id ? "parsed" : "captured",
      hasRawdoc: true,
      hasDocument: Boolean(row.active_doc_id),
      originalUrl: row.original_url ?? undefined,
      canonicalUrl: row.canonical_url ?? undefined,
      captureSavedAt: row.capture_saved_at,
      captureUpdatedAt: row.capture_updated_at,
      parseUpdatedAt: row.parse_updated_at ?? undefined,
      title: row.page_title ?? undefined,
      docId: row.active_doc_id ?? undefined,
      rawdocId: row.rawdoc_id
    }));
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResultItem[]> {
    await this.ensure();
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }

    const clauses = ["chunks_fts MATCH ?"];
    const values: Array<string | number> = [toFtsQuery(trimmed)];

    if (options.docId) {
      clauses.push("c.doc_id = ?");
      values.push(options.docId);
    }
    if (options.url) {
      clauses.push("c.normalized_url = ?");
      values.push(normalizeUrlForKnowledge(options.url));
    }
    if (options.parserMethod) {
      clauses.push("c.parser_method = ?");
      values.push(options.parserMethod);
    }

    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 10) || 10, 1), 50);
    values.push(limit);

    const rows = this.database!.prepare(`
      SELECT
        c.chunk_id,
        c.doc_id,
        c.rawdoc_id,
        c.section_ids_json,
        c.title,
        c.source_url,
        c.normalized_url,
        c.heading_path,
        c.parser_version,
        c.parser_method,
        c.parser_profile,
        bm25(chunks_fts) AS score,
        snippet(chunks_fts, 2, '[', ']', ' ... ', 18) AS snippet
      FROM chunks_fts
      JOIN chunks c ON c.rowid = chunks_fts.rowid
      WHERE ${clauses.join(" AND ")}
      ORDER BY score
      LIMIT ?
    `).all(...values) as unknown as SearchRow[];

    return rows.map((row) => ({
      chunkId: row.chunk_id,
      docId: row.doc_id,
      rawdocId: row.rawdoc_id,
      sectionIds: safeJsonArray(row.section_ids_json),
      title: row.title,
      sourceUrl: row.source_url ?? undefined,
      normalizedUrl: row.normalized_url ?? undefined,
      headingPath: row.heading_path ?? undefined,
      snippet: row.snippet,
      score: row.score,
      parserVersion: row.parser_version ?? undefined,
      parserMethod: row.parser_method ?? undefined,
      parserProfile: row.parser_profile ?? undefined
    }));
  }

  async upsertCollection(params: {
    collectionId?: string;
    title: string;
    rootUrl: string;
    sourceType: string;
    state?: CollectionState;
  }): Promise<CollectionSummary> {
    await this.ensure();
    const now = new Date().toISOString();
    const collectionId = params.collectionId ?? makeId();
    const normalizedRootUrl = normalizeUrlForKnowledge(params.rootUrl);
    const existing = this.findCollection(collectionId);

    this.database!.prepare(`
      INSERT INTO collections (
        collection_id,
        title,
        root_url,
        normalized_root_url,
        source_type,
        state,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(collection_id) DO UPDATE SET
        title = excluded.title,
        root_url = excluded.root_url,
        normalized_root_url = excluded.normalized_root_url,
        source_type = excluded.source_type,
        state = excluded.state,
        updated_at = excluded.updated_at
    `).run(
      collectionId,
      params.title,
      params.rootUrl,
      normalizedRootUrl,
      params.sourceType,
      params.state ?? existing?.state ?? "active",
      existing?.created_at ?? now,
      now
    );

    return this.loadCollectionSummary(collectionId);
  }

  async listCollections(limit = 50): Promise<CollectionSummary[]> {
    await this.ensure();
    const boundedLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
    const rows = this.database!.prepare(`
      SELECT
        c.collection_id,
        c.title,
        c.root_url,
        c.normalized_root_url,
        c.source_type,
        c.state,
        c.created_at,
        c.updated_at,
        COUNT(ci.collection_item_id) AS item_count
      FROM collections c
      LEFT JOIN collection_items ci ON ci.collection_id = c.collection_id
      GROUP BY c.collection_id
      ORDER BY c.updated_at DESC
      LIMIT ?
    `).all(boundedLimit) as unknown as CollectionRow[];
    return rows.map(toCollectionSummary);
  }

  async loadCollection(collectionId: string): Promise<{ collection: CollectionSummary; items: CollectionItem[] }> {
    await this.ensure();
    const collection = this.loadCollectionSummary(collectionId);
    const rows = this.database!.prepare(`
      SELECT collection_item_id, collection_id, normalized_url, doc_id, rawdoc_id, title,
        order_index, depth, parent_item_id, source, state, created_at, updated_at
      FROM collection_items
      WHERE collection_id = ?
      ORDER BY order_index ASC, created_at ASC
    `).all(collectionId) as unknown as CollectionItemRow[];
    return {
      collection,
      items: rows.map(toCollectionItem)
    };
  }

  async replaceCollectionItems(collectionId: string, items: Array<{
    normalizedUrl: string;
    title?: string;
    source?: string;
    orderIndex: number;
    depth: number;
    state?: BatchItemState;
  }>): Promise<CollectionItem[]> {
    await this.ensure();
    const now = new Date().toISOString();

    try {
      this.database!.exec("BEGIN");
      this.database!.prepare("DELETE FROM collection_items WHERE collection_id = ?").run(collectionId);
      const insert = this.database!.prepare(`
        INSERT INTO collection_items (
          collection_item_id,
          collection_id,
          normalized_url,
          title,
          order_index,
          depth,
          source,
          state,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of items) {
        insert.run(
          makeId(),
          collectionId,
          item.normalizedUrl,
          item.title ?? null,
          item.orderIndex,
          item.depth,
          item.source ?? null,
          item.state ?? "pending",
          now,
          now
        );
      }
      this.database!.exec("COMMIT");
    } catch (error) {
      this.database!.exec("ROLLBACK");
      throw error;
    }

    return (await this.loadCollection(collectionId)).items;
  }

  async createBatchJob(params: {
    collectionId: string;
    sourcePageUrl: string;
    mode: "server_fetch";
    options?: Record<string, unknown>;
    items: Array<{
      url: string;
      normalizedUrl: string;
      source?: string;
      titleHint?: string;
      state?: BatchItemState;
    }>;
  }): Promise<BatchJobResponse> {
    await this.ensure();
    const now = new Date().toISOString();
    const jobId = makeId();

    try {
      this.database!.exec("BEGIN");
      this.database!.prepare(`
        INSERT INTO batch_jobs (
          job_id,
          collection_id,
          source_page_url,
          mode,
          state,
          total_count,
          options_json,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        jobId,
        params.collectionId,
        params.sourcePageUrl,
        params.mode,
        "queued",
        params.items.length,
        JSON.stringify(params.options ?? {}),
        now
      );

      const insertItem = this.database!.prepare(`
        INSERT INTO batch_items (
          item_id,
          job_id,
          collection_id,
          url,
          normalized_url,
          source,
          title_hint,
          state,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of params.items) {
        insertItem.run(
          makeId(),
          jobId,
          params.collectionId,
          item.url,
          item.normalizedUrl,
          item.source ?? null,
          item.titleHint ?? null,
          item.state ?? "pending",
          now,
          now
        );
      }
      this.database!.exec("COMMIT");
    } catch (error) {
      this.database!.exec("ROLLBACK");
      throw error;
    }

    return this.loadBatchJob(jobId);
  }

  async loadBatchJob(jobId: string): Promise<BatchJobResponse> {
    await this.ensure();
    const row = this.database!.prepare(`
      SELECT job_id, collection_id, source_page_url, mode, state, total_count,
        saved_count, skipped_count, failed_count, cancelled_count, options_json,
        created_at, started_at, finished_at
      FROM batch_jobs
      WHERE job_id = ?
    `).get(jobId) as BatchJobRow | undefined;
    if (!row) {
      throw new Error("Batch job does not exist");
    }

    const items = this.listBatchItems(jobId);
    return toBatchJobResponse(row, items);
  }

  async listPendingBatchItems(jobId: string): Promise<BatchJobItem[]> {
    await this.ensure();
    return this.listBatchItems(jobId).filter((item) => item.state === "pending");
  }

  async updateBatchJobState(jobId: string, state: BatchJobState): Promise<void> {
    await this.ensure();
    const now = new Date().toISOString();
    this.database!.prepare(`
      UPDATE batch_jobs
      SET state = ?,
          started_at = CASE WHEN started_at IS NULL AND ? = 'running' THEN ? ELSE started_at END,
          finished_at = CASE WHEN ? IN ('succeeded', 'failed', 'cancelled') THEN ? ELSE finished_at END
      WHERE job_id = ?
    `).run(state, state, now, state, now, jobId);
  }

  async updateBatchItem(params: {
    itemId: string;
    state: BatchItemState;
    normalizedUrl?: string;
    rawdocId?: string;
    docId?: string;
    title?: string;
    errorCode?: string;
    errorMessage?: string;
    incrementAttempt?: boolean;
  }): Promise<void> {
    await this.ensure();
    const now = new Date().toISOString();
    const item = this.findBatchItem(params.itemId);
    if (!item) {
      throw new Error("Batch item does not exist");
    }

    this.database!.prepare(`
      UPDATE batch_items
      SET state = ?,
          normalized_url = COALESCE(?, normalized_url),
          rawdoc_id = COALESCE(?, rawdoc_id),
          doc_id = COALESCE(?, doc_id),
          error_code = ?,
          error_message = ?,
          attempt_count = attempt_count + ?,
          updated_at = ?
      WHERE item_id = ?
    `).run(
      params.state,
      params.normalizedUrl ?? null,
      params.rawdocId ?? null,
      params.docId ?? null,
      params.errorCode ?? null,
      params.errorMessage ?? null,
      params.incrementAttempt ? 1 : 0,
      now,
      params.itemId
    );

    if (item.collection_id) {
      const previousNormalizedUrl = item.normalized_url ?? normalizeUrlForKnowledge(item.url);
      const nextNormalizedUrl = params.normalizedUrl ?? previousNormalizedUrl;
      this.database!.prepare(`
        UPDATE collection_items
        SET state = ?,
            normalized_url = ?,
            rawdoc_id = COALESCE(?, rawdoc_id),
            doc_id = COALESCE(?, doc_id),
            title = COALESCE(?, title),
            updated_at = ?
        WHERE collection_id = ?
          AND normalized_url = ?
      `).run(
        params.state,
        nextNormalizedUrl,
        params.rawdocId ?? null,
        params.docId ?? null,
        params.title ?? null,
        now,
        item.collection_id,
        previousNormalizedUrl
      );
      await this.refreshCollectionState(item.collection_id);
    }

    await this.refreshBatchCounts(item.job_id);
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }

  async deleteByUrl(inputUrl: string, mode: ClipDeleteMode): Promise<ClipDeleteResponse> {
    await this.ensure();
    const normalized = normalizeUrlForKnowledge(inputUrl);
    const hash = urlHash(normalized);
    const row = this.findClip(hash) ?? this.findClipByOriginalUrl(inputUrl);

    if (!row) {
      return {
        normalizedUrl: normalized,
        urlHash: hash,
        state: "empty",
        hasRawdoc: false,
        hasDocument: false,
        deleted: false,
        mode,
        previousState: "captured",
        currentState: "empty",
        deletedFiles: []
      };
    }

    return mode === "remove" ? this.removeByRow(row) : this.purgeByRow(row);
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
    const replacedDocId = previous?.active_doc_id && previous.active_doc_id !== params.document.doc_id
      ? previous.active_doc_id
      : undefined;
    const replacedRawdocId = previous && previous.rawdoc_id !== params.rawdoc.rawdoc_id
      ? previous.rawdoc_id
      : undefined;
    const paths = pathsFor(params.document.doc_id, params.rawdoc.rawdoc_id);
    const parserInfo = parserInfoFor(params.document, params.rawdoc);
    const now = new Date().toISOString();
    const contentHash = sha256(params.markdown);
    const authorsJson = JSON.stringify(params.document.meta.authors ?? []);
    const rawMetadata = params.rawdoc.metadata ?? {};
    const originalUrl = typeof rawMetadata.originalUrl === "string"
      ? rawMetadata.originalUrl
      : params.rawdoc.source_uri;
    const canonicalUrl = typeof rawMetadata.canonicalUrl === "string"
      ? rawMetadata.canonicalUrl
      : params.document.meta.source.url ?? params.rawdoc.source_uri;

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
        previous && previous.rawdoc_id === params.rawdoc.rawdoc_id ? previous.capture_saved_at : now
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

      this.replaceChunks(params.document, params.rawdoc, normalized, parserInfo, now);

      this.database!.prepare(`
        INSERT INTO clips (
          url_hash,
          normalized_url,
          original_url,
          canonical_url,
          rawdoc_id,
          active_doc_id,
          page_title,
          capture_saved_at,
          capture_updated_at,
          parse_updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(url_hash) DO UPDATE SET
          normalized_url = excluded.normalized_url,
          original_url = excluded.original_url,
          canonical_url = excluded.canonical_url,
          rawdoc_id = excluded.rawdoc_id,
          active_doc_id = excluded.active_doc_id,
          page_title = excluded.page_title,
          capture_updated_at = excluded.capture_updated_at,
          parse_updated_at = excluded.parse_updated_at
      `).run(
        hash,
        normalized,
        originalUrl,
        canonicalUrl,
        params.rawdoc.rawdoc_id,
        params.document.doc_id,
        params.document.meta.title,
        previous?.capture_saved_at ?? now,
        now,
        now
      );

      if (replacedDocId) {
        this.deleteChunksByDocId(replacedDocId);
        this.database!.prepare("DELETE FROM documents WHERE doc_id = ?").run(replacedDocId);
      }
      if (replacedRawdocId) {
        this.database!.prepare("DELETE FROM rawdocs WHERE rawdoc_id = ?").run(replacedRawdocId);
      }
      this.database!.exec("COMMIT");
    } catch (error) {
      this.database!.exec("ROLLBACK");
      throw error;
    }

    if (replacedDocId) {
      await this.deleteDerivedArtifacts(replacedDocId);
    }
    if (replacedRawdocId) {
      await this.deleteCaptureArtifacts(replacedRawdocId);
    }

    return paths;
  }

  async loadCaptureByUrl(inputUrl: string): Promise<{ clip: ClipStatus; html: string; rawdoc: RawDoc }> {
    await this.ensure();
    const normalized = normalizeUrlForKnowledge(inputUrl);
    const row = this.findClip(urlHash(normalized)) ?? this.findClipByOriginalUrl(inputUrl);
    if (!row) {
      throw new Error("Capture does not exist for this URL");
    }

    const html = await this.readText(pathsForActiveCapture(row).rawHtmlPath);
    const rawdoc = JSON.parse(await this.readText(pathsForActiveCapture(row).rawdocPath)) as RawDoc;
    return {
      clip: this.toStatus(row),
      html,
      rawdoc
    };
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
        rawdoc_id TEXT NOT NULL,
        active_doc_id TEXT,
        page_title TEXT,
        capture_saved_at TEXT NOT NULL,
        capture_updated_at TEXT NOT NULL,
        parse_updated_at TEXT
      );

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

      CREATE TABLE IF NOT EXISTS chunks (
        chunk_id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL,
        rawdoc_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        title TEXT NOT NULL,
        source_url TEXT,
        normalized_url TEXT,
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
        updated_at TEXT NOT NULL,
        UNIQUE(doc_id, chunk_index)
      );

      CREATE TABLE IF NOT EXISTS collections (
        collection_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        root_url TEXT,
        normalized_root_url TEXT,
        source_type TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS collection_items (
        collection_item_id TEXT PRIMARY KEY,
        collection_id TEXT NOT NULL,
        normalized_url TEXT NOT NULL,
        doc_id TEXT,
        rawdoc_id TEXT,
        title TEXT,
        order_index INTEGER NOT NULL,
        depth INTEGER NOT NULL DEFAULT 0,
        parent_item_id TEXT,
        source TEXT,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(collection_id) REFERENCES collections(collection_id)
      );

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

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        title,
        heading_path,
        text,
        content='chunks',
        content_rowid='rowid'
      );
    `);
    this.database = database;
  }

  private ensureIndexes(): void {
    this.database!.exec(`
      CREATE INDEX IF NOT EXISTS idx_clips_rawdoc_id ON clips(rawdoc_id);
      CREATE INDEX IF NOT EXISTS idx_clips_active_doc_id ON clips(active_doc_id);
      CREATE INDEX IF NOT EXISTS idx_documents_rawdoc_id ON documents(rawdoc_id);
      CREATE INDEX IF NOT EXISTS idx_documents_normalized_url ON documents(normalized_url);
      CREATE INDEX IF NOT EXISTS idx_documents_content_hash ON documents(content_hash);
      CREATE INDEX IF NOT EXISTS idx_rawdocs_normalized_url ON rawdocs(normalized_url);
      CREATE INDEX IF NOT EXISTS idx_rawdocs_html_hash ON rawdocs(html_hash);
      CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON chunks(doc_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_rawdoc_id ON chunks(rawdoc_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_normalized_url ON chunks(normalized_url);
      CREATE INDEX IF NOT EXISTS idx_chunks_parser_method ON chunks(parser_method);
      CREATE INDEX IF NOT EXISTS idx_collections_root_url ON collections(normalized_root_url);
      CREATE INDEX IF NOT EXISTS idx_collection_items_collection_id ON collection_items(collection_id);
      CREATE INDEX IF NOT EXISTS idx_collection_items_normalized_url ON collection_items(normalized_url);
      CREATE INDEX IF NOT EXISTS idx_batch_items_job_id ON batch_items(job_id);
      CREATE INDEX IF NOT EXISTS idx_batch_items_normalized_url ON batch_items(normalized_url);
    `);
  }

  private migrateSchemaIfNeeded(): void {
    const userVersion = this.database!.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
    const clipsColumns = this.database!.prepare("PRAGMA table_info(clips)").all() as Array<{ name: string }>;
    const hasActiveDocId = clipsColumns.some((column) => column.name === "active_doc_id");
    if (hasActiveDocId && (userVersion?.user_version ?? 0) >= STORE_SCHEMA_VERSION) {
      return;
    }

    const hasLegacyV2 = clipsColumns.some((column) => column.name === "doc_id");
    if (!hasLegacyV2) {
      if ((userVersion?.user_version ?? 0) < STORE_SCHEMA_VERSION) {
        this.rebuildChunksFtsIndex();
      }
      this.database!.exec(`PRAGMA user_version = ${STORE_SCHEMA_VERSION}`);
      return;
    }

    this.database!.exec("BEGIN");
    try {
      this.database!.exec("ALTER TABLE clips RENAME TO clips_old");
      this.database!.exec(`
        CREATE TABLE clips (
          url_hash TEXT PRIMARY KEY,
          normalized_url TEXT NOT NULL UNIQUE,
          original_url TEXT,
          canonical_url TEXT,
          rawdoc_id TEXT NOT NULL,
          active_doc_id TEXT,
          page_title TEXT,
          capture_saved_at TEXT NOT NULL,
          capture_updated_at TEXT NOT NULL,
          parse_updated_at TEXT
        );
      `);
      this.database!.exec(`
        INSERT INTO clips (
          url_hash,
          normalized_url,
          original_url,
          canonical_url,
          rawdoc_id,
          active_doc_id,
          page_title,
          capture_saved_at,
          capture_updated_at,
          parse_updated_at
        )
        SELECT
          url_hash,
          normalized_url,
          original_url,
          canonical_url,
          rawdoc_id,
          doc_id,
          page_title,
          saved_at,
          updated_at,
          updated_at
        FROM clips_old
      `);
      this.database!.exec("DROP TABLE clips_old");
      this.rebuildChunksFtsIndex();
      this.database!.exec(`PRAGMA user_version = ${STORE_SCHEMA_VERSION}`);
      this.database!.exec("COMMIT");
    } catch (error) {
      this.database!.exec("ROLLBACK");
      throw error;
    }
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

      const columns = database.prepare("PRAGMA table_info(clips)").all() as Array<{ name: string }>;
      const hasResetCandidate = columns.some((column) => column.name === "markdown_path")
        || columns.some((column) => column.name === "document_path")
        || columns.some((column) => column.name === "rawdoc_path");
      if (!hasResetCandidate) {
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
      SELECT url_hash, normalized_url, original_url, canonical_url, rawdoc_id, active_doc_id, page_title,
        capture_saved_at, capture_updated_at, parse_updated_at
      FROM clips
      WHERE url_hash = ?
    `).get(hash) as ClipRow | undefined;
  }

  private findClipByOriginalUrl(input: string): ClipRow | undefined {
    return this.database!.prepare(`
      SELECT url_hash, normalized_url, original_url, canonical_url, rawdoc_id, active_doc_id, page_title,
        capture_saved_at, capture_updated_at, parse_updated_at
      FROM clips
      WHERE original_url = ?
    `).get(input) as ClipRow | undefined;
  }

  private findDocument(docId: string): DocumentRow | undefined {
    return this.database!.prepare(`
      SELECT doc_id, rawdoc_id
      FROM documents
      WHERE doc_id = ?
    `).get(docId) as DocumentRow | undefined;
  }

  private findCollection(collectionId: string): CollectionRow | undefined {
    return this.database!.prepare(`
      SELECT collection_id, title, root_url, normalized_root_url, source_type, state, created_at, updated_at
      FROM collections
      WHERE collection_id = ?
    `).get(collectionId) as CollectionRow | undefined;
  }

  private loadCollectionSummary(collectionId: string): CollectionSummary {
    const row = this.database!.prepare(`
      SELECT
        c.collection_id,
        c.title,
        c.root_url,
        c.normalized_root_url,
        c.source_type,
        c.state,
        c.created_at,
        c.updated_at,
        COUNT(ci.collection_item_id) AS item_count
      FROM collections c
      LEFT JOIN collection_items ci ON ci.collection_id = c.collection_id
      WHERE c.collection_id = ?
      GROUP BY c.collection_id
    `).get(collectionId) as CollectionRow | undefined;
    if (!row) {
      throw new Error("Collection does not exist");
    }
    return toCollectionSummary(row);
  }

  private listBatchItems(jobId: string): BatchJobItem[] {
    const rows = this.database!.prepare(`
      SELECT item_id, job_id, collection_id, url, normalized_url, source, title_hint, state,
        rawdoc_id, doc_id, error_code, error_message, attempt_count, created_at, updated_at
      FROM batch_items
      WHERE job_id = ?
      ORDER BY created_at ASC
    `).all(jobId) as unknown as BatchItemRow[];
    return rows.map(toBatchJobItem);
  }

  private findBatchItem(itemId: string): BatchItemRow | undefined {
    return this.database!.prepare(`
      SELECT item_id, job_id, collection_id, url, normalized_url, source, title_hint, state,
        rawdoc_id, doc_id, error_code, error_message, attempt_count, created_at, updated_at
      FROM batch_items
      WHERE item_id = ?
    `).get(itemId) as BatchItemRow | undefined;
  }

  private async refreshBatchCounts(jobId: string): Promise<void> {
    const rows = this.database!.prepare(`
      SELECT state, COUNT(*) AS count
      FROM batch_items
      WHERE job_id = ?
      GROUP BY state
    `).all(jobId) as Array<{ state: BatchItemState; count: number }>;
    const counts = new Map(rows.map((row) => [row.state, row.count]));
    const saved = counts.get("saved") ?? 0;
    const skipped = counts.get("skipped") ?? 0;
    const failed = counts.get("failed") ?? 0;
    const cancelled = counts.get("cancelled") ?? 0;
    const terminal = saved + skipped + failed + cancelled;
    const job = this.database!.prepare(`
      SELECT total_count, state
      FROM batch_jobs
      WHERE job_id = ?
    `).get(jobId) as { total_count: number; state: BatchJobState } | undefined;
    if (!job) {
      return;
    }

    const nextState: BatchJobState = terminal >= job.total_count
      ? "succeeded"
      : job.state === "queued"
        ? "running"
        : job.state;
    const now = new Date().toISOString();
    this.database!.prepare(`
      UPDATE batch_jobs
      SET saved_count = ?,
          skipped_count = ?,
          failed_count = ?,
          cancelled_count = ?,
          state = ?,
          started_at = CASE WHEN started_at IS NULL THEN ? ELSE started_at END,
          finished_at = CASE WHEN ? = 'succeeded' THEN ? ELSE finished_at END
      WHERE job_id = ?
    `).run(saved, skipped, failed, cancelled, nextState, now, nextState, now, jobId);
  }

  private async refreshCollectionState(collectionId: string): Promise<void> {
    const rows = this.database!.prepare(`
      SELECT state, COUNT(*) AS count
      FROM collection_items
      WHERE collection_id = ?
      GROUP BY state
    `).all(collectionId) as Array<{ state: BatchItemState; count: number }>;
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    const saved = rows.find((row) => row.state === "saved")?.count ?? 0;
    const skipped = rows.find((row) => row.state === "skipped")?.count ?? 0;
    const failed = rows.find((row) => row.state === "failed")?.count ?? 0;
    const useful = saved + skipped;
    const state: CollectionState = useful === 0 && failed === 0
      ? "draft"
      : failed > 0 || useful < total
        ? "partial"
        : "active";
    this.database!.prepare(`
      UPDATE collections
      SET state = ?,
          updated_at = ?
      WHERE collection_id = ?
    `).run(state, new Date().toISOString(), collectionId);
  }

  private toStatus(row: ClipRow): ClipStatus {
    const hasDocument = Boolean(row.active_doc_id);
    return {
      normalizedUrl: row.normalized_url,
      urlHash: row.url_hash,
      state: hasDocument ? "parsed" : "captured",
      hasRawdoc: true,
      hasDocument,
      originalUrl: row.original_url ?? undefined,
      canonicalUrl: row.canonical_url ?? undefined,
      captureSavedAt: row.capture_saved_at,
      captureUpdatedAt: row.capture_updated_at,
      parseUpdatedAt: row.parse_updated_at ?? undefined,
      title: row.page_title ?? undefined,
      docId: row.active_doc_id ?? undefined,
      rawdocId: row.rawdoc_id
    };
  }

  private async removeByRow(row: ClipRow): Promise<ClipDeleteResponse> {
    if (!row.active_doc_id) {
      return {
        ...this.toStatus(row),
        deleted: false,
        mode: "remove",
        previousState: "captured",
        currentState: "captured",
        deletedFiles: []
      };
    }

    const now = new Date().toISOString();
    const deletedFiles = await this.deleteDerivedArtifacts(row.active_doc_id);
    try {
      this.database!.exec("BEGIN");
      this.deleteChunksByDocId(row.active_doc_id);
      this.database!.prepare("DELETE FROM documents WHERE doc_id = ?").run(row.active_doc_id);
      this.database!.prepare(`
        UPDATE clips
        SET active_doc_id = NULL,
            capture_updated_at = ?,
            parse_updated_at = NULL
        WHERE url_hash = ?
      `).run(now, row.url_hash);
      this.database!.exec("COMMIT");
    } catch (error) {
      this.database!.exec("ROLLBACK");
      throw error;
    }

    return {
      normalizedUrl: row.normalized_url,
      urlHash: row.url_hash,
      state: "captured",
      hasRawdoc: true,
      hasDocument: false,
      originalUrl: row.original_url ?? undefined,
      canonicalUrl: row.canonical_url ?? undefined,
      captureSavedAt: row.capture_saved_at,
      captureUpdatedAt: now,
      title: row.page_title ?? undefined,
      rawdocId: row.rawdoc_id,
      deleted: true,
      mode: "remove",
      previousState: "parsed",
      currentState: "captured",
      deletedFiles,
      removedDocId: row.active_doc_id
    };
  }

  private async purgeByRow(row: ClipRow): Promise<ClipDeleteResponse> {
    const deletedFiles: string[] = [];
    if (row.active_doc_id) {
      deletedFiles.push(...await this.deleteDerivedArtifacts(row.active_doc_id));
    }
    deletedFiles.push(...await this.deleteCaptureArtifacts(row.rawdoc_id));

    try {
      this.database!.exec("BEGIN");
      this.database!.prepare("DELETE FROM clips WHERE url_hash = ?").run(row.url_hash);
      if (row.active_doc_id) {
        this.deleteChunksByDocId(row.active_doc_id);
        this.database!.prepare("DELETE FROM documents WHERE doc_id = ?").run(row.active_doc_id);
      }
      this.database!.prepare("DELETE FROM rawdocs WHERE rawdoc_id = ?").run(row.rawdoc_id);
      this.database!.exec("COMMIT");
    } catch (error) {
      this.database!.exec("ROLLBACK");
      throw error;
    }

    return {
      normalizedUrl: row.normalized_url,
      urlHash: row.url_hash,
      state: "empty",
      hasRawdoc: false,
      hasDocument: false,
      originalUrl: row.original_url ?? undefined,
      canonicalUrl: row.canonical_url ?? undefined,
      deleted: true,
      mode: "purge",
      previousState: row.active_doc_id ? "parsed" : "captured",
      currentState: "empty",
      deletedFiles,
      removedDocId: row.active_doc_id ?? undefined,
      removedRawdocId: row.rawdoc_id
    };
  }

  private async deleteDerivedArtifacts(docId: string): Promise<string[]> {
    const deletedFiles: string[] = [];
    const relativePaths = [
      documentJsonPath(docId),
      markdownPath(docId)
    ];
    for (const relativePath of relativePaths) {
      await this.deleteFile(relativePath);
      deletedFiles.push(relativePath);
    }
    return deletedFiles;
  }

  private async deleteCaptureArtifacts(rawdocId: string): Promise<string[]> {
    const deletedFiles: string[] = [];
    const relativePaths = [
      rawHtmlPath(rawdocId),
      rawdocMetaPath(rawdocId)
    ];
    for (const relativePath of relativePaths) {
      await this.deleteFile(relativePath);
      deletedFiles.push(relativePath);
    }
    return deletedFiles;
  }

  private replaceChunks(
    document: KnowledgeDocument,
    rawdoc: RawDoc,
    normalizedUrl: string,
    parserInfo: { version: string; method: string; profile: string | null },
    now: string
  ): void {
    const builtChunks = buildChunks(document);
    this.deleteChunksByDocId(document.doc_id);

    const insertChunk = this.database!.prepare(`
      INSERT INTO chunks (
        chunk_id,
        doc_id,
        rawdoc_id,
        chunk_index,
        title,
        source_url,
        normalized_url,
        heading_path,
        section_ids_json,
        text,
        token_estimate,
        char_count,
        parser_version,
        parser_method,
        parser_profile,
        content_hash,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = this.database!.prepare("INSERT INTO chunks_fts (rowid, title, heading_path, text) VALUES (?, ?, ?, ?)");

    for (const chunk of builtChunks) {
      insertChunk.run(
        chunk.chunkId,
        document.doc_id,
        rawdoc.rawdoc_id,
        chunk.chunkIndex,
        document.meta.title,
        document.meta.source.url ?? rawdoc.source_uri,
        normalizedUrl,
        chunk.headingPath,
        JSON.stringify(chunk.sectionIds),
        chunk.text,
        chunk.tokenEstimate,
        chunk.charCount,
        parserInfo.version,
        parserInfo.method,
        parserInfo.profile,
        chunk.contentHash,
        now,
        now
      );
      const row = this.database!.prepare("SELECT rowid FROM chunks WHERE chunk_id = ?").get(chunk.chunkId) as { rowid: number };
      insertFts.run(
        row.rowid,
        document.meta.title,
        chunk.headingPath,
        chunk.text
      );
    }
  }

  private deleteChunksByDocId(docId: string): void {
    const rows = this.database!.prepare(`
      SELECT rowid, title, heading_path, text
      FROM chunks
      WHERE doc_id = ?
    `).all(docId) as unknown as ChunkIndexRow[];
    const deleteFts = this.database!.prepare(`
      INSERT INTO chunks_fts (chunks_fts, rowid, title, heading_path, text)
      VALUES ('delete', ?, ?, ?, ?)
    `);
    for (const row of rows) {
      deleteFts.run(row.rowid, row.title, row.heading_path, row.text);
    }
    this.database!.prepare("DELETE FROM chunks WHERE doc_id = ?").run(docId);
  }

  private rebuildChunksFtsIndex(): void {
    this.database!.exec(`
      DROP TABLE IF EXISTS chunks_fts;
      CREATE VIRTUAL TABLE chunks_fts USING fts5(
        title,
        heading_path,
        text,
        content='chunks',
        content_rowid='rowid'
      );
      INSERT INTO chunks_fts (rowid, title, heading_path, text)
      SELECT rowid, title, heading_path, text
      FROM chunks;
    `);
  }

  private async writeText(relativePath: string, content: string): Promise<void> {
    const path = resolveInsideRoot(this.root, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }

  private async readText(relativePath: string): Promise<string> {
    const path = resolveInsideRoot(this.root, relativePath);
    return readFile(path, "utf8");
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
    rawHtmlPath: rawHtmlPath(rawdocId),
    rawdocPath: rawdocMetaPath(rawdocId),
    documentPath: documentJsonPath(docId),
    markdownPath: markdownPath(docId)
  };
}

function pathsForActiveCapture(row: Pick<ClipRow, "rawdoc_id">): Pick<SavePaths, "rawHtmlPath" | "rawdocPath"> {
  return {
    rawHtmlPath: rawHtmlPath(row.rawdoc_id),
    rawdocPath: rawdocMetaPath(row.rawdoc_id)
  };
}

function toCollectionSummary(row: CollectionRow): CollectionSummary {
  return {
    collectionId: row.collection_id,
    title: row.title,
    rootUrl: row.root_url ?? undefined,
    normalizedRootUrl: row.normalized_root_url ?? undefined,
    sourceType: row.source_type,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    itemCount: row.item_count ?? 0
  };
}

function toCollectionItem(row: CollectionItemRow): CollectionItem {
  return {
    collectionItemId: row.collection_item_id,
    collectionId: row.collection_id,
    normalizedUrl: row.normalized_url,
    docId: row.doc_id ?? undefined,
    rawdocId: row.rawdoc_id ?? undefined,
    title: row.title ?? undefined,
    orderIndex: row.order_index,
    depth: row.depth,
    parentItemId: row.parent_item_id ?? undefined,
    source: row.source ?? undefined,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
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
    state: row.state,
    rawdocId: row.rawdoc_id ?? undefined,
    docId: row.doc_id ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toBatchJobResponse(row: BatchJobRow, items: BatchJobItem[]): BatchJobResponse {
  return {
    collectionId: row.collection_id ?? undefined,
    jobId: row.job_id,
    state: row.state,
    total: row.total_count,
    saved: row.saved_count,
    skipped: row.skipped_count,
    failed: row.failed_count,
    cancelled: row.cancelled_count,
    items
  };
}

function rawHtmlPath(rawdocId: string): string {
  return `rawdocs/${rawdocId}.html`;
}

function rawdocMetaPath(rawdocId: string): string {
  return `rawdocs/${rawdocId}.json`;
}

function documentJsonPath(docId: string): string {
  return `documents/${docId}.json`;
}

function markdownPath(docId: string): string {
  return `markdown/${docId}.md`;
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

function safeJsonArray(input: string): string[] {
  try {
    const parsed = JSON.parse(input);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function toFtsQuery(input: string): string {
  const tokens = Array.from(input.matchAll(/[A-Za-z][A-Za-z0-9_.-]*|[0-9]+/g))
    .map((match) => match[0].replace(/"/g, ""))
    .filter(Boolean);

  if (tokens.length === 0) {
    return input.trim().replace(/"/g, " ");
  }

  return tokens.map((token) => `"${token}"`).join(" OR ");
}

function ignoreMissing(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
    throw error;
  }
}
