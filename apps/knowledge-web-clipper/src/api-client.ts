import {
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
  preview(body: ClipRequestBody): Promise<PreviewResult>;
  save(body: ClipRequestBody): Promise<PreviewResult>;
}

export function createKnowledgeApiClient(settings: ExtensionSettings): KnowledgeApiClient {
  const baseUrl = settings.serverUrl.replace(/\/+$/, "");

  return {
    health: () => request<HealthResult>(baseUrl, settings.token, "GET", "/api/health"),
    status: (url) => request<ClipStatusResult>(
      baseUrl,
      settings.token,
      "GET",
      `/api/clip/status?url=${encodeURIComponent(url)}`
    ),
    list: (limit = 50) => request<ClipListResult>(
      baseUrl,
      settings.token,
      "GET",
      `/api/clips?limit=${encodeURIComponent(String(limit))}`
    ),
    preview: (body) => request<PreviewResult>(baseUrl, settings.token, "POST", "/api/clip/preview", body),
    save: (body) => request<PreviewResult>(baseUrl, settings.token, "POST", "/api/clip/save", {
      ...body,
      overwrite: true
    })
  };
}

async function request<T>(
  baseUrl: string,
  token: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      authorization: `Bearer ${token}`
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }

  return response.json() as Promise<T>;
}
