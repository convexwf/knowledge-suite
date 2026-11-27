import type { FeedEntry, KnowledgeCaptureSaveRequest } from "@uknowledge/knowledge-schema";
import type { FeedStore } from "./store.js";

/** Saves a page into the knowledge base `default` category and returns its item id. */
export type KnowledgeSaver = (input: KnowledgeCaptureSaveRequest) => Promise<string | undefined>;

/**
 * Promote a feed entry into the knowledge base. The stored raw HTML is used
 * when available so the saved item is the version the reader actually saw;
 * otherwise the URL is fetched again.
 */
export async function promoteEntry(
  store: FeedStore,
  entry: FeedEntry,
  saver: KnowledgeSaver,
  now: Date
): Promise<string> {
  if (entry.promotedItemId) return entry.promotedItemId;

  const html = await store.readRawHtml(entry.entryId);
  const itemId = await saver(html
    ? {
      inputMode: "browser_html",
      category: "default",
      snapshot: {
        pageUrl: entry.url,
        title: entry.title,
        html,
        capturedAt: entry.discoveredAt,
        meta: {}
      }
    }
    : { inputMode: "server_fetch", category: "default", url: entry.url });
  if (!itemId) throw new Error(`Saving ${entry.url} did not produce a knowledge item`);

  const at = now.toISOString();
  store.markPromoted(entry.entryId, itemId, at);
  store.addSignal("star", entry, at);
  return itemId;
}
