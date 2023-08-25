import {
  ClipInput,
  isFileUrl,
  normalizeUrlForKnowledge,
  nowIso,
  PageSnapshot
} from "@uknowledge/knowledge-schema";
import { ServerConfig } from "./config.js";
import { resolveCanonicalUrl, resolveFetchUrl } from "./parser/adapters/index.js";

export interface ResolvedInput {
  inputMode: ClipInput["inputMode"];
  url: string;
  originalUrl: string;
  canonicalUrl?: string;
  fetchUrl?: string;
  normalizedUrl: string;
  html: string;
  bodyText?: string;
  snapshotDiagnostics?: PageSnapshot["diagnostics"];
  pageTitle?: string;
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

  const requestedFetchUrl = resolveFetchUrl(input.url);

  try {
    response = await fetch(requestedFetchUrl, {
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

  const finalFetchUrl = response.url || requestedFetchUrl;

  if (!response.ok) {
    throw new Error(`Failed to fetch ${finalFetchUrl}: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType && !isHtmlContentType(contentType)) {
    throw new Error(`Expected HTML from ${finalFetchUrl}, got ${contentType}`);
  }

  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > config.maxHtmlBytes) {
    throw new Error(
      `HTML response from ${finalFetchUrl} is too large: ${contentLength} bytes. Server Fetch cannot process this page unless KNOWLEDGE_MAX_HTML_BYTES is increased.`
    );
  }

  const html = await response.text();
  if (Buffer.byteLength(html) > config.maxHtmlBytes) {
    throw new Error(
      `HTML response from ${finalFetchUrl} is too large: ${Buffer.byteLength(
        html
      )} bytes. Server Fetch cannot process this page unless KNOWLEDGE_MAX_HTML_BYTES is increased.`
    );
  }

  return {
    inputMode: "server_fetch",
    url: finalFetchUrl,
    originalUrl: input.url,
    canonicalUrl: finalFetchUrl,
    fetchUrl: finalFetchUrl,
    normalizedUrl: normalizeUrlForKnowledge(finalFetchUrl),
    html,
    meta: {},
    capturedAt: nowIso()
  };
}

function fromSnapshot(snapshot: PageSnapshot, config: ServerConfig): ResolvedInput {
  const canonicalUrl = resolveCanonicalUrl(snapshot.pageUrl, snapshot.canonicalUrl);
  const url = canonicalUrl || snapshot.pageUrl;
  const htmlBytes = Buffer.byteLength(snapshot.html);
  if (htmlBytes > config.maxHtmlBytes) {
    throw new Error(
      `Page HTML is too large for Current HTML mode: ${htmlBytes} bytes. Switch the extension to Server Fetch mode for this page.`
    );
  }

  return {
    inputMode: "browser_html",
    url,
    originalUrl: snapshot.pageUrl,
    canonicalUrl,
    normalizedUrl: normalizeUrlForKnowledge(url),
    html: snapshot.html,
    bodyText: snapshot.text,
    snapshotDiagnostics: snapshot.diagnostics,
    pageTitle: snapshot.pageTitle ?? snapshot.title,
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
