import { resolve } from "node:path";

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
    maxGithubAssetBytes: Number(process.env.KNOWLEDGE_MAX_GITHUB_ASSET_BYTES ?? 20 * 1024 * 1024)
  };
}
