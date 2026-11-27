import type { FeedEntry } from "@uknowledge/knowledge-schema";
import type { FeedConfig } from "../config.js";
import { addDays, localDate, type FeedStore } from "./store.js";

const SIGNAL_RETENTION_DAYS = 180;
const SOURCE_STATS_RETENTION_DAYS = 60;

/**
 * Remove an entry: files first, then the row (replaced by a tombstone) in one
 * transaction. If the process dies in between, the row is still there and the
 * next cleanup retries; removing already-missing files is not an error.
 */
export async function expireEntry(store: FeedStore, entry: FeedEntry, now: Date): Promise<void> {
  const urlHash = store.entryUrlHash(entry.entryId);
  if (!urlHash) return;
  await store.removeEntryFiles(entry.entryId);
  store.expireEntry(entry, urlHash, now.toISOString());
}

export async function runRetention(store: FeedStore, config: FeedConfig, now: Date): Promise<number> {
  const expired = store.expiredEntries(now.toISOString());
  for (const entry of expired) {
    await expireEntry(store, entry, now);
  }
  store.deleteBriefingsBefore(localDate(addDays(now, -config.briefingRetentionDays)));
  store.deleteTombstonesBefore(addDays(now, -config.tombstoneDays).toISOString());
  store.deleteSignalsBefore(addDays(now, -SIGNAL_RETENTION_DAYS).toISOString());
  store.deleteSourceStatsBefore(localDate(addDays(now, -SOURCE_STATS_RETENTION_DAYS)));
  return expired.length;
}
