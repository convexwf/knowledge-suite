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

export interface ServerConfig {
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
}

export function loadConfig(): ServerConfig {
  return {
    host: process.env.KNOWLEDGE_HOST ?? "127.0.0.1",
    port: Number(process.env.KNOWLEDGE_PORT ?? 18765),
    token: process.env.KNOWLEDGE_TOKEN ?? "dev-token",
    storeRoot: resolve(process.env.KNOWLEDGE_STORE ?? "knowledge-store"),
    fetchTimeoutMs: Number(process.env.KNOWLEDGE_FETCH_TIMEOUT_MS ?? 15000),
    maxHtmlBytes: Number(process.env.KNOWLEDGE_MAX_HTML_BYTES ?? 10 * 1024 * 1024),
    maxImportBytes: Number(process.env.KNOWLEDGE_MAX_IMPORT_BYTES ?? 100 * 1024 * 1024),
    githubToken: process.env.KNOWLEDGE_GITHUB_TOKEN || process.env.GITHUB_TOKEN || undefined,
    githubApiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com",
    maxGithubFiles: Number(process.env.KNOWLEDGE_MAX_GITHUB_FILES ?? 100),
    maxGithubMarkdownBytes: Number(process.env.KNOWLEDGE_MAX_GITHUB_MARKDOWN_BYTES ?? 5 * 1024 * 1024),
    maxGithubAssetReferences: Number(process.env.KNOWLEDGE_MAX_GITHUB_ASSET_REFERENCES ?? 500),
    maxGithubAssetBytes: Number(process.env.KNOWLEDGE_MAX_GITHUB_ASSET_BYTES ?? 20 * 1024 * 1024),
    search: parseSearchMode(process.env.KNOWLEDGE_SEARCH),
    embeddings: parseEmbeddingConfig()
  };
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
