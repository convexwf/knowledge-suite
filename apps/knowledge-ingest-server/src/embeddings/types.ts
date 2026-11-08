export interface KnowledgeEmbedder {
  readonly provider: string;
  readonly model: string;
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}
