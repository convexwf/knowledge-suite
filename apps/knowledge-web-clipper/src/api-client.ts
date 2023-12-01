import {
  AIAnnotationGenerateRequest,
  AIAnnotationGenerateResult,
  Annotation,
  AnnotationDeleteAllResult,
  AnnotationDeleteResult,
  AnnotationItemListResult,
  AnnotationListResult,
  AnnotationSaveResult,
  TaskState,
  ExtensionSettings,
  HealthResult,
  EpubImportResult,
  KnowledgeDocument,
  KnowledgeCaptureRequestBody,
  KnowledgeCaptureSaveRequestBody,
  KnowledgeItem,
  KnowledgeDeleteByUrlResult,
  KnowledgeItemDeleteMode,
  KnowledgeItemDeleteResult,
  KnowledgeItemDetailResult,
  KnowledgeItemListResult,
  KnowledgeItemStatusResult,
  KnowledgeSourceType,
  PreviewResult,
  BatchCandidate,
  BatchDiscoverResult,
  BatchJobResult,
  CheckCollectionNameResult,
  CollectionSummary,
  CollectionDetail,
  StoreClearParsedResult,
  StoreClearResult,
  StoreMaintenanceScan,
  STORE_CLEAR_CONFIRMATION,
  STORE_CLEAR_PARSED_CONFIRMATION
} from "./types.js";

/** Side-panel list item enriched with URL info derived from item identity. */
export interface ItemListItem extends KnowledgeItem {
  normalizedUrl: string;
  urlHash: string;
  state: "captured" | "parsed";
  hasRawdoc: true;
  hasDocument: boolean;
  captureSavedAt: string;
  captureUpdatedAt: string;
  parseUpdatedAt?: string;
  docId?: string;
  rawdocId?: string;
}

function normalizedUrlFromItem(item: KnowledgeItem & { normalizedUrl?: string }): string {
  if (item.normalizedUrl) return item.normalizedUrl;
  if (item.canonicalUrl) return item.canonicalUrl;
  if (item.originalUrl) return item.originalUrl;
  return item.itemId;
}

export interface KnowledgeApiClient {
  health(): Promise<HealthResult>;
  scanStore(): Promise<StoreMaintenanceScan>;
  clearStore(): Promise<StoreClearResult>;
  clearParsedResults(): Promise<StoreClearParsedResult>;
  status(url: string): Promise<KnowledgeItemStatusResult>;
  list(limit?: number): Promise<{ items: ItemListItem[] }>;
  listItems(sourceType?: KnowledgeSourceType, limit?: number): Promise<KnowledgeItemListResult>;
  item(itemId: string): Promise<KnowledgeItemDetailResult>;
  importEpub(body: {
    file: File;
    sourceUri?: string;
    titleHint?: string;
    tags?: string[];
    metadataOpf?: File;
    cover?: File;
  }): Promise<EpubImportResult>;
  reparseItem(itemId: string): Promise<EpubImportResult>;
  deleteItem(itemId: string, mode?: KnowledgeItemDeleteMode): Promise<KnowledgeItemDeleteResult>;
  document(docId: string): Promise<KnowledgeDocument>;
  documentMarkdown(docId: string): Promise<string>;
  assetBlobUrl(assetId: string): Promise<string>;
  deleteByUrl(url: string, mode?: KnowledgeItemDeleteMode): Promise<KnowledgeDeleteByUrlResult>;
  reparseByUrl(url: string): Promise<PreviewResult>;
  preview(body: KnowledgeCaptureRequestBody): Promise<PreviewResult>;
  save(body: KnowledgeCaptureSaveRequestBody): Promise<PreviewResult>;
  discoverBatch(pageUrl: string, candidates: BatchCandidate[]): Promise<BatchDiscoverResult>;
  createBatchJob(body: {
    sourcePageUrl: string;
    collection: {
      title: string;
      rootUrl: string;
      strategy: "create" | "update";
      collectionId?: string;
    };
    items: Array<{
      url: string;
      titleHint?: string;
      source?: string;
      order?: number;
      depth?: number;
    }>;
    options?: {
      skipExisting?: boolean;
      maxConcurrency?: number;
    };
  }): Promise<BatchJobResult>;
  batchJob(jobId: string): Promise<BatchJobResult>;
  cancelBatchJob(jobId: string): Promise<{ cancelled: boolean }>;
  retryBatchJob(jobId: string): Promise<BatchJobResult & { retryCount?: number }>;
  checkCollectionName(title: string): Promise<CheckCollectionNameResult>;
  listCollections(limit?: number): Promise<{ collections: CollectionSummary[] }>;
  collection(collectionId: string): Promise<CollectionDetail>;
  deleteCollection(collectionId: string): Promise<{ deleted: boolean; collectionId: string }>;
  collectionNavigation(collectionId: string, itemId: string): Promise<{
    previous: { itemId: string; title?: string; normalizedUrl?: string } | null;
    next: { itemId: string; title?: string; normalizedUrl?: string } | null;
  }>;
  itemAnnotations(itemId: string): Promise<AnnotationListResult>;
  saveItemAnnotation(itemId: string, annotation: Annotation): Promise<AnnotationSaveResult>;
  deleteItemAnnotation(itemId: string, annotationId: string): Promise<AnnotationDeleteResult>;
  deleteAnnotationsForItem(itemId: string): Promise<AnnotationDeleteAllResult>;
  listAnnotationItems(): Promise<AnnotationItemListResult>;
  createItemAITask(itemId: string, body: AIAnnotationGenerateRequest): Promise<TaskState>;
  getTask(taskId: string): Promise<TaskState>;
  cancelTask(taskId: string): Promise<{ cancelled: boolean; task_id: string; completed: number }>;
}

