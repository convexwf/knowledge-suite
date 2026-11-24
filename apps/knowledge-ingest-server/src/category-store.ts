import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import type { StoreClearParsedResponse, StoreClearResponse, StoreMaintenanceScan } from "@uknowledge/knowledge-schema";
import { KnowledgeStore, type StoreOptions } from "./store.js";

const INDEX_DATABASE_DIR = "index";

interface CategoryStoreRegistryOptions extends StoreOptions {
  categories: string[];
  onStoreInitialized?: (category: string, store: KnowledgeStore) => void;
}

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
  private readonly onStoreInitialized?: CategoryStoreRegistryOptions["onStoreInitialized"];
  private readonly notifiedCategories = new Set<string>();
  private readonly initializationPromises = new Map<string, Promise<void>>();
  private readonly recoveryPromises = new Map<string, Promise<number>>();

  constructor(root: string, options: CategoryStoreRegistryOptions) {
    const { categories, onStoreInitialized, ...storeOptions } = options;
    this.root = root;
    this.categories = [...new Set(categories)];
    this.onStoreInitialized = onStoreInitialized;
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
    this.options = { ...storeOptions, categories: [...this.categories] };

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
      const categoryDirectory = join(this.root, INDEX_DATABASE_DIR, category);
      const databasePath = join(categoryDirectory, `${category}.main.sqlite3`);
      store = new KnowledgeStore(this.root, {
        ...this.options,
        databasePath,
        searchDirectory: categoryDirectory,
        searchFilePrefix: category,
        databaseCategory: category,
        isAssetReferencedElsewhere: (assetId, excludingDocId) =>
          this.isAssetReferencedElsewhere(assetId, excludingDocId)
      });
      this.stores.set(category, store);
    }
    return store;
  }

  async recoverStaleJobs(): Promise<number> {
    const results = await this.forEachStore(
      (store) => store.recoverStaleJobs(),
      { recoverStaleJobs: false, notify: false }
    );
    return results.reduce((total, count) => total + count, 0);
  }

  async indexPendingEmbeddings(options: { force?: boolean } = {}): Promise<{ embedded: number; pending: number }> {
    const results = await this.forEachStore(
      (store) => store.indexPendingEmbeddings(options),
      { notify: false }
    );
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
        path: `${INDEX_DATABASE_DIR}/{category}/*.sqlite3`,
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
    this.initializationPromises.clear();
    this.recoveryPromises.clear();
    this.notifiedCategories.clear();
  }

  private async invoke(
    category: string,
    property: PropertyKey,
    method: (...args: unknown[]) => unknown,
    args: unknown[]
  ): Promise<unknown> {
    const name = String(property);
    await this.ensureCategory(category, { notify: name !== "indexPendingEmbeddings" });
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
      await this.ensureCategory(otherCategory);
      const existing = await this.withCategory(otherCategory, () => this.getStore(otherCategory).status(url));
      if (existing) throw new CategoryItemConflictError(existing.itemId, otherCategory, category);
    }
  }

  private async assertNoDuplicateItemId(category: string, itemId: string): Promise<void> {
    for (const otherCategory of this.categories) {
      if (otherCategory === category) continue;
      await this.ensureCategory(otherCategory);
      const existing = await this.withCategory(otherCategory, () => this.getStore(otherCategory).loadItem(itemId));
      if (existing) throw new CategoryItemConflictError(itemId, otherCategory, category);
    }
  }

  private async isAssetReferencedElsewhere(assetId: string, excludingDocId: string): Promise<boolean> {
    for (const category of this.categories) {
      await this.ensureCategory(category);
      const referenced = await this.withCategory(category, () =>
        this.getStore(category).hasAssetReference(assetId, excludingDocId)
      );
      if (referenced) return true;
    }
    return false;
  }

  private async forEachStore<T>(
    operation: (store: KnowledgeStore) => Promise<T>,
    options: { recoverStaleJobs?: boolean; notify?: boolean } = {}
  ): Promise<T[]> {
    const results: T[] = [];
    for (const category of this.categories) {
      await this.ensureCategory(category, options);
      results.push(await this.withCategory(category, () => operation(this.getStore(category))));
    }
    return results;
  }

  private async ensureCategory(
    category: string,
    options: { recoverStaleJobs?: boolean; notify?: boolean } = {}
  ): Promise<void> {
    const store = this.getStore(category);
    let initialization = this.initializationPromises.get(category);
    if (!initialization) {
      initialization = store.ensure();
      this.initializationPromises.set(category, initialization);
      void initialization.catch(() => {
        if (this.initializationPromises.get(category) === initialization) {
          this.initializationPromises.delete(category);
        }
      });
    }
    await initialization;

    if (options.recoverStaleJobs !== false) {
      let recovery = this.recoveryPromises.get(category);
      if (!recovery) {
        recovery = store.recoverStaleJobs();
        this.recoveryPromises.set(category, recovery);
        void recovery.catch(() => {
          if (this.recoveryPromises.get(category) === recovery) {
            this.recoveryPromises.delete(category);
          }
        });
      }
      await recovery;
    }

    if (options.notify !== false && !this.notifiedCategories.has(category)) {
      this.notifiedCategories.add(category);
      this.onStoreInitialized?.(category, store);
    }
  }

}
