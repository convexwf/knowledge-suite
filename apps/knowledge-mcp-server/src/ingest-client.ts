// ingest-client.ts — HTTP client for knowledge-ingest-server API
const BASE_URL = process.env.KNOWLEDGE_BASE_URL ?? "http://127.0.0.1:18765";
const TOKEN = process.env.KNOWLEDGE_TOKEN ?? "dev-token";
const TIMEOUT_MS = Number(
  process.env.KNOWLEDGE_REQUEST_TIMEOUT_MS ?? 30000,
);

export interface SearchParams {
  query: string;
  limit?: number;
  docId?: string;
  url?: string;
  parserMethod?: string;
  trace?: boolean;
}

export interface ContextParams {
  query: string;
  limit?: number;
  maxChars?: number;
  docId?: string;
  url?: string;
  parserMethod?: string;
  trace?: boolean;
}

interface IngestSearchResponse {
  query: string;
  retriever: string;
  results: Array<Record<string, unknown>>;
}

interface IngestContextResponse {
  query: string;
  retriever: string;
  packer: string;
  budget: { maxChars: number; usedChars: number };
  contextText: string;
  citations: Array<Record<string, unknown>>;
}

export async function searchKnowledge(
  params: SearchParams,
): Promise<IngestSearchResponse> {
  const url = new URL("/api/search", BASE_URL);
  url.searchParams.set("q", params.query);
  if (params.limit != null) url.searchParams.set("limit", String(params.limit));
  if (params.docId) url.searchParams.set("docId", params.docId);
  if (params.url) url.searchParams.set("url", params.url);
  if (params.parserMethod)
    url.searchParams.set("parserMethod", params.parserMethod);
  if (params.trace) url.searchParams.set("trace", "true");

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ingest server returned ${res.status}: ${body}`);
  }

  return res.json() as Promise<IngestSearchResponse>;
}

export async function getKnowledgeContext(
  params: ContextParams,
): Promise<IngestContextResponse> {
  const url = new URL("/api/context", BASE_URL);
  url.searchParams.set("q", params.query);
  if (params.limit != null) url.searchParams.set("limit", String(params.limit));
  if (params.maxChars != null)
    url.searchParams.set("maxChars", String(params.maxChars));
  if (params.docId) url.searchParams.set("docId", params.docId);
  if (params.url) url.searchParams.set("url", params.url);
  if (params.parserMethod)
    url.searchParams.set("parserMethod", params.parserMethod);
  if (params.trace) url.searchParams.set("trace", "true");

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ingest server returned ${res.status}: ${body}`);
  }

  return res.json() as Promise<IngestContextResponse>;
}