export function createKnowledgeApiClient(settings: ExtensionSettings): KnowledgeApiClient {
  const baseUrl = settings.serverUrl.replace(/\/+$/, "");
  const options = {
    timeoutMs: settings.requestTimeoutMs
  };

  return {
    health: () => request<HealthResult>(baseUrl, settings.token, "GET", "/api/health", undefined, options),
    scanStore: () => request<StoreMaintenanceScan>(
      baseUrl,
      settings.token,
      "GET",
      "/api/store/scan",
      undefined,
      options
    ),
    clearStore: () => request<StoreClearResult>(
      baseUrl,
      settings.token,
      "POST",
      "/api/store/clear",
      {
        confirm: true,
        confirmation: STORE_CLEAR_CONFIRMATION
      },
      options
    ),
    clearParsedResults: () => request<StoreClearParsedResult>(
      baseUrl,
      settings.token,
      "POST",
      "/api/store/clear-parsed",
      {
        confirm: true,
        confirmation: STORE_CLEAR_PARSED_CONFIRMATION
      },
      options
    ),
    status: (url) => request<KnowledgeItemStatusResult>(
      baseUrl,
      settings.token,
      "GET",
      `/api/ingest/status?url=${encodeURIComponent(url)}`,
      undefined,
      options
    ),
    list: (limit = settings.savedListLimit) => {
      const params = new URLSearchParams();
      if (limit > 0) params.set("limit", String(limit));
      return request<{ items: (KnowledgeItem & { normalizedUrl?: string })[] }>(
        baseUrl,
        settings.token,
        "GET",
        `/api/items?${params.toString()}`,
        undefined,
        options
      ).then((res) => ({
        items: res.items.map((item) => ({
          ...item,
          normalizedUrl: item.normalizedUrl || normalizedUrlFromItem(item),
          urlHash: item.identityHash,
          state: item.state === "captured" ? "captured" as const : "parsed" as const,
          hasRawdoc: true as const,
          hasDocument: Boolean(item.activeDocId),
          captureSavedAt: item.createdAt,
          captureUpdatedAt: item.updatedAt,
          parseUpdatedAt: item.parsedAt,
          docId: item.activeDocId,
          rawdocId: item.activeRawdocId
        }))
      }));
    },
    listItems: (sourceType, limit = settings.savedListLimit) => {
      const params = new URLSearchParams();
      if (sourceType) {
        params.set("sourceType", sourceType);
      }
      params.set("limit", String(limit));
      return request<KnowledgeItemListResult>(
        baseUrl,
        settings.token,
        "GET",
        `/api/items?${params.toString()}`,
        undefined,
        options
      );
    },
    item: (itemId) => request<KnowledgeItemDetailResult>(
      baseUrl,
      settings.token,
      "GET",
      `/api/items/${encodeURIComponent(itemId)}`,
      undefined,
      options
    ),
    importEpub: (body) => {
      const form = new FormData();
      form.append("file", body.file, body.file.name);
      form.append("sourceUri", body.sourceUri?.trim() || body.file.name);
      if (body.titleHint?.trim()) {
        form.append("titleHint", body.titleHint.trim());
      }
      if (body.tags?.length) {
        form.append("tags", body.tags.join(","));
      }
      if (body.metadataOpf) {
        form.append("metadataOpf", body.metadataOpf, body.metadataOpf.name);
      }
      if (body.cover) {
        form.append("cover", body.cover, body.cover.name);
      }
      return requestForm<EpubImportResult>(baseUrl, settings.token, "/api/import/epub", form, options);
    },
    reparseItem: (itemId) => request<EpubImportResult>(
      baseUrl,
      settings.token,
      "POST",
      `/api/items/${encodeURIComponent(itemId)}/reparse`,
      {},
      options
    ),
    deleteItem: (itemId, mode = "remove") => request<KnowledgeItemDeleteResult>(
      baseUrl,
      settings.token,
      "DELETE",
      `/api/items/${encodeURIComponent(itemId)}?mode=${encodeURIComponent(mode)}`,
      undefined,
      options
    ),
    document: (docId) => request<KnowledgeDocument>(
      baseUrl,
      settings.token,
      "GET",
      `/api/documents/${encodeURIComponent(docId)}`,
      undefined,
      options
    ),
    documentMarkdown: (docId) => requestText(
      baseUrl,
      settings.token,
      `/api/documents/${encodeURIComponent(docId)}/markdown`,
      options
    ),
    assetBlobUrl: async (assetId) => {
      const blob = await requestBlob(baseUrl, settings.token, `/api/assets/${encodeURIComponent(assetId)}`, options);
      return URL.createObjectURL(blob);
    },
    deleteByUrl: (url, mode = "remove") => request<KnowledgeDeleteByUrlResult>(
      baseUrl,
      settings.token,
      "GET",
      `/api/ingest/status?url=${encodeURIComponent(url)}`,
      undefined,
      options
    ).then(async (before) => {
      const result = await request<KnowledgeItemDeleteResult>(
        baseUrl,
        settings.token,
        "DELETE",
        `/api/ingest?url=${encodeURIComponent(url)}&mode=${encodeURIComponent(mode)}`,
        undefined,
        options
      );
      return {
        ...before,
        deleted: result.deleted,
        mode,
        previousState: result.previousState,
        currentState: result.currentState,
        state: result.currentState,
        removedDocId: result.removedDocId,
        removedRawdocId: result.removedRawdocId,
        deletedFiles: result.deletedFiles
      };
    }),
    reparseByUrl: (url) => request<PreviewResult>(baseUrl, settings.token, "POST", "/api/ingest/reparse", { url }, options),
    preview: (body) => request<PreviewResult>(baseUrl, settings.token, "POST", "/api/ingest/preview", body, options),
    save: (body) => request<PreviewResult>(baseUrl, settings.token, "POST", "/api/ingest/save", {
      ...body,
      overwrite: true
    }, options),
    discoverBatch: (pageUrl, candidates) => request<BatchDiscoverResult>(
      baseUrl,
      settings.token,
      "POST",
      "/api/batch/discover",
      {
        pageUrl,
        candidates,
        scope: {
          sameOrigin: true,
          pathPrefix: defaultPathPrefix(pageUrl),
          maxItems: 50
        }
      },
      options
    ),
    createBatchJob: (body) => request<BatchJobResult>(
      baseUrl,
      settings.token,
      "POST",
      "/api/batch/jobs",
      {
        mode: "server_fetch",
        options: {
          skipExisting: true,
          maxConcurrency: 3,
          ...body.options
        },
        ...body
      },
      options
    ),
    batchJob: (jobId) => request<BatchJobResult>(
      baseUrl,
      settings.token,
      "GET",
      `/api/batch/jobs/${encodeURIComponent(jobId)}`,
      undefined,
      options
    ),
    cancelBatchJob: (jobId) => request<{ cancelled: boolean }>(
      baseUrl,
      settings.token,
      "POST",
      `/api/batch/jobs/${encodeURIComponent(jobId)}/cancel`,
      {},
      options
    ),
    retryBatchJob: (jobId) => request<BatchJobResult & { retryCount?: number }>(
      baseUrl,
      settings.token,
      "POST",
      `/api/batch/jobs/${encodeURIComponent(jobId)}/retry`,
      {},
      options
    ),
    checkCollectionName: (title) => request<CheckCollectionNameResult>(
      baseUrl,
      settings.token,
      "GET",
      `/api/collections/check-name?title=${encodeURIComponent(title)}`,
      undefined,
      options
    ),
    listCollections: (limit) => request<{ collections: CollectionSummary[] }>(
      baseUrl,
      settings.token,
      "GET",
      limit ? `/api/collections?limit=${encodeURIComponent(String(limit))}` : "/api/collections",
      undefined,
      options
    ),
    collection: (collectionId) => request<CollectionDetail>(
      baseUrl,
      settings.token,
      "GET",
      `/api/collections/${encodeURIComponent(collectionId)}`,
      undefined,
      options
    ),
    deleteCollection: (collectionId) => request<{ deleted: boolean; collectionId: string }>(
      baseUrl,
      settings.token,
      "DELETE",
      `/api/collections/${encodeURIComponent(collectionId)}`,
      undefined,
      options
    ),
    collectionNavigation: (collectionId, itemId) => request<{
      previous: { itemId: string; title?: string; normalizedUrl?: string } | null;
      next: { itemId: string; title?: string; normalizedUrl?: string } | null;
    }>(
      baseUrl,
      settings.token,
      "GET",
      `/api/collections/${encodeURIComponent(collectionId)}/navigation?itemId=${encodeURIComponent(itemId)}`,
      undefined,
      options
    ),
    itemAnnotations: (itemId) => request<AnnotationListResult>(
      baseUrl,
      settings.token,
      "GET",
      `/api/items/${encodeURIComponent(itemId)}/annotations`,
      undefined,
      options
    ),
    saveItemAnnotation: (itemId, annotation) => request<AnnotationSaveResult>(
      baseUrl,
      settings.token,
      "POST",
      `/api/items/${encodeURIComponent(itemId)}/annotations`,
      annotation,
      options
    ),
    deleteItemAnnotation: (itemId, annotationId) => request<AnnotationDeleteResult>(
      baseUrl,
      settings.token,
      "DELETE",
      `/api/items/${encodeURIComponent(itemId)}/annotations/${encodeURIComponent(annotationId)}`,
      undefined,
      options
    ),
    deleteAnnotationsForItem: (itemId) => request<AnnotationDeleteAllResult>(
      baseUrl,
      settings.token,
      "DELETE",
      `/api/items/${encodeURIComponent(itemId)}/annotations`,
      undefined,
      options
    ),
    listAnnotationItems: () => request<AnnotationItemListResult>(
      baseUrl,
      settings.token,
      "GET",
      "/api/annotations",
      undefined,
      options
    ),
    createItemAITask: (itemId, body) => request<TaskState>(
      baseUrl,
      settings.token,
      "POST",
      `/api/items/${encodeURIComponent(itemId)}/ai-annotations`,
      body,
      { timeoutMs: 30000 }
    ),
    getTask: (taskId) => request<TaskState>(
      baseUrl,
      settings.token,
      "GET",
      `/api/tasks/${encodeURIComponent(taskId)}`,
      undefined,
      options
    ),
    cancelTask: (taskId) => request<{ cancelled: boolean; task_id: string; completed: number }>(
      baseUrl,
      settings.token,
      "DELETE",
      `/api/tasks/${encodeURIComponent(taskId)}`,
      undefined,
      options
    ),
  };
}

