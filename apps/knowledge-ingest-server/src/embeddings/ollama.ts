import type { KnowledgeEmbedder } from "./types.js";

export interface OllamaEmbedderConfig {
  baseUrl: string;
  model: string;
  dim: number;
  batchSize: number;
  timeoutMs: number;
}

interface OllamaEmbedResponse {
  embeddings?: number[][];
}

export class OllamaEmbedder implements KnowledgeEmbedder {
  readonly provider = "ollama";
  readonly model: string;
  readonly dim: number;

  constructor(private readonly config: OllamaEmbedderConfig) {
    this.model = config.model;
    this.dim = config.dim;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const batchSize = Math.max(1, Math.trunc(this.config.batchSize) || 16);
    const vectors: Float32Array[] = [];
    for (let offset = 0; offset < texts.length; offset += batchSize) {
      const batch = texts.slice(offset, offset + batchSize);
      vectors.push(...await this.embedBatch(batch));
    }
    return vectors;
  }

  private async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const endpoint = `${this.config.baseUrl.replace(/\/$/, "")}/api/embed`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts }),
      signal: AbortSignal.timeout(this.config.timeoutMs)
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Ollama embed failed (${response.status}): ${body.slice(0, 300)}`);
    }
    const data = await response.json() as OllamaEmbedResponse;
    const embeddings = data.embeddings;
    if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
      throw new Error(`Ollama embed returned ${embeddings?.length ?? 0} vectors for ${texts.length} inputs`);
    }
    return embeddings.map((values, index) => {
      if (!Array.isArray(values) || values.length !== this.dim) {
        throw new Error(`Ollama embed vector ${index} has dimension ${values?.length ?? 0}, expected ${this.dim}`);
      }
      return normalizeVector(values);
    });
  }
}

export function normalizeVector(values: ArrayLike<number>): Float32Array {
  const vector = new Float32Array(values.length);
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = Number(values[index]);
    vector[index] = value;
    sum += value * value;
  }
  const norm = Math.sqrt(sum);
  if (norm > 0) {
    for (let index = 0; index < vector.length; index += 1) {
      vector[index] /= norm;
    }
  }
  return vector;
}

export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
  }
  return dot;
}
