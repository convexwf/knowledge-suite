import {
  ClipInput,
  isFileUrl,
  normalizeUrlForKnowledge,
  nowIso,
  PageSnapshot
} from "@uknowledge/knowledge-schema";
import { ServerConfig } from "./config.js";

export interface ResolvedInput {
  inputMode: ClipInput["inputMode"];
  url: string;
  normalizedUrl: string;
  html: string;
  title?: string;
  meta: Record<string, string>;
  capturedAt: string;
}

export async function resolveClipInput(input: ClipInput, config: ServerConfig): Promise<ResolvedInput> {
  if (input.inputMode === "browser_html") {
    return fromSnapshot(input.snapshot, config);
  }

  if (isFileUrl(input.url)) {
    throw new Error("server_fetch does not support file:// URLs; use browser_html instead.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.fetchTimeoutMs);
  let response: Response;

  try {
    response = await fetch(input.url, {
      headers: {
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        "user-agent": "knowledge-ingest-server/0.1"
      },
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Timed out fetching ${input.url} after ${config.fetchTimeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch ${input.url}: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType && !isHtmlContentType(contentType)) {
    throw new Error(`Expected HTML from ${input.url}, got ${contentType}`);
  }

  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > config.maxHtmlBytes) {
    throw new Error(`HTML response from ${input.url} is too large: ${contentLength} bytes`);
  }

  const html = await response.text();
  if (Buffer.byteLength(html) > config.maxHtmlBytes) {
    throw new Error(`HTML response from ${input.url} is too large: ${Buffer.byteLength(html)} bytes`);
  }

  return {
    inputMode: "server_fetch",
    url: input.url,
    normalizedUrl: normalizeUrlForKnowledge(input.url),
    html,
    meta: {},
    capturedAt: nowIso()
  };
}

function fromSnapshot(snapshot: PageSnapshot, config: ServerConfig): ResolvedInput {
  const url = snapshot.canonicalUrl || snapshot.pageUrl;
  const htmlBytes = Buffer.byteLength(snapshot.html);
  if (htmlBytes > config.maxHtmlBytes) {
    throw new Error(`Page HTML is too large: ${htmlBytes} bytes`);
  }

  return {
    inputMode: "browser_html",
    url,
    normalizedUrl: normalizeUrlForKnowledge(url),
    html: snapshot.html,
    title: snapshot.title,
    meta: snapshot.meta,
    capturedAt: snapshot.capturedAt
  };
}

function isHtmlContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return normalized.includes("text/html") || normalized.includes("application/xhtml+xml");
}
