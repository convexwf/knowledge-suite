import type { EmbeddingConfig } from "../config.js";
import { OllamaEmbedder } from "./ollama.js";
import type { KnowledgeEmbedder } from "./types.js";

export type { KnowledgeEmbedder } from "./types.js";
export { cosineSimilarity, normalizeVector } from "./ollama.js";

export function createEmbedder(config: EmbeddingConfig | undefined): KnowledgeEmbedder | undefined {
  if (!config || config.provider !== "ollama") return undefined;
  return new OllamaEmbedder({
    baseUrl: config.baseUrl,
    model: config.model,
    dim: config.dim,
    batchSize: config.batchSize,
    timeoutMs: config.timeoutMs
  });
}
