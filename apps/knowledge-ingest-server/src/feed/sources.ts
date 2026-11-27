import { createHash } from "node:crypto";
import { DOMParser, parseHTML } from "linkedom";
import { normalizeUrlForKnowledge } from "@uknowledge/knowledge-schema";
import type { FeedSource } from "@uknowledge/knowledge-schema";

export interface DiscoveredEntry {
  url: string;
  title: string;
  summary?: string;
  author?: string;
  publishedAt?: string;
}

const MAX_FEED_BYTES = 5 * 1024 * 1024;
const MAX_SUMMARY_LENGTH = 1000;
const MAX_TITLE_LENGTH = 500;
const MAX_LINK_PATTERN_INPUT = 2000;

/** Full SHA-256 of the normalized URL; the dedupe key for feed entries. */
export function feedUrlHash(url: string): string {
  return createHash("sha256").update(normalizeUrlForKnowledge(url)).digest("hex");
}

export async function discoverSource(
  source: FeedSource,
  options: { timeoutMs: number; limit: number; signal?: AbortSignal }
): Promise<DiscoveredEntry[]> {
  const body = await fetchText(source.url, source.kind, options.timeoutMs, options.signal);
  const entries = source.kind === "rss"
    ? parseFeedXml(body, source.url)
    : parseListing(body, source.url, source.linkPattern ?? "");
  return limitEntries(entries, options.limit);
}

async function fetchText(url: string, kind: FeedSource["kind"], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, {
    headers: {
      accept: kind === "rss"
        ? "application/atom+xml,application/rss+xml,application/xml;q=0.9,text/xml;q=0.9,*/*;q=0.1"
        : "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
      "user-agent": "knowledge-ingest-server/0.1"
    },
    signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_FEED_BYTES) {
    throw new Error(`Response from ${url} is larger than ${MAX_FEED_BYTES} bytes`);
  }
  return text;
}

/** Newest first, entries without a date last, then truncated. */
export function limitEntries(entries: DiscoveredEntry[], limit: number): DiscoveredEntry[] {
  const seen = new Set<string>();
  const unique: DiscoveredEntry[] = [];
  for (const entry of entries) {
    const key = feedUrlHash(entry.url);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  // Array.prototype.sort is stable, so undated entries keep document order.
  unique.sort((left, right) => (right.publishedAt ?? "").localeCompare(left.publishedAt ?? ""));
  return unique.slice(0, limit);
}

/** Parse RSS 2.0 or Atom. Throws when the document is neither. */
export function parseFeedXml(xml: string, feedUrl: string): DiscoveredEntry[] {
  const document = new DOMParser().parseFromString(xml, "text/xml") as unknown as Document;
  const atomEntries = Array.from(document.querySelectorAll("feed > entry"));
  const rssItems = Array.from(document.querySelectorAll("channel > item, rdf\\:RDF > item, RDF > item"));
  if (atomEntries.length === 0 && rssItems.length === 0) {
    if (!document.querySelector("feed, rss, channel")) {
      throw new Error(`${feedUrl} is not an RSS or Atom feed`);
    }
    return [];
  }

  const entries: DiscoveredEntry[] = [];
  for (const node of atomEntries) {
    const links = Array.from(node.querySelectorAll("link"));
    const link = links.find((candidate) => (candidate.getAttribute("rel") ?? "alternate") === "alternate")
      ?? links[0];
    const entry = buildEntry({
      link: link?.getAttribute("href") ?? undefined,
      title: childText(node, "title"),
      summary: childText(node, "summary") ?? childText(node, "content"),
      author: node.querySelector("author > name")?.textContent ?? undefined,
      published: childText(node, "published") ?? childText(node, "updated")
    }, feedUrl);
    if (entry) entries.push(entry);
  }
  for (const node of rssItems) {
    const guid = childElement(node, "guid");
    const guidLink = guid && guid.getAttribute("isPermaLink") !== "false" ? guid.textContent ?? undefined : undefined;
    const entry = buildEntry({
      link: childText(node, "link") ?? guidLink,
      title: childText(node, "title"),
      summary: childText(node, "description") ?? childText(node, "content:encoded"),
      author: childText(node, "dc:creator") ?? childText(node, "author"),
      published: childText(node, "pubDate") ?? childText(node, "dc:date")
    }, feedUrl);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Extract same-origin links matching `linkPattern` from a listing page. */
export function parseListing(html: string, pageUrl: string, linkPattern: string): DiscoveredEntry[] {
  const pattern = compileLinkPattern(linkPattern);
  const origin = new URL(pageUrl).origin;
  const { document } = parseHTML(html);
  const byUrl = new Map<string, DiscoveredEntry>();
  for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
    const resolved = resolveHttpUrl(anchor.getAttribute("href") ?? "", pageUrl);
    if (!resolved || new URL(resolved).origin !== origin) continue;
    if (resolved.length > MAX_LINK_PATTERN_INPUT || !pattern.test(resolved)) continue;
    const title = cleanText(anchor.textContent ?? "").slice(0, MAX_TITLE_LENGTH);
    const key = normalizeUrlForKnowledge(resolved);
    const existing = byUrl.get(key);
    // The same article is often linked twice (image + headline); keep the longer text.
    if (!existing || title.length > existing.title.length) {
      byUrl.set(key, { url: resolved, title });
    }
  }
  return [...byUrl.values()].filter((entry) => entry.title.length > 0);
}

export function compileLinkPattern(linkPattern: string): RegExp {
  if (!linkPattern) throw new Error("linkPattern is required for listing sources");
  try {
    return new RegExp(linkPattern);
  } catch (error) {
    throw new Error(`Invalid linkPattern: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function buildEntry(
  raw: { link?: string; title?: string; summary?: string; author?: string; published?: string },
  feedUrl: string
): DiscoveredEntry | undefined {
  const url = resolveHttpUrl((raw.link ?? "").trim(), feedUrl);
  if (!url) return undefined;
  const title = htmlToText(raw.title ?? "").slice(0, MAX_TITLE_LENGTH);
  if (!title) return undefined;
  const summary = htmlToText(raw.summary ?? "").slice(0, MAX_SUMMARY_LENGTH);
  return {
    url,
    title,
    summary: summary || undefined,
    author: cleanText(raw.author ?? "").slice(0, 200) || undefined,
    publishedAt: parseDate(raw.published)
  };
}

function childElement(node: Element, tagName: string): Element | undefined {
  const expected = tagName.toLowerCase();
  return Array.from(node.children).find((child) => child.tagName.toLowerCase() === expected);
}

function childText(node: Element, tagName: string): string | undefined {
  const text = childElement(node, tagName)?.textContent;
  return text && text.trim() ? text : undefined;
}

function resolveHttpUrl(href: string, base: string): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function parseDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value.trim());
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Feed titles and summaries often carry escaped HTML; reduce them to text. */
function htmlToText(value: string): string {
  if (!/[<&]/.test(value)) return cleanText(value);
  const { document } = parseHTML(`<!doctype html><html><body><div id="feed-text">${value}</div></body></html>`);
  for (const node of Array.from(document.querySelectorAll("script, style"))) node.remove();
  return cleanText(document.getElementById("feed-text")?.textContent ?? "");
}