async function request<T>(
  baseUrl: string,
  token: string,
  method: "DELETE" | "GET" | "POST",
  path: string,
  body?: unknown,
  options?: { timeoutMs: number; signal?: AbortSignal }
): Promise<T> {
  const abortController = new AbortController();
  const timeout = globalThis.setTimeout(() => abortController.abort(), options?.timeoutMs ?? 15000);

  // Merge external signal with internal timeout
  const externalSignal = options?.signal;
  if (externalSignal) {
    if (externalSignal.aborted) {
      globalThis.clearTimeout(timeout);
      throw new DOMException("Aborted", "AbortError");
    }
    externalSignal.addEventListener("abort", () => abortController.abort(), { once: true });
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        authorization: `Bearer ${token}`
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: abortController.signal
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`Request timed out after ${options?.timeoutMs ?? 15000}ms`);
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }

  return response.json() as Promise<T>;
}

async function requestText(
  baseUrl: string,
  token: string,
  path: string,
  options?: { timeoutMs: number }
): Promise<string> {
  const response = await fetchWithTimeout(baseUrl, token, "GET", path, undefined, options);
  return response.text();
}

async function requestBlob(
  baseUrl: string,
  token: string,
  path: string,
  options?: { timeoutMs: number }
): Promise<Blob> {
  const response = await fetchWithTimeout(baseUrl, token, "GET", path, undefined, options);
  return response.blob();
}

async function requestForm<T>(
  baseUrl: string,
  token: string,
  path: string,
  body: FormData,
  options?: { timeoutMs: number }
): Promise<T> {
  const response = await fetchWithTimeout(baseUrl, token, "POST", path, body, options);
  return response.json() as Promise<T>;
}

async function fetchWithTimeout(
  baseUrl: string,
  token: string,
  method: "DELETE" | "GET" | "POST",
  path: string,
  body?: BodyInit,
  options?: { timeoutMs: number }
): Promise<Response> {
  const abortController = new AbortController();
  const timeout = globalThis.setTimeout(() => abortController.abort(), options?.timeoutMs ?? 15000);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`
      },
      body,
      signal: abortController.signal
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`Request timed out after ${options?.timeoutMs ?? 15000}ms`);
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }

  return response;
}

function defaultPathPrefix(pageUrl: string): string {
  const url = new URL(pageUrl);
  const pathname = url.pathname.endsWith("/") ? url.pathname : url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1);
  return pathname || "/";
}
