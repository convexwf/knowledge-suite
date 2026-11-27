import type { ExtensionSettings, KnowledgeDocument } from "./types.js";

// Mirrors the feed types of @uknowledge/knowledge-schema; the extension keeps
// its own copies like the rest of ./types.ts.

export interface FeedSourceStats {
  discovered: number;
  selected: number;
  briefed: number;
  opened: number;
  starred: number;
  dismissed: number;
}

export interface FeedSource {
  sourceId: string;
  kind: "rss" | "listing";
  title: string;
  url: string;
  linkPattern?: string;
  enabled: boolean;
  weight: number;
  lastRunAt?: string;
  lastError?: string;
  createdAt: string;
  createdBy?: string;
  updatedBy?: string;
  stats?: FeedSourceStats;
}

export interface FeedEntry {
  entryId: string;
  sourceId: string;
  sourceTitle?: string;
  url: string;
  title: string;
  summary?: string;
  publishedAt?: string;
  discoveredAt: string;
  stage: "discovered" | "scored" | "fetched" | "fetch_failed";
  score?: number;
  effectiveScore?: number;
  scoreReason?: string;
  topics: string[];
  selected: boolean;
  exploration: boolean;
  rescued: boolean;
  hasDocument: boolean;
  dismissedAt?: string;
  promotedItemId?: string;
  expiresAt: string;
  lastError?: string;
}

export interface FeedEntryState {
  exists: boolean;
  hasDocument: boolean;
  promotedItemId?: string;
  dismissedAt?: string;
}

export interface FeedPoint {
  pointId: string;
  entryId: string;
  text: string;
  sectionId?: string;
  quote?: string;
  used: boolean;
}

export interface FeedBriefingSummary {
  briefingId: string;
  date: string;
  state: "pending" | "composed";
  composer?: string;
  revision: number;
  preparedAt: string;
  composedAt?: string;
  pointCount: number;
  entryCount: number;
}

export interface FeedBriefingRef {
  pointId: string;
  entryId: string;
  sectionId?: string;
  quote?: string;
  title: string;
  url: string;
}

export interface FeedBriefingContent {
  date: string;
  composer: string;
  summary?: string;
  stats: { scored: number; selected: number; candidatePoints: number; usedPoints: number };
  topics: Array<{
    title: string;
    overview?: string;
    items: Array<{ text: string; rewritten: boolean; refs: FeedBriefingRef[] }>;
  }>;
}

export interface FeedBriefingDetail {
  briefing: FeedBriefingSummary;
  content?: FeedBriefingContent;
  entries: Record<string, FeedEntryState>;
}

export interface FeedCandidateEntry {
  entryId: string;
  title: string;
  url: string;
  sourceTitle?: string;
  publishedAt?: string;
  score?: number;
  effectiveScore?: number;
  scoreReason?: string;
  topics: string[];
  exploration: boolean;
  rescued: boolean;
  fetchFailed: boolean;
  state: FeedEntryState;
  points: FeedPoint[];
}

export interface FeedCandidates {
  briefing: FeedBriefingSummary;
  entries: FeedCandidateEntry[];
  skipped: Array<{ entryId: string; title: string; sourceTitle?: string; effectiveScore?: number }>;
  rescueRemaining: number;
}

export interface FeedRun {
  runId: string;
  triggeredBy: string;
  state: "running" | "completed" | "partial" | "failed";
  stats: Record<string, number | string>;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface FeedStatus {
  enabled: true;
  running: boolean;
  run?: FeedRun;
  pendingBriefings: number;
  summaryModel: string;
}

export interface FeedSettings {
  coarseHint: string;
  updatedAt?: string;
  updatedBy?: string;
}

/** A non-2xx answer from a feed endpoint, with the parsed error body. */
export class FeedApiError extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super(typeof body.message === "string" ? body.message : `Feed request failed (${status})`);
    this.name = "FeedApiError";
  }

  get code(): string | undefined {
    return typeof this.body.error === "string" ? this.body.error : undefined;
  }
}

