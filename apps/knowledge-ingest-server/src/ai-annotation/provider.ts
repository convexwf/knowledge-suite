import type { AIConfig } from "@uknowledge/knowledge-schema";
import { OllamaProvider, type OllamaConfig } from "./ollama.js";
import type { AIAnnotationType } from "@uknowledge/knowledge-schema";

export interface AIAnnotationRequest {
  headingText: string;
  headingLevel: number;
  scopeText: string;
  systemPrompt: string;
  maxTokens: number;
  signal?: AbortSignal;
}

export interface AIAnnotationResponse {
  text: string;
  model: string;
  tokensUsed?: number;
}

export interface AIAnnotationProvider {
  readonly name: string;
  generate(request: AIAnnotationRequest): Promise<AIAnnotationResponse>;
}

export function createAIProvider(config: AIConfig): AIAnnotationProvider {
  switch (config.provider) {
    case "ollama":
      return new OllamaProvider({
        baseUrl: process.env.KNOWLEDGE_AI_OLLAMA_BASE_URL ?? "http://localhost:11434",
        model: config.model,
        temperature: Number(process.env.KNOWLEDGE_AI_OLLAMA_TEMPERATURE ?? 0.5),
        apiKey: process.env.KNOWLEDGE_AI_OLLAMA_API_KEY,
        timeoutMs: Number(process.env.KNOWLEDGE_AI_OLLAMA_TIMEOUT_MS ?? 60000),
      });
    default:
      throw new Error(`Unknown AI provider: ${config.provider}`);
  }
}

export function getMaxTokens(type: AIAnnotationType, headingLevel?: number): number {
  if (type === "summary" && headingLevel != null) {
    if (headingLevel <= 1) return 400;
    if (headingLevel === 2) return 250;
    return 200;
  }
  const defaults: Record<AIAnnotationType, number> = {
    summary: 500,
    tag: 100,
    note: 300,
    highlight: 400,
  };
  return defaults[type];
}
