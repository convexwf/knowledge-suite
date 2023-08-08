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
  fetchUrl?: string;
  normalizedUrl: string;
  html: string;
  title?: string;
  meta: Record<string, string>;
  capturedAt: string;
  selectionHtml?: string;
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

  const fetchUrl = arxivHtmlFetchUrl(input.url);

  try {
    response = await fetch(fetchUrl, {
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
    throw new Error(`Failed to fetch ${fetchUrl}: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType && !isHtmlContentType(contentType)) {
    throw new Error(`Expected HTML from ${fetchUrl}, got ${contentType}`);
  }

  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > config.maxHtmlBytes) {
    throw new Error(
      `HTML response from ${fetchUrl} is too large: ${contentLength} bytes. Server Fetch cannot process this page unless KNOWLEDGE_MAX_HTML_BYTES is increased.`
    );
  }

  const html = await response.text();
  if (Buffer.byteLength(html) > config.maxHtmlBytes) {
    throw new Error(
      `HTML response from ${input.url} is too large: ${Buffer.byteLength(
        html
      )} bytes. Server Fetch cannot process this page unless KNOWLEDGE_MAX_HTML_BYTES is increased.`
    );
  }

  return {
    inputMode: "server_fetch",
    url: input.url,
    fetchUrl,
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
    throw new Error(
      `Page HTML is too large for Current HTML mode: ${htmlBytes} bytes. Switch the extension to Server Fetch mode for this page.`
    );
  }

  return {
    inputMode: "browser_html",
    url,
    normalizedUrl: normalizeUrlForKnowledge(url),
    html: snapshot.html,
    title: snapshot.title,
    meta: snapshot.meta,
    capturedAt: snapshot.capturedAt,
    selectionHtml: snapshot.selectionHtml
  };
}

function isHtmlContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return normalized.includes("text/html") || normalized.includes("application/xhtml+xml");
}

function arxivHtmlFetchUrl(input: string): string {
  const arxivId = arxivIdFromUrl(input);
  if (!arxivId) {
    return input;
  }
  return `https://arxiv.org/html/${arxivId}`;
}

function arxivIdFromUrl(input: string): string | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (url.hostname !== "arxiv.org" && url.hostname !== "www.arxiv.org") {
    return undefined;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] && ["abs", "html", "pdf"].includes(parts[0].toLowerCase())) {
    parts.shift();
  }
  let tail = parts.join("/");
  if (tail.toLowerCase().endsWith(".pdf")) {
    tail = tail.slice(0, -4);
  }
  return /^(\d{4}\.\d{4,5}|[a-z][a-z0-9-]*(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?$/i.test(tail)
    ? tail
    : undefined;
}
