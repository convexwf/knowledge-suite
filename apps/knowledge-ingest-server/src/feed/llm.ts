import type { FeedAiConfig } from "../config.js";

export interface FeedLlmRequest {
  system: string;
  user: string;
  maxTokens: number;
  signal?: AbortSignal;
}

/** The summary model: a small model that only ever returns a JSON object. */
export interface FeedLlm {
  readonly model: string;
  completeJson(request: FeedLlmRequest): Promise<unknown>;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

/** OpenAI-compatible chat completions client (Ollama, vLLM, hosted gateways). */
export class OpenAiCompatibleFeedLlm implements FeedLlm {
  readonly model: string;

  constructor(private readonly config: FeedAiConfig) {
    this.model = config.model;
  }

  async completeJson(request: FeedLlmRequest): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: this.config.model,
        temperature: 0.2,
        max_tokens: request.maxTokens,
        response_format: { type: "json_object" },
        options: { num_ctx: 8192 },
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user }
        ]
      }),
      signal: request.signal ? AbortSignal.any([timeout, request.signal]) : timeout
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Feed summary model failed (${response.status}): ${body.slice(0, 300)}`);
    }
    const data = await response.json() as ChatCompletionResponse;
    const text = data.choices?.[0]?.message?.content ?? "";
    return parseJsonObject(text);
  }
}

/** Accepts a bare JSON object, one wrapped in a code fence, or one with stray prose around it. */
export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Feed summary model returned an empty response");
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidates = [trimmed, fenced?.[1]?.trim()];
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error("Feed summary model did not return a JSON object");
}

/** Rough token estimate: CJK characters count one each, other text about four characters per token. */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if ((code >= 0x3040 && code <= 0x30ff) || (code >= 0x3400 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af)) {
      cjk += 1;
    }
  }
  return cjk + Math.ceil((text.length - cjk) / 4);
}
