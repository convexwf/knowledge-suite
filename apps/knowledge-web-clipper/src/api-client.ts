import {
  AIAnnotationGenerateRequest,
  AIAnnotationGenerateResult,
  Annotation,
  AnnotationDeleteAllResult,
  AnnotationDeleteResult,
  AnnotationDocListResult,
  AnnotationListResult,
  AnnotationSaveResult,
  ClipDeleteResult,
  ClipDeleteMode,
  ClipListResult,
  ClipRequestBody,
  ClipSaveRequestBody,
  ClipStatusResult,
  ExtensionSettings,
  HealthResult,
  EpubImportResult,
  KnowledgeDocument,
  KnowledgeItemDeleteMode,
  KnowledgeItemDeleteResult,
  KnowledgeItemDetailResult,
  KnowledgeItemListResult,
  KnowledgeSourceType,
  PreviewResult,
  BatchCandidate,
  BatchDiscoverResult,
  BatchJobResult,
  StoreClearParsedResult,
  StoreClearResult,
  StoreMaintenanceScan,
  STORE_CLEAR_CONFIRMATION,
  STORE_CLEAR_PARSED_CONFIRMATION
} from "./types.js";

export interface KnowledgeApiClient {
  health(): Promise<HealthResult>;
  scanStore(): Promise<StoreMaintenanceScan>;
  clearStore(): Promise<StoreClearResult>;
  clearParsedResults(): Promise<StoreClearParsedResult>;
  status(url: string): Promise<ClipStatusResult>;
  list(limit?: number): Promise<ClipListResult>;
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
  deleteClip(url: string, mode?: ClipDeleteMode): Promise<ClipDeleteResult>;
  reparse(url: string): Promise<PreviewResult>;
  preview(body: ClipRequestBody): Promise<PreviewResult>;
  save(body: ClipSaveRequestBody): Promise<PreviewResult>;
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
  annotations(docId: string): Promise<AnnotationListResult>;
  saveAnnotation(docId: string, annotation: Annotation): Promise<AnnotationSaveResult>;
  deleteAnnotation(docId: string, annotationId: string): Promise<AnnotationDeleteResult>;
  deleteAnnotationsForDoc(docId: string): Promise<AnnotationDeleteAllResult>;
  listAnnotationDocs(): Promise<AnnotationDocListResult>;
  generateAIAnnotations(docId: string, body: AIAnnotationGenerateRequest, signal?: AbortSignal): Promise<AIAnnotationGenerateResult>;
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
    status: (url) => request<ClipStatusResult>(
      baseUrl,
      settings.token,
      "GET",
      `/api/clip/status?url=${encodeURIComponent(url)}`,
      undefined,
      options
    ),
    list: (limit = settings.savedListLimit) => request<ClipListResult>(
      baseUrl,
      settings.token,
      "GET",
      `/api/clips?limit=${encodeURIComponent(String(limit))}`,
      undefined,
      options
    ),
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
    deleteClip: (url, mode = "remove") => request<ClipDeleteResult>(
      baseUrl,
      settings.token,
      "DELETE",
      `/api/clip?url=${encodeURIComponent(url)}&mode=${encodeURIComponent(mode)}`,
      undefined,
      options
    ),
    reparse: (url) => request<PreviewResult>(baseUrl, settings.token, "POST", "/api/clip/reparse", { url }, options),
    preview: (body) => request<PreviewResult>(baseUrl, settings.token, "POST", "/api/clip/preview", body, options),
    save: (body) => request<PreviewResult>(baseUrl, settings.token, "POST", "/api/clip/save", {
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
    annotations: (docId) => request<AnnotationListResult>(
      baseUrl,
      settings.token,
      "GET",
      `/api/documents/${encodeURIComponent(docId)}/annotations`,
      undefined,
      options
    ),
    saveAnnotation: (docId, annotation) => request<AnnotationSaveResult>(
      baseUrl,
      settings.token,
      "POST",
      `/api/documents/${encodeURIComponent(docId)}/annotations`,
      annotation,
      options
    ),
    deleteAnnotation: (docId, annotationId) => request<AnnotationDeleteResult>(
      baseUrl,
      settings.token,
      "DELETE",
      `/api/documents/${encodeURIComponent(docId)}/annotations/${encodeURIComponent(annotationId)}`,
      undefined,
      options
    ),
    deleteAnnotationsForDoc: (docId) => request<AnnotationDeleteAllResult>(
      baseUrl,
      settings.token,
      "DELETE",
      `/api/documents/${encodeURIComponent(docId)}/annotations`,
      undefined,
      options
    ),
    listAnnotationDocs: () => request<AnnotationDocListResult>(
      baseUrl,
      settings.token,
      "GET",
      "/api/annotations",
      undefined,
      options
    ),
    generateAIAnnotations: (docId, body, signal) => request<AIAnnotationGenerateResult>(
      baseUrl,
      settings.token,
      "POST",
      `/api/documents/${encodeURIComponent(docId)}/ai-annotations`,
      body,
      { timeoutMs: 300000, signal }
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