export interface FeedApiClient {
  status(): Promise<FeedStatus>;
  run(triggeredBy: string): Promise<{ runId: string }>;
  sources(): Promise<FeedSource[]>;
  addSource(input: { kind: "rss" | "listing"; title: string; url: string; linkPattern?: string }): Promise<FeedSource>;
  updateSource(sourceId: string, patch: { enabled?: boolean; weight?: number; title?: string }): Promise<FeedSource>;
  deleteSource(sourceId: string): Promise<void>;
  entries(filter: { sourceId?: string; selected?: boolean; cursor?: string; limit?: number }): Promise<{
    entries: FeedEntry[];
    total: number;
    nextCursor?: string;
  }>;
  entryDocument(entryId: string): Promise<{ entry: FeedEntry; document: KnowledgeDocument }>;
  star(entryId: string): Promise<{ itemId: string }>;
  dismiss(entryId: string): Promise<void>;
  signal(entryId: string, type: "open" | "open_original"): Promise<void>;
  briefings(): Promise<FeedBriefingSummary[]>;
  briefing(briefingId: string): Promise<FeedBriefingDetail>;
  candidates(briefingId: string): Promise<FeedCandidates>;
  settings(): Promise<FeedSettings>;
  saveSettings(coarseHint: string): Promise<FeedSettings>;
}

export function createFeedApiClient(settings: ExtensionSettings): FeedApiClient {
  const baseUrl = settings.serverUrl.replace(/\/+$/, "");
  const actor = settings.annotatorName?.trim() || "user";

  async function request<T>(method: string, path: string, body?: unknown, timeoutMs = settings.requestTimeoutMs): Promise<T> {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${settings.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error(`Request timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      globalThis.clearTimeout(timeout);
    }
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { message: text };
    }
    if (!response.ok) {
      throw new FeedApiError(response.status, (parsed ?? {}) as Record<string, unknown>);
    }
    return parsed as T;
  }

  const id = encodeURIComponent;
  return {
    status: () => request<FeedStatus>("GET", "/api/feed/status"),
    run: (triggeredBy) => request<{ runId: string }>("POST", "/api/feed/run", { triggeredBy }),
    sources: async () => (await request<{ sources: FeedSource[] }>("GET", "/api/feed/sources")).sources,
    addSource: async (input) =>
      (await request<{ source: FeedSource }>("POST", "/api/feed/sources", { ...input, createdBy: actor })).source,
    updateSource: async (sourceId, patch) =>
      (await request<{ source: FeedSource }>("PATCH", `/api/feed/sources/${id(sourceId)}`, { ...patch, updatedBy: actor })).source,
    deleteSource: async (sourceId) => {
      await request("DELETE", `/api/feed/sources/${id(sourceId)}`);
    },
    entries: (filter) => {
      const params = new URLSearchParams();
      if (filter.sourceId) params.set("sourceId", filter.sourceId);
      if (filter.selected !== undefined) params.set("selected", String(filter.selected));
      if (filter.cursor) params.set("cursor", filter.cursor);
      params.set("limit", String(filter.limit ?? 50));
      return request("GET", `/api/feed/entries?${params.toString()}`);
    },
    entryDocument: (entryId) => request("GET", `/api/feed/entries/${id(entryId)}/document`),
    // Promotion may fetch and parse the page, so allow more time than a normal request.
    star: (entryId) => request("POST", `/api/feed/entries/${id(entryId)}/star`, {}, Math.max(settings.requestTimeoutMs, 60000)),
    dismiss: async (entryId) => {
      await request("POST", `/api/feed/entries/${id(entryId)}/dismiss`, {});
    },
    signal: async (entryId, type) => {
      await request("POST", `/api/feed/entries/${id(entryId)}/signals`, { type });
    },
    briefings: async () => (await request<{ briefings: FeedBriefingSummary[] }>("GET", "/api/feed/briefings?limit=90")).briefings,
    briefing: (briefingId) => request("GET", `/api/feed/briefings/${id(briefingId)}`),
    candidates: (briefingId) => request("GET", `/api/feed/briefings/${id(briefingId)}/candidates`),
    settings: async () => (await request<{ settings: FeedSettings }>("GET", "/api/feed/settings")).settings,
    saveSettings: async (coarseHint) =>
      (await request<{ settings: FeedSettings }>("PUT", "/api/feed/settings", { coarseHint, updatedBy: actor })).settings
  };
}

/** Reader URL for a feed citation; the section is omitted for entry-level citations. */
export function feedReaderPath(entryId: string, sectionId?: string): string {
  const params = new URLSearchParams({ feedEntryId: entryId });
  if (sectionId) params.set("sectionId", sectionId);
  return `reader.html?${params.toString()}`;
}

/** Only http(s) URLs may become link targets; anything else is shown as text. */
export function safeExternalUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function formatScore(value: number | undefined): string {
  return value === undefined ? "–" : String(Math.round(value));
}
