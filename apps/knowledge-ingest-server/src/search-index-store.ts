import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface SearchChunkRecord {
  chunk_id: string;
  doc_id: string;
  item_id: string;
  capture_id: string;
  chunk_index: number;
  title: string;
  page_title: string | null;
  source_url: string | null;
  normalized_url: string | null;
  source_type: string | null;
  category: string | null;
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
}

export interface SearchIndexShard {
  id: string;
  hashStart: string;
  hashEnd: string;
  database: DatabaseSync;
  databasePath: string;
}

interface SearchShardManifest {
  formatVersion: 1;
  hash: "sha256-64";
  shards: Array<{ id: string; hashStart: string; hashEnd: string }>;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

const HASH_SPACE = 1n << 64n;
const HASH_MAX = HASH_SPACE - 1n;
const INITIAL_SHARD_IDS = Array.from({ length: 10 }, (_, index) => String((index + 1) * 100).padStart(6, "0"));
const MANIFEST_NAME = "search-shards.json";

function hashItemId(itemId: string): string {
  return createHash("sha256").update(itemId, "utf-8").digest("hex").slice(0, 16);
}

function formatHash(value: bigint): string {
  return value.toString(16).padStart(16, "0");
}

function initialManifest(): SearchShardManifest {
  const shards = INITIAL_SHARD_IDS.map((id, index) => {
    const start = (HASH_SPACE * BigInt(index)) / BigInt(INITIAL_SHARD_IDS.length);
    const end = (HASH_SPACE * BigInt(index + 1)) / BigInt(INITIAL_SHARD_IDS.length) - 1n;
    return { id, hashStart: formatHash(start), hashEnd: formatHash(end) };
  });
  return { formatVersion: 1, hash: "sha256-64", shards };
}

function validateManifest(value: unknown): SearchShardManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Search shard manifest must be a JSON object");
  }
  const candidate = value as Partial<SearchShardManifest>;
  if (candidate.formatVersion !== 1 || candidate.hash !== "sha256-64" || !Array.isArray(candidate.shards)) {
    throw new Error("Unsupported search shard manifest format");
  }
  const shards = candidate.shards.map((shard) => {
    if (!shard || !/^\d{6}$/.test(shard.id) || !/^[0-9a-f]{16}$/.test(shard.hashStart) || !/^[0-9a-f]{16}$/.test(shard.hashEnd)) {
      throw new Error("Invalid entry in search shard manifest");
    }
    if (BigInt(`0x${shard.hashStart}`) > BigInt(`0x${shard.hashEnd}`)) {
      throw new Error(`Invalid hash range for search shard ${shard.id}`);
    }
    return { id: shard.id, hashStart: shard.hashStart, hashEnd: shard.hashEnd };
  }).sort((left, right) => left.hashStart.localeCompare(right.hashStart));
  if (shards.length === 0 || shards[0].hashStart !== formatHash(0n) || shards.at(-1)?.hashEnd !== formatHash(HASH_MAX)) {
    throw new Error("Search shard ranges must cover the complete item hash space");
  }
  for (let index = 1; index < shards.length; index += 1) {
    const previousEnd = BigInt(`0x${shards[index - 1].hashEnd}`);
    const nextStart = BigInt(`0x${shards[index].hashStart}`);
    if (previousEnd + 1n !== nextStart) {
      throw new Error("Search shard ranges must be contiguous and non-overlapping");
    }
  }
  if (new Set(shards.map((shard) => shard.id)).size !== shards.length) {
    throw new Error("Search shard IDs must be unique");
  }
  return { formatVersion: 1, hash: "sha256-64", shards };
}

