import { resolve } from "node:path";

export type SearchMode = "off" | "fts" | "hybrid";
export type EmbeddingProvider = "none" | "ollama";

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  baseUrl: string;
  model: string;
  dim: number;
  batchSize: number;
  timeoutMs: number;
}

export interface SyncConfig {
  enabled: boolean;
  sourceUrl: string;
  sourceToken: string;
  at: string;
  timeoutMs: number;
}

export interface FeedAiConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
}

export interface FeedConfig {
  enabled: boolean;
  maxDiscoverPerSource: number;
  maxFulltextPerRun: number;
  maxRescuePerBriefing: number;
  minScore: number;
  retentionDays: number;
  skippedRetentionDays: number;
  briefingRetentionDays: number;
  tombstoneDays: number;
  outputLanguage: string;
  ai: FeedAiConfig;
}

export interface ServerConfig {
  categories: string[];
  host: string;
  port: number;
  token: string;
  storeRoot: string;
  fetchTimeoutMs: number;
  maxHtmlBytes: number;
  maxImportBytes: number;
  githubToken?: string;
  githubApiUrl?: string;
  maxGithubFiles?: number;
  maxGithubMarkdownBytes?: number;
  maxGithubAssetReferences?: number;
  maxGithubAssetBytes?: number;
  search?: SearchMode;
  embeddings?: EmbeddingConfig;
  sync?: SyncConfig;
  feed?: FeedConfig;
}

export function loadConfig(): ServerConfig {
  return {
    categories: parseCategories(process.env.KNOWLEDGE_CATEGORIES),
    host: process.env.KNOWLEDGE_HOST ?? "127.0.0.1",
    port: Number(process.env.KNOWLEDGE_PORT ?? 18765),
    token: process.env.KNOWLEDGE_TOKEN ?? "dev-token",
    storeRoot: resolve(process.env.KNOWLEDGE_STORE ?? "knowledge-store"),
    fetchTimeoutMs: Number(process.env.KNOWLEDGE_FETCH_TIMEOUT_MS ?? 15000),
    maxHtmlBytes: Number(process.env.KNOWLEDGE_MAX_HTML_BYTES ?? 10 * 1024 * 1024),
    maxImportBytes: Number(process.env.KNOWLEDGE_MAX_IMPORT_BYTES ?? 100 * 1024 * 1024),
    githubToken: process.env.KNOWLEDGE_GITHUB_TOKEN || undefined,
    githubApiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com",
    maxGithubFiles: Number(process.env.KNOWLEDGE_MAX_GITHUB_FILES ?? 100),
    maxGithubMarkdownBytes: Number(process.env.KNOWLEDGE_MAX_GITHUB_MARKDOWN_BYTES ?? 5 * 1024 * 1024),
    maxGithubAssetReferences: Number(process.env.KNOWLEDGE_MAX_GITHUB_ASSET_REFERENCES ?? 500),
    maxGithubAssetBytes: Number(process.env.KNOWLEDGE_MAX_GITHUB_ASSET_BYTES ?? 20 * 1024 * 1024),
    search: parseSearchMode(process.env.KNOWLEDGE_SEARCH),
    embeddings: parseEmbeddingConfig(),
    sync: parseSyncConfig(),
    feed: parseFeedConfig()
  };
}

function parseCategories(value: string | undefined): string[] {
  const categories = [...new Set((value ?? "default,bot")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean))];
  if (categories.length === 0 || !categories.includes("default")) {
    throw new Error("KNOWLEDGE_CATEGORIES must register the required 'default' category");
  }
  for (const category of categories) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(category)) {
      throw new Error(`Invalid category '${category}' in KNOWLEDGE_CATEGORIES; use lowercase slugs`);
    }
  }
  return ["default", ...categories.filter((category) => category !== "default")];
}

function parseSearchMode(value: string | undefined): SearchMode {
  const normalized = (value ?? "fts").trim().toLowerCase();
  return normalized === "off" || normalized === "hybrid" ? normalized : "fts";
}

