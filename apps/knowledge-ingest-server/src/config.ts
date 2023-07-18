import { resolve } from "node:path";

export interface ServerConfig {
  host: string;
  port: number;
  token: string;
  storeRoot: string;
}

export function loadConfig(): ServerConfig {
  return {
    host: process.env.KNOWLEDGE_HOST ?? "127.0.0.1",
    port: Number(process.env.KNOWLEDGE_PORT ?? 18765),
    token: process.env.KNOWLEDGE_TOKEN ?? "dev-token",
    storeRoot: resolve(process.env.KNOWLEDGE_STORE ?? "knowledge-store")
  };
}