function createShardSchema(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON");
  const userVersion = database.prepare("PRAGMA user_version").get() as { user_version: number };
  if (userVersion.user_version === 1) {
    const tables = new Set(
      (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
        .map((table) => table.name)
    );
    const missing = ["chunks", "chunks_fts", "chunk_embeddings"].filter((name) => !tables.has(name));
    if (missing.length > 0) {
      throw new Error(`Search shard is missing current-schema tables: ${missing.join(", ")}`);
    }
    const fts = database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chunks_fts'"
    ).get() as { sql?: string } | undefined;
    if (!fts?.sql || !/trigram/i.test(fts.sql)) {
      throw new Error("Search shard chunks_fts must use the current trigram tokenizer");
    }
    return;
  }
  if (userVersion.user_version !== 0) {
    throw new Error(`Unsupported search shard schema version ${userVersion.user_version}; expected 1`);
  }
  const existingObjects = database.prepare(
    "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
  ).all() as Array<{ name: string }>;
  if (existingObjects.length > 0) {
    throw new Error("Cannot initialize a schema-less search shard that already contains database objects");
  }

  database.exec(`
    CREATE TABLE chunks (
      chunk_id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      capture_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      title TEXT NOT NULL,
      page_title TEXT,
      source_url TEXT,
      normalized_url TEXT,
      source_type TEXT,
      category TEXT,
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
    CREATE INDEX idx_chunks_doc ON chunks(doc_id);
    CREATE INDEX idx_chunks_item ON chunks(item_id);
    CREATE TABLE chunk_embeddings (
      chunk_id TEXT NOT NULL,
      model TEXT NOT NULL,
      part INTEGER NOT NULL DEFAULT 0,
      dim INTEGER NOT NULL,
      normalized INTEGER NOT NULL DEFAULT 1,
      chunk_hash TEXT NOT NULL,
      vector BLOB NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (chunk_id, model, part)
    );
    CREATE INDEX idx_chunk_embeddings_model ON chunk_embeddings(model);
  `);
  database.exec(`
    CREATE VIRTUAL TABLE chunks_fts USING fts5(
      title,
      heading_path,
      text,
      content='chunks',
      content_rowid='rowid',
      tokenize='trigram'
    );
    CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, title, heading_path, text)
      VALUES (new.rowid, new.title, new.heading_path, new.text);
    END;
    CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, title, heading_path, text)
      VALUES ('delete', old.rowid, old.title, old.heading_path, old.text);
    END;
    CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, title, heading_path, text)
      VALUES ('delete', old.rowid, old.title, old.heading_path, old.text);
      INSERT INTO chunks_fts(rowid, title, heading_path, text)
      VALUES (new.rowid, new.title, new.heading_path, new.text);
    END;
  `);
  database.exec("PRAGMA user_version = 1");
}

export class ShardedSearchIndex {
  private manifest?: SearchShardManifest;
  private readonly databases = new Map<string, DatabaseSync>();
  private readonly databaseIdentities = new Map<string, FileIdentity>();
  private initialization?: Promise<void>;

  constructor(
    private readonly directory: string,
    private readonly filePrefix: string
  ) {}

  async ensure(): Promise<void> {
    if (!this.initialization) {
      const initialization = this.initialize();
      this.initialization = initialization;
      void initialization.catch(() => {
        if (this.initialization === initialization) this.initialization = undefined;
      });
    }
    await this.initialization;
  }

  shards(): SearchIndexShard[] {
    if (!this.manifest) throw new Error("Search index has not been initialized");
    return this.manifest.shards.map((entry) => ({
      ...entry,
      database: this.openShard(entry.id),
      databasePath: this.pathFor(entry.id)
    }));
  }

  shardForItem(itemId: string): SearchIndexShard {
    if (!this.manifest) throw new Error("Search index has not been initialized");
    const hash = hashItemId(itemId);
    const entry = this.manifest.shards.find((shard) => shard.hashStart <= hash && hash <= shard.hashEnd);
    if (!entry) throw new Error(`No search shard maps item '${itemId}'`);
    return {
      ...entry,
      database: this.openShard(entry.id),
      databasePath: this.pathFor(entry.id)
    };
  }

