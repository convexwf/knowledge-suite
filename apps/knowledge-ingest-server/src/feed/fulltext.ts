import type { KnowledgeDocument } from "@uknowledge/knowledge-schema";
import type { ServerConfig } from "../config.js";
import { resolveKnowledgeCaptureInput } from "../input.js";
import { parsePage } from "../parser.js";

export interface Fulltext {
  document: KnowledgeDocument;
  html: string;
}

/**
 * Fetch and parse one entry through the same path as a manual Server Fetch
 * clip, so site adapters and candidate selection behave identically.
 */
export async function fetchFulltext(url: string, config: ServerConfig): Promise<Fulltext> {
  const resolved = await resolveKnowledgeCaptureInput({ inputMode: "server_fetch", url }, config);
  const parsed = await parsePage(resolved);
  ensureSectionIds(parsed.document);
  if (parsed.document.sections.length === 0) {
    throw new Error(`No readable content extracted from ${url}`);
  }
  return { document: parsed.document, html: resolved.html };
}

/** Every section must be citable; fill ids the parser left out. */
export function ensureSectionIds(document: KnowledgeDocument): void {
  const seen = new Set(document.sections.map((section) => section.section_id).filter(Boolean));
  document.sections.forEach((section, index) => {
    if (section.section_id) return;
    let candidate = `s-feed-${index}`;
    while (seen.has(candidate)) candidate = `${candidate}x`;
    seen.add(candidate);
    section.section_id = candidate;
  });
}

/** Run `worker` over `items` with a fixed number of concurrent workers. */
export async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await worker(item);
    }
  });
  await Promise.all(runners);
}
