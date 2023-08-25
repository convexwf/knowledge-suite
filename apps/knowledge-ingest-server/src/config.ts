import { resolve } from "node:path";

export interface ServerConfig {
  host: string;
  port: number;
  token: string;
  storeRoot: string;
  fetchTimeoutMs: number;
  maxHtmlBytes: number;
  maxImportBytes: number;
}

export function loadConfig(): ServerConfig {
  return {
    host: process.env.KNOWLEDGE_HOST ?? "127.0.0.1",
    port: Number(process.env.KNOWLEDGE_PORT ?? 18765),
    token: process.env.KNOWLEDGE_TOKEN ?? "dev-token",
    storeRoot: resolve(process.env.KNOWLEDGE_STORE ?? "knowledge-store"),
    fetchTimeoutMs: Number(process.env.KNOWLEDGE_FETCH_TIMEOUT_MS ?? 15000),
    maxHtmlBytes: Number(process.env.KNOWLEDGE_MAX_HTML_BYTES ?? 10 * 1024 * 1024),
    maxImportBytes: Number(process.env.KNOWLEDGE_MAX_IMPORT_BYTES ?? 100 * 1024 * 1024)
  };
}
