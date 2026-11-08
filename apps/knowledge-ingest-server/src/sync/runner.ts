import type {
  Annotation,
  KnowledgeDocument,
  KnowledgeItem,
  RawDoc,
  ReadingProgressSnapshot
} from "@uknowledge/knowledge-schema";
import {
  packageContentHash,
  readerPackageContentHash
} from "../package.js";
import type { KnowledgeStore } from "../store.js";
import { readZipArchive } from "../unzip.js";
import {
  RemoteSuiteError,
  type RemoteCatalogItem,
  type RemoteCollection,
  type RemoteItemMeta,
  type RemoteRawdoc
} from "./remote.js";

export interface SyncSourceClient {
  catalog(): Promise<RemoteCatalogItem[]>;
  itemMeta(itemId: string): Promise<RemoteItemMeta>;
  itemPackage(itemId: string): Promise<Buffer>;
  itemRawdoc(itemId: string): Promise<RemoteRawdoc>;
  collections(): Promise<RemoteCollection[]>;
}

export interface SyncRunResult {
  startedAt: string;
  finishedAt: string;
  status: "ok" | "partial" | "failed";
  catalogItems: number;
  packagesUpdated: number;
  packagesUnchanged: number;
  placeholders: number;
  annotations: number;
  readingProgress: number;
  collections: number;
  collectionMembers: number;
  failedItems: number;
  errors: Array<{ itemId?: string; stage: string; message: string }>;
}

export class SyncBusyError extends Error {
  constructor() {
    super("a sync run is already in progress");
    this.name = "SyncBusyError";
  }
}

interface SyncRunnerOptions {
  attempts?: number;
  retryDelayMs?: number;
}

