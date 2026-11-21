import { DatabaseSync } from "node:sqlite";
import { access, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import type { StoreClearParsedResponse, StoreClearResponse, StoreMaintenanceScan } from "@uknowledge/knowledge-schema";
import { KnowledgeStore, type StoreOptions } from "./store.js";

const CATEGORY_DATABASE_DIR = join("index", "categories");
const CATEGORY_MIGRATION_MARKER = "migration.json";
const CATEGORY_SCHEMA_VERSION = 1;

export class CategoryItemConflictError extends Error {
  readonly statusCode = 409;
  readonly code = "item_exists_in_another_category";

  constructor(readonly itemId: string, readonly existingCategory: string, readonly requestedCategory: string) {
    super(`Item '${itemId}' already belongs to category '${existingCategory}' and cannot be moved to '${requestedCategory}'.`);
    this.name = "CategoryItemConflictError";
  }
}

export class CategoryStoreRegistry {
  readonly store: KnowledgeStore;
  private readonly stores = new Map<string, KnowledgeStore>();
  private readonly categoryContext = new AsyncLocalStorage<string>();
  private uniquenessTail: Promise<void> = Promise.resolve();
  private readonly categories: string[];
  private readonly root: string;
  private readonly options: StoreOptions;

  constructor(root: string, options: StoreOptions & { categories: string[] }) {
    this.root = root;
    this.categories = [...new Set(options.categories)];
    if (!this.categories.includes("default")) {
      throw new Error("The registered category list must include 'default'");
    }
    for (const category of this.categories) {
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(category)) {
        throw new Error(`Invalid registered category '${category}'; use lowercase slugs`);
      }
    }
    this.categories.splice(this.categories.indexOf("default"), 1);
    this.categories.unshift("default");
    this.options = { ...options, categories: [...this.categories] };

    this.store = new Proxy({} as KnowledgeStore, {
      get: (_target, property) => {
        if (property === "then") return undefined;
        if (property === "clearAll") return this.clearAll.bind(this);
        if (property === "clearParsedResults") return this.clearParsedResults.bind(this);
        if (property === "scanMaintenance") return this.scanMaintenance.bind(this);
        if (property === "reindexSearch") return this.reindexSearch.bind(this);
        if (property === "indexPendingEmbeddings") return this.indexPendingEmbeddings.bind(this);
        if (property === "embeddingStats") return this.embeddingStats.bind(this);
        if (property === "recoverStaleJobs") return this.recoverStaleJobs.bind(this);
        if (property === "close") return this.close.bind(this);

        const category = this.currentCategory;
        const store = this.getStore(category);
        const value = Reflect.get(store, property, store) as unknown;
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => this.invoke(category, property, value as (...args: unknown[]) => unknown, args);
      }
    });
  }

  get registeredCategories(): string[] {
    return [...this.categories];
  }

  get currentCategory(): string {
    return this.categoryContext.getStore() ?? "default";
  }

  withCategory<T>(category: string | undefined, operation: () => T): T {
    const selected = category || "default";
    if (!this.categories.includes(selected)) {
      throw new Error(`Category '${selected}' is not registered. Registered categories: ${this.categories.join(", ")}`);
    }
    return this.categoryContext.run(selected, operation);
  }

  getStore(category = "default"): KnowledgeStore {
    if (!this.categories.includes(category)) {
      throw new Error(`Category '${category}' is not registered. Registered categories: ${this.categories.join(", ")}`);
    }
    let store = this.stores.get(category);
    if (!store) {
      const databasePath = join(this.root, CATEGORY_DATABASE_DIR, `${category}.sqlite3`);
      store = new KnowledgeStore(this.root, {
        ...this.options,
        databasePath,
        databaseCategory: category,
        isAssetReferencedElsewhere: (assetId, excludingDocId) =>
          this.isAssetReferencedElsewhere(assetId, excludingDocId)
      });
      this.stores.set(category, store);
    }
    return store;
  }

  async ensureAll(): Promise<void> {
    await this.migrateLegacyDatabase();
    await this.assertRegisteredDatabaseFiles();
    for (const category of this.categories) {
      await this.withCategory(category, () => this.getStore(category).ensure());
    }
    await this.assertUniqueItems();
  }

  async recoverStaleJobs(): Promise<number> {
    const results = await this.forEachStore((store) => store.recoverStaleJobs());
    return results.reduce((total, count) => total + count, 0);
  }

  async indexPendingEmbeddings(options: { force?: boolean } = {}): Promise<{ embedded: number; pending: number }> {
    const results = await this.forEachStore((store) => store.indexPendingEmbeddings(options));
    return results.reduce((total, result) => ({
      embedded: total.embedded + result.embedded,
      pending: total.pending + result.pending
    }), { embedded: 0, pending: 0 });
  }

  async reindexSearch(): Promise<{ documents: number; chunks: number; embeddings: number }> {
    const results = await this.forEachStore((store) => store.reindexSearch());
    return results.reduce((total, result) => ({
      documents: total.documents + result.documents,
      chunks: total.chunks + result.chunks,
      embeddings: total.embeddings + result.embeddings
    }), { documents: 0, chunks: 0, embeddings: 0 });
  }

  async embeddingStats(): Promise<{ model?: string; chunks: number; vectors: number; pending: number }> {
    const results = await this.forEachStore((store) => store.embeddingStats());
    return results.reduce((total, result) => ({
      model: total.model ?? result.model,
      chunks: total.chunks + result.chunks,
      vectors: total.vectors + result.vectors,
      pending: total.pending + result.pending
    }), { chunks: 0, vectors: 0, pending: 0 });
  }

  async scanMaintenance(): Promise<StoreMaintenanceScan> {
    const scans = await this.forEachStore((store) => store.scanMaintenance());
    const first = scans[0];
    const sumFields = <T extends Record<string, number>>(values: T[]): T => {
      const result: Record<string, number> = {};
      for (const key of Object.keys(values[0] ?? {}) as Array<keyof T>) {
        result[String(key)] = values.reduce<number>((sum, value) => sum + value[key], 0);
      }
      return result as unknown as T;
    };
    const tables = sumFields(scans.map((scan) => scan.tables));
    const parsedCounts = sumFields(scans.map(({ parsedResults }) => ({
      parsedItems: parsedResults.parsedItems,
      parsedWebItems: parsedResults.parsedWebItems,
      documentRows: parsedResults.documentRows,
      chunkRows: parsedResults.chunkRows,
      collectionItemRefs: parsedResults.collectionItemRefs,
      batchItemRefs: parsedResults.batchItemRefs
    })));
    const rows = scans.reduce((sum, scan) => sum + scan.totals.rows, 0);
    const databaseSize = scans.reduce((sum, scan) => sum + scan.database.sizeBytes, 0);
    return {
      ...first,
      scannedAt: new Date().toISOString(),
      database: {
        exists: scans.every((scan) => scan.database.exists),
        path: `${CATEGORY_DATABASE_DIR.replaceAll("\\", "/")}/*.sqlite3`,
        sizeBytes: databaseSize
      },
      tables,
      totals: { rows, contentFiles: first.files.totalContentFiles },
      parsedResults: {
        ...parsedCounts,
        derivedFiles: first.files.documents + first.files.outlines + first.files.markdown + first.files.assets
      }
    };
  }

  async clearAll(): Promise<StoreClearResponse> {
    const before = await this.scanMaintenance();
    await this.forEachStore((store) => store.clearAllRows());
    await this.getStore("default").removeAllContentFiles();
    const after = await this.scanMaintenance();
    return { cleared: true, mode: "all", before, after };
  }

  async clearParsedResults(): Promise<StoreClearParsedResponse> {
    const before = await this.scanMaintenance();
    await this.forEachStore((store) => store.clearParsedRows());
    await this.getStore("default").removeParsedContentFiles();
    const after = await this.scanMaintenance();
    return { cleared: true, mode: "parsed", before, after };
  }

  async close(): Promise<void> {
    await Promise.all([...this.stores.values()].map((store) => store.close()));
  }

  private async invoke(
    category: string,
    property: PropertyKey,
    method: (...args: unknown[]) => unknown,
    args: unknown[]
  ): Promise<unknown> {
    const name = String(property);
    if (["save", "saveImportItem", "importSyncItemMetadata", "upsertCollection", "replaceCollectionItems"].includes(name)) {
      return this.withUniquenessLock(async () => {
        if (name === "save") {
          const params = args[0] as { normalizedUrl?: string } | undefined;
          if (params?.normalizedUrl) await this.assertNoDuplicateUrl(category, params.normalizedUrl);
        } else if (name === "replaceCollectionItems") {
          const items = args[1] as Array<{ normalizedUrl?: string }> | undefined;
          for (const item of items ?? []) {
            if (item.normalizedUrl) await this.assertNoDuplicateUrl(category, item.normalizedUrl);
          }
        } else {
          const params = args[0] as { itemId?: string; collectionId?: string } | undefined;
          const itemId = params?.itemId ?? params?.collectionId;
          if (itemId) await this.assertNoDuplicateItemId(category, itemId);
        }
        return method.apply(this.getStore(category), args);
      });
    }
    const store = this.getStore(category);
    return method.apply(store, args);
  }

  private async withUniquenessLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.uniquenessTail;
    let release!: () => void;
    this.uniquenessTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async assertNoDuplicateUrl(category: string, url: string): Promise<void> {
    for (const otherCategory of this.categories) {
      if (otherCategory === category) continue;
      const existing = await this.withCategory(otherCategory, () => this.getStore(otherCategory).status(url));
      if (existing) throw new CategoryItemConflictError(existing.itemId, otherCategory, category);
    }
  }

  private async assertNoDuplicateItemId(category: string, itemId: string): Promise<void> {
    for (const otherCategory of this.categories) {
      if (otherCategory === category) continue;
      const existing = await this.withCategory(otherCategory, () => this.getStore(otherCategory).loadItem(itemId));
      if (existing) throw new CategoryItemConflictError(itemId, otherCategory, category);
    }
  }

  private async assertUniqueItems(): Promise<void> {
    const ownerByItemId = new Map<string, string>();
    for (const category of this.categories) {
      const items = await this.withCategory(category, () => this.getStore(category).listStoredItemIds());
      for (const item of items) {
        const existingCategory = ownerByItemId.get(item.itemId);
        if (existingCategory && existingCategory !== category) {
          throw new CategoryItemConflictError(item.itemId, existingCategory, category);
        }
        ownerByItemId.set(item.itemId, category);
      }
    }
  }

  private async isAssetReferencedElsewhere(assetId: string, excludingDocId: string): Promise<boolean> {
    for (const category of this.categories) {
      const referenced = await this.withCategory(category, () =>
        this.getStore(category).hasAssetReference(assetId, excludingDocId)
      );
      if (referenced) return true;
    }
    return false;
  }

  private async forEachStore<T>(operation: (store: KnowledgeStore) => Promise<T>): Promise<T[]> {
    const results: T[] = [];
    for (const category of this.categories) {
      results.push(await this.withCategory(category, () => operation(this.getStore(category))));
    }
    return results;
  }

  private async migrateLegacyDatabase(): Promise<void> {
    const indexRoot = join(this.root, "index");
    const finalDir = join(this.root, CATEGORY_DATABASE_DIR);
    const stagingDir = join(this.root, "index", "categories.next");
    const markerPath = join(finalDir, CATEGORY_MIGRATION_MARKER);
    const legacyPath = join(this.root, "index.sqlite3");
    const legacyBackupPath = `${legacyPath}.pre-category-split`;

    if (await exists(markerPath)) {
      if (await exists(legacyPath) && !(await exists(legacyBackupPath))) {
        await rename(legacyPath, legacyBackupPath);
      }
      return;
    }
    if (await exists(finalDir)) {
      throw new Error(`Category database directory exists without a migration marker: ${finalDir}`);
    }
    if (await exists(stagingDir)) {
      throw new Error(`Incomplete category database migration staging directory exists: ${stagingDir}`);
    }

    await mkdir(indexRoot, { recursive: true });
    const hasLegacyDatabase = await exists(legacyPath);
    if (hasLegacyDatabase) {
      const legacyStore = new KnowledgeStore(this.root, {
        ...this.options,
        databasePath: legacyPath
      });
      try {
        await legacyStore.ensure();
      } finally {
        await legacyStore.close();
      }

      const legacy = new DatabaseSync(legacyPath);
      try {
        const categoryRows = legacy.prepare("SELECT DISTINCT category FROM items").all() as Array<{ category: string }>;
        const unregistered = categoryRows.map((row) => row.category).filter((category) => !this.categories.includes(category));
        if (unregistered.length > 0) {
          throw new Error(`Legacy store uses unregistered categories: ${unregistered.join(", ")}. Add them to KNOWLEDGE_CATEGORIES before starting.`);
        }
        const crossCategoryMembership = legacy.prepare(`
          SELECT cm.collection_item_id
          FROM collection_memberships cm
          JOIN items collection_item ON collection_item.item_id = cm.collection_item_id
          JOIN items member_item ON member_item.item_id = cm.member_item_id
          WHERE collection_item.category <> member_item.category
          LIMIT 1
        `).get() as { collection_item_id: string } | undefined;
        if (crossCategoryMembership) {
          throw new Error(`Legacy collection '${crossCategoryMembership.collection_item_id}' spans categories; split its members before migration.`);
        }
      } finally {
        legacy.close();
      }
    }

    await mkdir(stagingDir, { recursive: false });
    const migratedCategories: string[] = [];
    const stagedStores: KnowledgeStore[] = [];
    try {
      for (const category of this.categories) {
        const stagedStore = new KnowledgeStore(this.root, {
          ...this.options,
          databasePath: join(stagingDir, `${category}.sqlite3`),
          databaseCategory: category,
          isAssetReferencedElsewhere: undefined
        });
        stagedStores.push(stagedStore);
        await stagedStore.ensure();
        if (hasLegacyDatabase) await stagedStore.importCategoryPartition(legacyPath, category);
        migratedCategories.push(category);
        await stagedStore.close();
      }
      await writeFile(join(stagingDir, CATEGORY_MIGRATION_MARKER), JSON.stringify({
        schemaVersion: CATEGORY_SCHEMA_VERSION,
        source: hasLegacyDatabase ? "index.sqlite3" : "empty-store",
        categories: migratedCategories,
        migratedAt: new Date().toISOString()
      }, null, 2), "utf8");
      await rename(stagingDir, finalDir);
      if (hasLegacyDatabase && !(await exists(legacyBackupPath))) {
        await rename(legacyPath, legacyBackupPath);
      }
    } catch (error) {
      await Promise.allSettled(stagedStores.map((store) => store.close()));
      await rm(stagingDir, { recursive: true, force: true });
      throw error;
    }
  }

  private async assertRegisteredDatabaseFiles(): Promise<void> {
    const directory = join(this.root, CATEGORY_DATABASE_DIR);
    const entries = await readdir(directory);
    const databaseCategories = entries
      .filter((entry) => entry.endsWith(".sqlite3"))
      .map((entry) => entry.slice(0, -".sqlite3".length));
    const unregistered = databaseCategories.filter((category) => !this.categories.includes(category));
    if (unregistered.length > 0) {
      throw new Error(`Stored categories are not registered: ${unregistered.join(", ")}. Add them to KNOWLEDGE_CATEGORIES.`);
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