function parseEmbeddingConfig(): EmbeddingConfig {
  const provider = (process.env.KNOWLEDGE_EMBEDDINGS ?? "none").trim().toLowerCase();
  return {
    provider: provider === "ollama" ? "ollama" : "none",
    baseUrl: process.env.KNOWLEDGE_EMBEDDING_BASE_URL ?? "http://127.0.0.1:11434",
    model: process.env.KNOWLEDGE_EMBEDDING_MODEL ?? "bge-m3",
    dim: positiveInt(process.env.KNOWLEDGE_EMBEDDING_DIM, 1024),
    batchSize: positiveInt(process.env.KNOWLEDGE_EMBEDDING_BATCH_SIZE, 16),
    timeoutMs: positiveInt(process.env.KNOWLEDGE_EMBEDDING_TIMEOUT_MS, 60000)
  };
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function parseSyncConfig(): SyncConfig | undefined {
  const sourceUrl = (process.env.KNOWLEDGE_SYNC_SOURCE_URL ?? "").trim();
  const sourceToken = (process.env.KNOWLEDGE_SYNC_SOURCE_TOKEN ?? "").trim();
  if (!sourceUrl && !sourceToken) return undefined;
  return {
    enabled: Boolean(sourceUrl && sourceToken),
    sourceUrl,
    sourceToken,
    at: parseSyncAt(process.env.KNOWLEDGE_SYNC_AT),
    timeoutMs: positiveInt(process.env.KNOWLEDGE_SYNC_TIMEOUT_MS, 300000)
  };
}

function parseSyncAt(value: string | undefined): string {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec((value ?? "").trim());
  return match ? `${match[1]}:${match[2]}` : "19:00";
}

export function defaultFeedConfig(overrides: Partial<FeedConfig> = {}): FeedConfig {
  return {
    enabled: false,
    maxDiscoverPerSource: 50,
    maxFulltextPerRun: 40,
    maxRescuePerBriefing: 10,
    minScore: 40,
    retentionDays: 14,
    skippedRetentionDays: 3,
    briefingRetentionDays: 90,
    tombstoneDays: 180,
    outputLanguage: "简体中文",
    ai: {
      baseUrl: "http://localhost:11434",
      model: "qwen2.5:7b",
      timeoutMs: 120000
    },
    ...overrides
  };
}

function parseFeedConfig(): FeedConfig {
  const defaults = defaultFeedConfig();
  const briefingRetentionDays = positiveInt(process.env.KNOWLEDGE_FEED_BRIEFING_RETENTION_DAYS, defaults.briefingRetentionDays);
  return {
    enabled: process.env.KNOWLEDGE_FEED_ENABLED === "true",
    maxDiscoverPerSource: positiveInt(process.env.KNOWLEDGE_FEED_MAX_DISCOVER_PER_SOURCE, defaults.maxDiscoverPerSource),
    maxFulltextPerRun: positiveInt(process.env.KNOWLEDGE_FEED_MAX_FULLTEXT_PER_RUN, defaults.maxFulltextPerRun),
    maxRescuePerBriefing: positiveInt(process.env.KNOWLEDGE_FEED_MAX_RESCUE_PER_BRIEFING, defaults.maxRescuePerBriefing),
    minScore: positiveInt(process.env.KNOWLEDGE_FEED_MIN_SCORE, defaults.minScore),
    retentionDays: positiveInt(process.env.KNOWLEDGE_FEED_RETENTION_DAYS, defaults.retentionDays),
    skippedRetentionDays: positiveInt(process.env.KNOWLEDGE_FEED_SKIPPED_RETENTION_DAYS, defaults.skippedRetentionDays),
    briefingRetentionDays,
    // Tombstones resolve old briefing links, so they must outlive briefings.
    tombstoneDays: Math.max(
      briefingRetentionDays,
      positiveInt(process.env.KNOWLEDGE_FEED_TOMBSTONE_DAYS, defaults.tombstoneDays)
    ),
    outputLanguage: (process.env.KNOWLEDGE_FEED_OUTPUT_LANGUAGE ?? "").trim() || defaults.outputLanguage,
    ai: {
      baseUrl: process.env.KNOWLEDGE_FEED_AI_BASE_URL
        || process.env.KNOWLEDGE_AI_OLLAMA_BASE_URL
        || defaults.ai.baseUrl,
      model: process.env.KNOWLEDGE_FEED_AI_MODEL
        || process.env.KNOWLEDGE_AI_OLLAMA_MODEL
        || defaults.ai.model,
      apiKey: process.env.KNOWLEDGE_FEED_AI_API_KEY || process.env.KNOWLEDGE_AI_OLLAMA_API_KEY || undefined,
      timeoutMs: positiveInt(
        process.env.KNOWLEDGE_FEED_AI_TIMEOUT_MS ?? process.env.KNOWLEDGE_AI_OLLAMA_TIMEOUT_MS,
        defaults.ai.timeoutMs
      )
    }
  };
}