export class SyncRunner {
  private active?: Promise<SyncRunResult>;
  private lastResult?: SyncRunResult;
  private readonly attempts: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly store: KnowledgeStore,
    private readonly source: SyncSourceClient,
    options: SyncRunnerOptions = {}
  ) {
    this.attempts = Math.max(1, options.attempts ?? 3);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 250);
  }

  status(): { running: boolean; lastResult?: SyncRunResult } {
    return { running: Boolean(this.active), lastResult: this.lastResult };
  }

  async run(): Promise<SyncRunResult> {
    if (this.active) throw new SyncBusyError();
    const active = this.execute();
    this.active = active;
    try {
      const result = await active;
      this.lastResult = result;
      return result;
    } finally {
      this.active = undefined;
    }
  }

  private async execute(): Promise<SyncRunResult> {
    const startedAt = new Date().toISOString();
    const result: SyncRunResult = {
      startedAt,
      finishedAt: startedAt,
      status: "failed",
      catalogItems: 0,
      packagesUpdated: 0,
      packagesUnchanged: 0,
      placeholders: 0,
      annotations: 0,
      readingProgress: 0,
      collections: 0,
      collectionMembers: 0,
      failedItems: 0,
      errors: []
    };

    let catalog: RemoteCatalogItem[];
    try {
      catalog = await this.retry(() => this.source.catalog());
    } catch (error) {
      result.errors.push({ stage: "catalog", message: errorMessage(error) });
      result.finishedAt = new Date().toISOString();
      return result;
    }
    result.catalogItems = catalog.length;

    let collections: RemoteCollection[] = [];
    try {
      collections = await this.retry(() => this.source.collections());
    } catch (error) {
      result.errors.push({ stage: "collections", message: errorMessage(error) });
    }

    const collectionReady = new Set<string>();
    for (const remote of collections) {
      try {
        await this.retry(() => this.store.upsertCollection({
          collectionId: remote.collection.collectionId,
          title: remote.collection.title,
          sourceType: remote.collection.sourceType,
          rootUrl: remote.collection.rootUrl,
          normalizedRootUrl: remote.collection.normalizedRootUrl
        }));
        collectionReady.add(remote.collection.collectionId);
      } catch (error) {
        result.errors.push({
          itemId: remote.collection.collectionId,
          stage: "collection-shell",
          message: errorMessage(error)
        });
      }
    }

    for (const remoteItem of catalog) {
      let itemFailed = false;
      let meta: RemoteItemMeta;
      try {
        meta = await this.retry(() => this.source.itemMeta(remoteItem.itemId));
        await this.retry(() => this.store.importSyncItemMetadata(meta.item));
      } catch (error) {
        result.failedItems += 1;
        result.errors.push({ itemId: remoteItem.itemId, stage: "metadata", message: errorMessage(error) });
        continue;
      }

      const localHash = await this.store.localPackageHash(remoteItem.itemId);
      if (remoteItem.contentHash && remoteItem.docId) {
        if (localHash === remoteItem.contentHash) {
          result.packagesUnchanged += 1;
        } else {
          try {
            await this.retry(() => this.importPackage(remoteItem, meta));
            result.packagesUpdated += 1;
            await this.retry(() => this.store.importSyncItemMetadata(meta.item));
          } catch (error) {
            itemFailed = true;
            result.errors.push({ itemId: remoteItem.itemId, stage: "package", message: errorMessage(error) });
          }
        }
      } else {
        result.placeholders += 1;
        const captureId = meta.item.activeRawdocId || meta.rawdoc?.rawdoc_id;
        if (captureId) {
          try {
            const rawdoc = await this.retry(() => this.source.itemRawdoc(remoteItem.itemId)
              .catch((error: unknown) => {
                if (error instanceof RemoteSuiteError && error.statusCode === 404) return undefined;
                throw error;
              }));
            if (rawdoc) {
              const rawdocMeta: RawDoc = {
                ...(meta.rawdoc ?? {}),
                rawdoc_id: captureId,
                source_type: meta.item.sourceType,
                source_uri: meta.rawdoc?.source_uri
                  ?? meta.item.normalizedUrl
                  ?? remoteItem.sourceUrl
                  ?? meta.item.itemId,
                fetch_time: meta.rawdoc?.fetch_time ?? meta.item.updatedAt,
                content_type: meta.rawdoc?.content_type ?? rawdoc.contentType ?? undefined,
                content_length: rawdoc.bytes.byteLength
              };
              await this.store.importSyncRawdoc(
                remoteItem.itemId,
                rawdocMeta,
                rawdoc.contentExt,
                rawdoc.contentType,
                rawdoc.bytes
              );
            }
          } catch (error) {
            itemFailed = true;
            result.errors.push({ itemId: remoteItem.itemId, stage: "rawdoc", message: errorMessage(error) });
          }
        }
      }

      try {
        await this.mergeAnnotations(meta, result);
        if (meta.readingProgress && await this.store.mergeReadingProgress(meta.item.itemId, meta.readingProgress)) {
          result.readingProgress += 1;
        }
      } catch (error) {
        itemFailed = true;
        result.errors.push({ itemId: remoteItem.itemId, stage: "annotations-progress", message: errorMessage(error) });
      }

      if (itemFailed) result.failedItems += 1;
    }

    for (const remote of collections) {
      if (!collectionReady.has(remote.collection.collectionId)) continue;
      try {
        const imported = await this.retry(() => this.store.importCollectionMembers(
          remote.collection.collectionId,
          remote.members
        ));
        result.collections += 1;
        result.collectionMembers += imported.written;
      } catch (error) {
        result.errors.push({
          itemId: remote.collection.collectionId,
          stage: "collection-members",
          message: errorMessage(error)
        });
      }
    }

    result.finishedAt = new Date().toISOString();
    result.status = result.errors.length === 0
      ? "ok"
      : result.catalogItems > 0 && result.failedItems < result.catalogItems ? "partial" : "failed";
    return result;
  }

  private async mergeAnnotations(meta: RemoteItemMeta, result: SyncRunResult): Promise<void> {
    const docId = meta.documentId ?? meta.item.activeDocId;
    if (!docId || meta.annotations.length === 0) return;
    const local = await this.store.loadAnnotations(docId);
    const localById = new Map(local.map((annotation) => [annotation.annotation_id, annotation]));
    for (const annotation of meta.annotations) {
      const existing = localById.get(annotation.annotation_id);
      if (existing && Date.parse(existing.updated_at) >= Date.parse(annotation.updated_at)) continue;
      if (await this.store.importAnnotation(docId, annotation)) result.annotations += 1;
    }
  }

  private async importPackage(remoteItem: RemoteCatalogItem, meta: RemoteItemMeta): Promise<void> {
    const [archive, rawdoc] = await Promise.all([
      this.source.itemPackage(remoteItem.itemId),
      this.source.itemRawdoc(remoteItem.itemId).catch((error: unknown) => {
        if (error instanceof RemoteSuiteError && error.statusCode === 404) return undefined;
        throw error;
      })
    ]);
    const entries = readZipArchive(archive);
    const byPath = new Map(entries.map((entry) => [entry.path, entry.bytes]));
    const documentBytes = byPath.get("document.json");
    const markdownBytes = byPath.get("markdown.md");
    const outlineBytes = byPath.get("outline.json");
    const manifestBytes = byPath.get("manifest.json");
    if (!documentBytes || !markdownBytes || !outlineBytes || !manifestBytes) {
      throw new Error("package is missing document.json, markdown.md, outline.json, or manifest.json");
    }

    const coreEntries = entries.filter((entry) =>
      entry.path !== "manifest.json" && entry.path !== "outline.json"
    );
    const computedHash = readerPackageContentHash(packageContentHash(coreEntries), outlineBytes);
    if (remoteItem.contentHash && computedHash !== remoteItem.contentHash) {
      throw new Error(`package content hash mismatch: expected ${remoteItem.contentHash}, got ${computedHash}`);
    }

    const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
      itemId?: string;
      docId?: string;
      contentHash?: string;
    };
    if (manifest.itemId !== remoteItem.itemId) {
      throw new Error(`package itemId mismatch: expected ${remoteItem.itemId}`);
    }
    if (manifest.contentHash !== computedHash) {
      throw new Error("package manifest contentHash does not match package bytes");
    }

    const document = JSON.parse(documentBytes.toString("utf8")) as KnowledgeDocument;
    if (remoteItem.docId && document.doc_id !== remoteItem.docId) {
      throw new Error(`package docId mismatch: expected ${remoteItem.docId}`);
    }

    const captureId = meta.item.activeRawdocId || meta.rawdoc?.rawdoc_id || document.meta.source.rawdoc_id;
    if (!captureId) throw new Error("package has no active rawdoc id");
    const sourceUri = meta.rawdoc?.source_uri
      ?? meta.item.normalizedUrl
      ?? document.meta.source.url
      ?? remoteItem.sourceUrl
      ?? meta.item.itemId;
    const rawdocMeta: RawDoc = {
      ...(meta.rawdoc ?? {}),
      rawdoc_id: captureId,
      source_type: meta.item.sourceType,
      source_uri: sourceUri,
      fetch_time: meta.rawdoc?.fetch_time ?? meta.item.updatedAt,
      content_type: meta.rawdoc?.content_type ?? rawdoc?.contentType ?? undefined,
      content_length: rawdoc?.bytes.byteLength ?? meta.rawdoc?.content_length
    };

    await this.store.writeSyncAssets(entries);
    await this.store.writeOutlineFile(document.doc_id, outlineBytes);
    await this.store.saveImportItem({
      itemId: remoteItem.itemId,
      sourceType: meta.item.sourceType,
      sourceUri,
      rawdocId: captureId,
      rawdoc: rawdocMeta,
      rawContentPath: rawdoc ? `rawdocs/${captureId}.${rawdoc.contentExt}` : "",
      document,
      markdown: markdownBytes.toString("utf8"),
      pageTitle: meta.item.pageTitle ?? meta.item.title,
      language: meta.item.language,
      creators: meta.item.creators,
      tags: meta.item.tags,
      identityHash: meta.item.identityHash || undefined,
      content: rawdoc?.bytes,
      contentExt: rawdoc?.contentExt ?? contentExtFor(meta.item.sourceType),
      owner: meta.item.owner,
      createdAt: meta.item.createdAt,
      updatedAt: meta.item.updatedAt,
      parsedAt: meta.item.parsedAt ?? null
    });

    const storedHash = await this.store.localPackageHash(remoteItem.itemId);
    if (remoteItem.contentHash && storedHash !== remoteItem.contentHash) {
      throw new Error(`stored package hash mismatch: expected ${remoteItem.contentHash}, got ${storedHash ?? "none"}`);
    }
  }

  private async retry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt < this.attempts && this.retryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * attempt));
        }
      }
    }
    throw lastError;
  }
}

export class DailySyncScheduler {
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly at: string,
    private readonly runner: SyncRunner,
    private readonly onError: (error: unknown) => void,
    private readonly now: () => Date = () => new Date()
  ) {}

  start(): void {
    this.stopped = false;
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  nextRunAt(from: Date = this.now()): Date {
    const [hour, minute] = this.at.split(":").map(Number);
    const next = new Date(from);
    next.setSeconds(0, 0);
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
    return next;
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const delay = Math.max(0, this.nextRunAt().getTime() - this.now().getTime());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runner.run()
        .catch((error: unknown) => this.onError(error))
        .finally(() => this.scheduleNext());
    }, delay);
    this.timer.unref?.();
  }
}

function contentExtFor(sourceType: KnowledgeItem["sourceType"]): string {
  if (sourceType === "epub") return "epub";
  if (sourceType === "pdf") return "pdf";
  if (sourceType === "markdown") return "md";
  return "html";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { Annotation, ReadingProgressSnapshot };
