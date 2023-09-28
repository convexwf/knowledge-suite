import type { AIAnnotationProvider, AIAnnotationRequest, AIAnnotationResponse } from "./provider.js";

export interface OllamaConfig {
  baseUrl: string;
  model: string;
  temperature: number;
  apiKey?: string;
  timeoutMs: number;
}

interface OllamaChatResponse {
  choices?: Array<{
    message?: { role: string; content: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class OllamaProvider implements AIAnnotationProvider {
  readonly name = "ollama";

  constructor(private config: OllamaConfig) {}

  async generate(request: AIAnnotationRequest): Promise<AIAnnotationResponse> {
    const response = await fetch(
      `${this.config.baseUrl}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.config.apiKey
            ? { Authorization: `Bearer ${this.config.apiKey}` }
            : {}),
        },
        body: JSON.stringify({
          model: this.config.model,
          temperature: this.config.temperature,
          max_tokens: request.maxTokens,
          messages: [
            { role: "system", content: request.systemPrompt },
            {
              role: "user",
              content: [
                `标题：${request.headingText}`,
                `---`,
                request.scopeText,
              ].join("\n"),
            },
          ],
        }),
        signal: AbortSignal.any([
          AbortSignal.timeout(this.config.timeoutMs),
          ...(request.signal ? [request.signal] : []),
        ]),
      }
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Ollama generate failed (${response.status}): ${body.slice(0, 500)}`
      );
    }

    const data = (await response.json()) as OllamaChatResponse;
    const text = data.choices?.[0]?.message?.content?.trim() ?? "";

    if (!text) {
      throw new Error("Ollama returned empty response");
    }

    return {
      text,
      model: this.config.model,
      tokensUsed: data.usage?.total_tokens,
    };
  }
}