  async replaceDocument(
    itemId: string,
    docId: string,
    chunks: SearchChunkRecord[],
    replacedDocIds: string[] = []
  ): Promise<void> {
    const shard = this.shardForItem(itemId);
    this.withWritableShard(shard.id, (database) => withImmediateTransaction(database, () => {
      const docIds = [...new Set([docId, ...replacedDocIds])];
      const deleteEmbeddings = database.prepare(
        "DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE item_id = ? AND doc_id = ?)"
      );
      const deleteChunks = database.prepare("DELETE FROM chunks WHERE item_id = ? AND doc_id = ?");
      for (const targetDocId of docIds) {
        deleteEmbeddings.run(itemId, targetDocId);
        deleteChunks.run(itemId, targetDocId);
      }
      const insert = database.prepare(`
        INSERT INTO chunks (
          chunk_id, doc_id, item_id, capture_id, chunk_index, title, page_title, source_url,
          normalized_url, source_type, category, heading_path, section_ids_json, text, token_estimate,
          char_count, parser_version, parser_method, parser_profile, content_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const chunk of chunks) {
        if (chunk.item_id !== itemId || chunk.doc_id !== docId) {
          throw new Error("Search chunks must match their routed item and document IDs");
        }
        insert.run(
          chunk.chunk_id, chunk.doc_id, chunk.item_id, chunk.capture_id, chunk.chunk_index,
          chunk.title, chunk.page_title, chunk.source_url, chunk.normalized_url, chunk.source_type,
          chunk.category, chunk.heading_path, chunk.section_ids_json, chunk.text, chunk.token_estimate, chunk.char_count,
          chunk.parser_version, chunk.parser_method, chunk.parser_profile, chunk.content_hash,
          chunk.created_at, chunk.updated_at
        );
      }
    }));
  }

  async deleteDocument(itemId: string, docId: string): Promise<void> {
    const shard = this.shardForItem(itemId);
    this.withWritableShard(shard.id, (database) => withImmediateTransaction(database, () => {
      database.prepare(
        "DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE item_id = ? AND doc_id = ?)"
      ).run(itemId, docId);
      database.prepare("DELETE FROM chunks WHERE item_id = ? AND doc_id = ?").run(itemId, docId);
    }));
  }

  async saveEmbeddings(
    itemId: string,
    inputs: Array<{ chunkId: string; part: number; contentHash: string }>,
    vectors: Float32Array[],
    model: string
  ): Promise<void> {
    if (inputs.length !== vectors.length) {
      throw new Error(`cannot save ${vectors.length} embeddings for ${inputs.length} parts`);
    }
    const shard = this.shardForItem(itemId);
    const now = new Date().toISOString();
    this.withWritableShard(shard.id, (database) => withImmediateTransaction(database, () => {
      const clear = database.prepare("DELETE FROM chunk_embeddings WHERE chunk_id = ? AND model = ?");
      const insert = database.prepare(`
        INSERT INTO chunk_embeddings (chunk_id, model, part, dim, normalized, chunk_hash, vector, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
        ON CONFLICT(chunk_id, model, part) DO UPDATE SET
          dim = excluded.dim,
          normalized = excluded.normalized,
          chunk_hash = excluded.chunk_hash,
          vector = excluded.vector,
          updated_at = excluded.updated_at
      `);
      for (const chunkId of new Set(inputs.map((input) => input.chunkId))) clear.run(chunkId, model);
      for (let index = 0; index < inputs.length; index += 1) {
        insert.run(
          inputs[index].chunkId, model, inputs[index].part, vectors[index].length,
          inputs[index].contentHash, new Uint8Array(vectors[index].buffer, vectors[index].byteOffset, vectors[index].byteLength),
          now, now
        );
      }
    }));
  }

  clearAll(): void {
    for (const { id } of this.shards()) {
      this.withWritableShard(id, (database) => withImmediateTransaction(database, () => {
        database.exec("DELETE FROM chunk_embeddings; DELETE FROM chunks;");
      }));
    }
  }

  close(): void {
    for (const database of this.databases.values()) closeDatabase(database);
    this.databases.clear();
    this.databaseIdentities.clear();
    this.manifest = undefined;
    this.initialization = undefined;
  }

  private async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const manifestPath = join(this.directory, MANIFEST_NAME);
    let manifest: SearchShardManifest;
    let created = false;
    try {
      manifest = validateManifest(JSON.parse(await readFile(manifestPath, "utf-8")) as unknown);
    } catch (error) {
      if (isMissingFile(error)) {
        const existingShardIds: string[] = [];
        for (const id of INITIAL_SHARD_IDS) {
          try {
            await access(this.pathFor(id));
            existingShardIds.push(id);
          } catch (accessError) {
            if (!isMissingFile(accessError)) throw accessError;
          }
        }
        if (existingShardIds.length > 0) {
          throw new Error(`Search shard manifest is missing while shard files exist: ${existingShardIds.join(", ")}`);
        }
        manifest = initialManifest();
        created = true;
      } else {
        throw error;
      }
    }
    this.manifest = manifest;
    if (!created) {
      for (const shard of manifest.shards) {
        try {
          await access(this.pathFor(shard.id));
        } catch (error) {
          if (isMissingFile(error)) {
            throw new Error(`Search shard database is missing: ${this.pathFor(shard.id)}`);
          }
          throw error;
        }
      }
    }
    for (const shard of manifest.shards) this.openShard(shard.id);

    if (created) {
      await this.writeManifest(manifest);
    }
  }

  private openShard(id: string): DatabaseSync {
    let database = this.databases.get(id);
    const databasePath = this.pathFor(id);
    if (database) {
      let currentIdentity: FileIdentity;
      try {
        currentIdentity = fileIdentity(databasePath);
      } catch (error) {
        this.databases.delete(id);
        this.databaseIdentities.delete(id);
        closeDatabase(database);
        throw new Error(`Search shard database is missing: ${databasePath}`, { cause: error });
      }
      const openedIdentity = this.databaseIdentities.get(id);
      if (openedIdentity && sameFileIdentity(openedIdentity, currentIdentity)) return database;
      this.databases.delete(id);
      this.databaseIdentities.delete(id);
      closeDatabase(database);
    }

    const identityBeforeOpen = fileIdentityIfPresent(databasePath);
    database = new DatabaseSync(databasePath);
    try {
      createShardSchema(database);
      const identityAfterOpen = fileIdentity(databasePath);
      if (identityBeforeOpen && !sameFileIdentity(identityBeforeOpen, identityAfterOpen)) {
        closeDatabase(database);
        return this.openShard(id);
      }
      this.databases.set(id, database);
      this.databaseIdentities.set(id, identityAfterOpen);
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  private withWritableShard<T>(id: string, operation: (database: DatabaseSync) => T): T {
    try {
      return operation(this.openShard(id));
    } catch (error) {
      if (!isRetryableDatabaseHandleError(error)) throw error;
      const database = this.databases.get(id);
      if (database) {
        this.databases.delete(id);
        this.databaseIdentities.delete(id);
        closeDatabase(database);
      }
      return operation(this.openShard(id));
    }
  }

  private pathFor(id: string): string {
    return join(this.directory, `${this.filePrefix}.search.${id}.sqlite3`);
  }

  private async writeManifest(manifest: SearchShardManifest): Promise<void> {
    const manifestPath = join(this.directory, MANIFEST_NAME);
    const temporaryPath = `${manifestPath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    await rename(temporaryPath, manifestPath);
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}

function fileIdentity(path: string): FileIdentity {
  const stats = statSync(path, { bigint: true });
  return { dev: stats.dev, ino: stats.ino };
}

function fileIdentityIfPresent(path: string): FileIdentity | undefined {
  try {
    return fileIdentity(path);
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function closeDatabase(database: DatabaseSync): void {
  try {
    database.close();
  } catch {
    // The connection may already be unusable after an external file replacement.
  }
}

function isRetryableDatabaseHandleError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: string; errcode?: number; message?: string };
  return candidate.code === "SQLITE_READONLY" || candidate.code === "SQLITE_IOERR" ||
    candidate.errcode === 8 || candidate.errcode === 10 ||
    /readonly database|attempt to write a readonly database|disk I\/O error/i.test(candidate.message ?? "");
}

function withImmediateTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the operation error; a failed BEGIN can leave no transaction to roll back.
    }
    throw error;
  }
}
