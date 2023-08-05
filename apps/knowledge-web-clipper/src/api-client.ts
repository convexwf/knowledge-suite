import {
  ClipDeleteResult,
  ClipListResult,
  ClipRequestBody,
  ClipStatusResult,
  ExtensionSettings,
  HealthResult,
  PreviewResult
} from "./types.js";

export interface KnowledgeApiClient {
  health(): Promise<HealthResult>;
  status(url: string): Promise<ClipStatusResult>;
  list(limit?: number): Promise<ClipListResult>;
  deleteClip(url: string, deleteFiles?: boolean): Promise<ClipDeleteResult>;
  preview(body: ClipRequestBody): Promise<PreviewResult>;
  save(body: ClipRequestBody): Promise<PreviewResult>;
}

export function createKnowledgeApiClient(settings: ExtensionSettings): KnowledgeApiClient {
  const baseUrl = settings.serverUrl.replace(/\/+$/, "");
  const options = {
    timeoutMs: settings.requestTimeoutMs
  };

  return {
    health: () => request<HealthResult>(baseUrl, settings.token, "GET", "/api/health", undefined, options),
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
    deleteClip: (url, deleteFiles = settings.deleteFilesByDefault) => request<ClipDeleteResult>(
      baseUrl,
      settings.token,
      "DELETE",
      `/api/clip?url=${encodeURIComponent(url)}&deleteFiles=${encodeURIComponent(String(deleteFiles))}`,
      undefined,
      options
    ),
    preview: (body) => request<PreviewResult>(baseUrl, settings.token, "POST", "/api/clip/preview", body, options),
    save: (body) => request<PreviewResult>(baseUrl, settings.token, "POST", "/api/clip/save", {
      ...body,
      overwrite: true
    }, options)
  };
}

async function request<T>(
  baseUrl: string,
  token: string,
  method: "DELETE" | "GET" | "POST",
  path: string,
  body?: unknown,
  options?: { timeoutMs: number }
): Promise<T> {
  const abortController = new AbortController();
  const timeout = globalThis.setTimeout(() => abortController.abort(), options?.timeoutMs ?? 15000);
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
