import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import type {
  FeedBriefingContent,
  FeedBriefingState,
  FeedBriefingSummary,
  FeedEntry,
  FeedEntryStage,
  FeedRun,
  FeedRunState,
  FeedRunStats,
  FeedSettings,
  FeedSignal,
  FeedSignalType,
  FeedSource,
  FeedSourceKind,
  FeedSourceStats,
  KnowledgeDocument
} from "@uknowledge/knowledge-schema";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export const FEED_SCHEMA_VERSION = 1;
const ENTRY_ID_PATTERN = /^[0-9a-f-]{36}$/;

export interface FeedPointRow {
  pointId: string;
  briefingId: string;
  entryId: string;
  sourceId: string;
  text: string;
  sectionId?: string;
  quote?: string;
  entryTitle: string;
  entryUrl: string;
  used: boolean;
  createdAt: string;
}

export interface FeedTombstone {
  urlHash: string;
  entryId: string;
  url: string;
  promotedItemId?: string;
  expiredAt: string;
}

export interface NewFeedEntry {
  sourceId: string;
  url: string;
  urlHash: string;
  title: string;
  summary?: string;
  author?: string;
  publishedAt?: string;
  discoveredAt: string;
  expiresAt: string;
}

export interface NewFeedPoint {
  text: string;
  sectionId?: string;
  quote?: string;
}

type Row = Record<string, unknown>;

export function emptyRunStats(): FeedRunStats {
  return {
    expired: 0,
    sourcesOk: 0,
    sourcesFailed: 0,
    discovered: 0,
    duplicates: 0,
    scored: 0,
    scoreFailed: 0,
    selected: 0,
    fetched: 0,
    fetchFailed: 0,
    points: 0,
    pointsFailed: 0,
    stage: "starting"
  };
}

/** Local calendar date (YYYY-MM-DD) in the process time zone. */
export function localDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * Owns <storeRoot>/feed: one SQLite file plus per-entry Document JSON and
 * gzipped raw HTML. Nothing here touches the knowledge-base databases.
 */
export class FeedStore {
  readonly root: string;
  private readonly db: DatabaseSync;

  constructor(storeRoot: string) {
    this.root = join(storeRoot, "feed");
    mkdirSync(join(this.root, "documents"), { recursive: true });
    mkdirSync(join(this.root, "raw"), { recursive: true });
    this.db = new DatabaseSync(join(this.root, "feed.sqlite3"));
    this.db.exec("PRAGMA journal_mode = WAL");
    this.initializeSchema();
  }

  close(): void {
    this.db.close();
  }

  private initializeSchema(): void {
    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version === FEED_SCHEMA_VERSION) return;
    if (version !== 0) {
      throw new Error(`Unsupported feed schema version ${version}; expected ${FEED_SCHEMA_VERSION}`);
    }
    this.db.exec(`
      CREATE TABLE feed_sources (
        source_id     TEXT PRIMARY KEY,
        kind          TEXT NOT NULL CHECK(kind IN ('rss', 'listing')),
        title         TEXT NOT NULL,
        url           TEXT NOT NULL UNIQUE,
        link_pattern  TEXT,
        enabled       INTEGER NOT NULL DEFAULT 1,
        weight        REAL NOT NULL DEFAULT 1.0,
        last_run_at   TEXT,
        last_error    TEXT,
        created_at    TEXT NOT NULL,
        created_by    TEXT,
        updated_by    TEXT
      );

      CREATE TABLE feed_entries (
        entry_id          TEXT PRIMARY KEY,
        source_id         TEXT NOT NULL,
        url               TEXT NOT NULL,
        url_hash          TEXT NOT NULL UNIQUE,
        title             TEXT NOT NULL,
        summary           TEXT,
        author            TEXT,
        published_at      TEXT,
        discovered_at     TEXT NOT NULL,
        stage             TEXT NOT NULL,
        score             REAL,
        effective_score   REAL,
        score_reason      TEXT,
        topics_json       TEXT NOT NULL DEFAULT '[]',
        selected          INTEGER NOT NULL DEFAULT 0,
        exploration       INTEGER NOT NULL DEFAULT 0,
        rescued           INTEGER NOT NULL DEFAULT 0,
        batch_date        TEXT,
        briefing_id       TEXT,
        has_document      INTEGER NOT NULL DEFAULT 0,
        opened_at         TEXT,
        dismissed_at      TEXT,
        promoted_item_id  TEXT,
        promoted_at       TEXT,
        expires_at        TEXT NOT NULL,
        last_error        TEXT
      );
      CREATE INDEX idx_feed_entries_stage ON feed_entries(stage);
      CREATE INDEX idx_feed_entries_expires ON feed_entries(expires_at);
      CREATE INDEX idx_feed_entries_briefing ON feed_entries(briefing_id);
      CREATE INDEX idx_feed_entries_batch ON feed_entries(batch_date, selected);

      CREATE TABLE feed_points (
        point_id     TEXT PRIMARY KEY,
        briefing_id  TEXT NOT NULL,
        entry_id     TEXT NOT NULL,
        source_id    TEXT NOT NULL,
        text         TEXT NOT NULL,
        section_id   TEXT,
        quote        TEXT,
        entry_title  TEXT NOT NULL,
        entry_url    TEXT NOT NULL,
        used         INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX idx_feed_points_briefing ON feed_points(briefing_id);

      CREATE TABLE feed_briefings (
        briefing_id   TEXT PRIMARY KEY,
        run_id        TEXT NOT NULL,
        date          TEXT NOT NULL,
        state         TEXT NOT NULL CHECK(state IN ('pending', 'composed')),
        composer      TEXT,
        content_json  TEXT,
        revision      INTEGER NOT NULL DEFAULT 0,
        prepared_at   TEXT NOT NULL,
        composed_at   TEXT
      );
      CREATE INDEX idx_feed_briefings_date ON feed_briefings(date);

      CREATE TABLE feed_settings (
        id           INTEGER PRIMARY KEY CHECK(id = 1),
        coarse_hint  TEXT NOT NULL DEFAULT '',
        updated_at   TEXT,
        updated_by   TEXT
      );

      CREATE TABLE feed_signals (
        signal_id    TEXT PRIMARY KEY,
        type         TEXT NOT NULL CHECK(type IN ('open', 'open_original', 'star', 'dismiss')),
        entry_id     TEXT NOT NULL,
        source_id    TEXT NOT NULL,
        title        TEXT NOT NULL,
        topics_json  TEXT NOT NULL DEFAULT '[]',
        created_at   TEXT NOT NULL
      );
      CREATE INDEX idx_feed_signals_created ON feed_signals(created_at);

      CREATE TABLE feed_tombstones (
        url_hash          TEXT PRIMARY KEY,
        entry_id          TEXT NOT NULL UNIQUE,
        url               TEXT NOT NULL,
        promoted_item_id  TEXT,
        expired_at        TEXT NOT NULL
      );

      CREATE TABLE feed_source_stats (
        source_id   TEXT NOT NULL,
        date        TEXT NOT NULL,
        discovered  INTEGER NOT NULL DEFAULT 0,
        selected    INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (source_id, date)
      );

      CREATE TABLE feed_runs (
        run_id        TEXT PRIMARY KEY,
        triggered_by  TEXT NOT NULL,
        state         TEXT NOT NULL,
        stats_json    TEXT NOT NULL DEFAULT '{}',
        error         TEXT,
        briefing_id   TEXT,
        started_at    TEXT NOT NULL,
        finished_at   TEXT
      );

      PRAGMA user_version = ${FEED_SCHEMA_VERSION};
    `);
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private all(sql: string, ...params: Array<string | number | null>): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  private get(sql: string, ...params: Array<string | number | null>): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }

  private run(sql: string, ...params: Array<string | number | null>): number {
    return Number(this.db.prepare(sql).run(...params).changes);
  }

  // ── sources ─────────────────────────────────────────────────────────────

  listSources(): FeedSource[] {
    return this.all("SELECT * FROM feed_sources ORDER BY created_at, source_id").map(mapSource);
  }

  getSource(sourceId: string): FeedSource | undefined {
    const row = this.get("SELECT * FROM feed_sources WHERE source_id = ?", sourceId);
    return row ? mapSource(row) : undefined;
  }

  getSourceByUrl(url: string): FeedSource | undefined {
    const row = this.get("SELECT * FROM feed_sources WHERE url = ?", url);
    return row ? mapSource(row) : undefined;
  }

  createSource(input: {
    kind: FeedSourceKind;
    title: string;
    url: string;
    linkPattern?: string;
    weight?: number;
    createdBy?: string;
    now: string;
  }): FeedSource {
    const sourceId = randomUUID();
    this.run(
      `INSERT INTO feed_sources (source_id, kind, title, url, link_pattern, weight, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      sourceId, input.kind, input.title, input.url, input.linkPattern ?? null,
      input.weight ?? 1, input.now, input.createdBy ?? null
    );
    return this.getSource(sourceId)!;
  }

  updateSource(sourceId: string, patch: {
    title?: string;
    enabled?: boolean;
    weight?: number;
    linkPattern?: string;
    updatedBy?: string;
  }): FeedSource | undefined {
    const current = this.getSource(sourceId);
    if (!current) return undefined;
    this.run(
      `UPDATE feed_sources SET title = ?, enabled = ?, weight = ?, link_pattern = ?, updated_by = ?
       WHERE source_id = ?`,
      patch.title ?? current.title,
      (patch.enabled ?? current.enabled) ? 1 : 0,
      patch.weight ?? current.weight,
      patch.linkPattern ?? current.linkPattern ?? null,
      patch.updatedBy ?? current.updatedBy ?? null,
      sourceId
    );
    return this.getSource(sourceId);
  }

  deleteSourceRow(sourceId: string): void {
    this.transaction(() => {
      this.run("DELETE FROM feed_sources WHERE source_id = ?", sourceId);
      this.run("DELETE FROM feed_source_stats WHERE source_id = ?", sourceId);
    });
  }

  setSourceRunResult(sourceId: string, at: string, error?: string): void {
    this.run("UPDATE feed_sources SET last_run_at = ?, last_error = ? WHERE source_id = ?", at, error ?? null, sourceId);
  }

  bumpSourceStat(sourceId: string, date: string, field: "discovered" | "selected", amount = 1): void {
    if (amount <= 0) return;
    this.run(
      `INSERT INTO feed_source_stats (source_id, date, ${field}) VALUES (?, ?, ?)
       ON CONFLICT(source_id, date) DO UPDATE SET ${field} = ${field} + excluded.${field}`,
      sourceId, date, amount
    );
  }

  /** Per-source activity since `sinceDate` (local date) / `sinceIso` (timestamp). */
  sourceStats(sinceDate: string, sinceIso: string): Map<string, FeedSourceStats> {
    const stats = new Map<string, FeedSourceStats>();
    const ensure = (sourceId: string): FeedSourceStats => {
      let entry = stats.get(sourceId);
      if (!entry) {
        entry = { discovered: 0, selected: 0, briefed: 0, opened: 0, starred: 0, dismissed: 0 };
        stats.set(sourceId, entry);
      }
      return entry;
    };
    for (const row of this.all(
      `SELECT source_id, SUM(discovered) AS discovered, SUM(selected) AS selected
       FROM feed_source_stats WHERE date >= ? GROUP BY source_id`, sinceDate
    )) {
      const entry = ensure(String(row.source_id));
      entry.discovered = Number(row.discovered ?? 0);
      entry.selected = Number(row.selected ?? 0);
    }
    for (const row of this.all(
      `SELECT p.source_id AS source_id, COUNT(DISTINCT p.entry_id) AS briefed
       FROM feed_points p JOIN feed_briefings b ON b.briefing_id = p.briefing_id
       WHERE p.used = 1 AND b.date >= ? GROUP BY p.source_id`, sinceDate
    )) {
      ensure(String(row.source_id)).briefed = Number(row.briefed ?? 0);
    }
    for (const row of this.all(
      `SELECT source_id, type, COUNT(DISTINCT entry_id) AS total
       FROM feed_signals WHERE created_at >= ? GROUP BY source_id, type`, sinceIso
    )) {
      const entry = ensure(String(row.source_id));
      const total = Number(row.total ?? 0);
      if (row.type === "open" || row.type === "open_original") entry.opened = Math.max(entry.opened, total);
      if (row.type === "star") entry.starred = total;
      if (row.type === "dismiss") entry.dismissed = total;
    }
    return stats;
  }

  // ── entries ─────────────────────────────────────────────────────────────

  /** True when the URL is already tracked or was expired within the tombstone window. */
  isUrlHashKnown(urlHash: string): boolean {
    return Boolean(
      this.get("SELECT 1 AS found FROM feed_entries WHERE url_hash = ?", urlHash) ??
      this.get("SELECT 1 AS found FROM feed_tombstones WHERE url_hash = ?", urlHash)
    );
  }

  insertEntry(input: NewFeedEntry): string {
    const entryId = randomUUID();
    this.run(
      `INSERT INTO feed_entries
         (entry_id, source_id, url, url_hash, title, summary, author, published_at, discovered_at, stage, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'discovered', ?)`,
      entryId, input.sourceId, input.url, input.urlHash, input.title, input.summary ?? null,
      input.author ?? null, input.publishedAt ?? null, input.discoveredAt, input.expiresAt
    );
    return entryId;
  }

  getEntry(entryId: string): FeedEntry | undefined {
    const row = this.get(`${ENTRY_SELECT} WHERE e.entry_id = ?`, entryId);
    return row ? mapEntry(row) : undefined;
  }

  listEntries(filter: {
    briefingId?: string;
    sourceId?: string;
    selected?: boolean;
    limit: number;
    offset: number;
  }): { entries: FeedEntry[]; total: number } {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.briefingId) { clauses.push("e.briefing_id = ?"); params.push(filter.briefingId); }
    if (filter.sourceId) { clauses.push("e.source_id = ?"); params.push(filter.sourceId); }
    if (filter.selected !== undefined) { clauses.push("e.selected = ?"); params.push(filter.selected ? 1 : 0); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = Number(this.get(`SELECT COUNT(*) AS total FROM feed_entries e ${where}`, ...params)?.total ?? 0);
    const rows = this.all(
      `${ENTRY_SELECT} ${where} ORDER BY e.discovered_at DESC, e.entry_id LIMIT ? OFFSET ?`,
      ...params, filter.limit, filter.offset
    );
    return { entries: rows.map(mapEntry), total };
  }

  entriesByStage(stage: FeedEntryStage): FeedEntry[] {
    return this.all(`${ENTRY_SELECT} WHERE e.stage = ? ORDER BY e.discovered_at, e.entry_id`, stage).map(mapEntry);
  }

  /** Selected entries whose full text has not been fetched yet. */
  entriesAwaitingFulltext(): FeedEntry[] {
    return this.all(
      `${ENTRY_SELECT} WHERE e.selected = 1 AND e.stage = 'scored' ORDER BY e.effective_score DESC, e.entry_id`
    ).map(mapEntry);
  }

  /** Fetched (or fetch-failed) entries that have not produced points yet. */
  entriesAwaitingPoints(): FeedEntry[] {
    return this.all(
      `${ENTRY_SELECT} WHERE e.selected = 1 AND e.stage IN ('fetched', 'fetch_failed') AND e.briefing_id IS NULL
       ORDER BY e.effective_score DESC, e.entry_id`
    ).map(mapEntry);
  }

  entriesBySource(sourceId: string): FeedEntry[] {
    return this.all(`${ENTRY_SELECT} WHERE e.source_id = ?`, sourceId).map(mapEntry);
  }

  expiredEntries(nowIso: string): FeedEntry[] {
    return this.all(`${ENTRY_SELECT} WHERE e.expires_at < ?`, nowIso).map(mapEntry);
  }

  skippedEntries(batchDate: string, limit: number): FeedEntry[] {
    return this.all(
      `${ENTRY_SELECT} WHERE e.batch_date = ? AND e.selected = 0 AND e.stage = 'scored'
       ORDER BY e.effective_score DESC, e.entry_id LIMIT ?`,
      batchDate, limit
    ).map(mapEntry);
  }

  countScored(batchDate: string): number {
    return Number(this.get("SELECT COUNT(*) AS total FROM feed_entries WHERE batch_date = ?", batchDate)?.total ?? 0);
  }

  countRescued(briefingId: string): number {
    return Number(this.get(
      "SELECT COUNT(*) AS total FROM feed_entries WHERE briefing_id = ? AND rescued = 1", briefingId
    )?.total ?? 0);
  }

  setEntryScored(entryId: string, input: {
    score: number;
    effectiveScore: number;
    reason?: string;
    topics: string[];
    batchDate: string;
  }): void {
    this.run(
      `UPDATE feed_entries SET stage = 'scored', score = ?, effective_score = ?, score_reason = ?,
         topics_json = ?, batch_date = ?, last_error = NULL WHERE entry_id = ?`,
      input.score, input.effectiveScore, input.reason ?? null, JSON.stringify(input.topics), input.batchDate, entryId
    );
  }

  markSelected(entryId: string, input: { exploration: boolean; rescued?: boolean; expiresAt: string }): void {
    this.run(
      "UPDATE feed_entries SET selected = 1, exploration = ?, rescued = ?, expires_at = ? WHERE entry_id = ?",
      input.exploration ? 1 : 0, input.rescued ? 1 : 0, input.expiresAt, entryId
    );
  }

  setEntryFetched(entryId: string, ok: boolean, error?: string): void {
    this.run(
      "UPDATE feed_entries SET stage = ?, has_document = ?, last_error = ? WHERE entry_id = ?",
      ok ? "fetched" : "fetch_failed", ok ? 1 : 0, error ?? null, entryId
    );
  }

  setEntryError(entryId: string, error: string): void {
    this.run("UPDATE feed_entries SET last_error = ? WHERE entry_id = ?", error, entryId);
  }

  markOpened(entryId: string, at: string): void {
    this.run("UPDATE feed_entries SET opened_at = COALESCE(opened_at, ?) WHERE entry_id = ?", at, entryId);
  }

  markDismissed(entryId: string, at: string): void {
    this.run("UPDATE feed_entries SET dismissed_at = COALESCE(dismissed_at, ?) WHERE entry_id = ?", at, entryId);
  }

  markPromoted(entryId: string, itemId: string, at: string): void {
    this.run("UPDATE feed_entries SET promoted_item_id = ?, promoted_at = ? WHERE entry_id = ?", itemId, at, entryId);
  }

  /** Replace the entry row with a tombstone. Files must already be removed. */
  expireEntry(entry: FeedEntry, urlHash: string, at: string): void {
    this.transaction(() => {
      this.run(
        `INSERT INTO feed_tombstones (url_hash, entry_id, url, promoted_item_id, expired_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(url_hash) DO UPDATE SET expired_at = excluded.expired_at`,
        urlHash, entry.entryId, entry.url, entry.promotedItemId ?? null, at
      );
      this.run("DELETE FROM feed_entries WHERE entry_id = ?", entry.entryId);
    });
  }

  entryUrlHash(entryId: string): string | undefined {
    const row = this.get("SELECT url_hash FROM feed_entries WHERE entry_id = ?", entryId);
    return row ? String(row.url_hash) : undefined;
  }

  getTombstoneByEntry(entryId: string): FeedTombstone | undefined {
    const row = this.get("SELECT * FROM feed_tombstones WHERE entry_id = ?", entryId);
    if (!row) return undefined;
    return {
      urlHash: String(row.url_hash),
      entryId: String(row.entry_id),
      url: String(row.url),
      promotedItemId: optionalString(row.promoted_item_id),
      expiredAt: String(row.expired_at)
    };
  }

  // ── briefings and points ────────────────────────────────────────────────

  /**
   * Attach an entry and its points to a briefing. Without an explicit
   * briefing the points join the pending briefing of `date`, or start one.
   */
  attachEntryToBriefing(input: {
    briefingId?: string;
    date: string;
    runId: string;
    entry: FeedEntry;
    points: NewFeedPoint[];
    now: string;
  }): { briefingId: string; pointIds: string[] } {
    return this.transaction(() => {
      let briefingId = input.briefingId;
      if (!briefingId) {
        const pending = this.get(
          "SELECT briefing_id FROM feed_briefings WHERE date = ? AND state = 'pending' ORDER BY prepared_at DESC LIMIT 1",
          input.date
        );
        briefingId = pending ? String(pending.briefing_id) : undefined;
      }
      if (!briefingId) {
        briefingId = randomUUID();
        this.run(
          "INSERT INTO feed_briefings (briefing_id, run_id, date, state, prepared_at) VALUES (?, ?, ?, 'pending', ?)",
          briefingId, input.runId, input.date, input.now
        );
      }
      const pointIds: string[] = [];
      for (const point of input.points) {
        const pointId = `p-${randomUUID().slice(0, 8)}`;
        this.run(
          `INSERT INTO feed_points
             (point_id, briefing_id, entry_id, source_id, text, section_id, quote, entry_title, entry_url, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          pointId, briefingId, input.entry.entryId, input.entry.sourceId, point.text,
          point.sectionId ?? null, point.quote ?? null, input.entry.title, input.entry.url, input.now
        );
        pointIds.push(pointId);
      }
      this.run("UPDATE feed_entries SET briefing_id = ? WHERE entry_id = ?", briefingId, input.entry.entryId);
      return { briefingId, pointIds };
    });
  }

  getBriefing(briefingId: string): (FeedBriefingSummary & { content?: FeedBriefingContent }) | undefined {
    const row = briefingId === "latest"
      ? this.get(`${BRIEFING_SELECT} ORDER BY b.date DESC, b.prepared_at DESC LIMIT 1`)
      : this.get(`${BRIEFING_SELECT} WHERE b.briefing_id = ?`, briefingId);
    if (!row) return undefined;
    const content = typeof row.content_json === "string"
      ? JSON.parse(row.content_json) as FeedBriefingContent
      : undefined;
    return { ...mapBriefing(row), content };
  }

  listBriefings(state: FeedBriefingState | undefined, limit: number): FeedBriefingSummary[] {
    const rows = state
      ? this.all(`${BRIEFING_SELECT} WHERE b.state = ? ORDER BY b.date DESC, b.prepared_at DESC LIMIT ?`, state, limit)
      : this.all(`${BRIEFING_SELECT} ORDER BY b.date DESC, b.prepared_at DESC LIMIT ?`, limit);
    return rows.map(mapBriefing);
  }

  latestBriefingForDate(date: string): FeedBriefingSummary | undefined {
    const row = this.get(`${BRIEFING_SELECT} WHERE b.date = ? ORDER BY b.prepared_at DESC LIMIT 1`, date);
    return row ? mapBriefing(row) : undefined;
  }

  pendingBriefingCount(): number {
    return Number(this.get("SELECT COUNT(*) AS total FROM feed_briefings WHERE state = 'pending'")?.total ?? 0);
  }

  pointsForBriefing(briefingId: string): FeedPointRow[] {
    return this.all(
      "SELECT * FROM feed_points WHERE briefing_id = ? ORDER BY created_at, point_id", briefingId
    ).map(mapPoint);
  }

  /** Entries attached to a briefing that still exist, keyed by entry id. */
  entriesForBriefing(briefingId: string): Map<string, FeedEntry> {
    const entries = new Map<string, FeedEntry>();
    for (const row of this.all(`${ENTRY_SELECT} WHERE e.briefing_id = ?`, briefingId)) {
      const entry = mapEntry(row);
      entries.set(entry.entryId, entry);
    }
    return entries;
  }

  getEntries(entryIds: string[]): Map<string, FeedEntry> {
    const entries = new Map<string, FeedEntry>();
    for (const entryId of new Set(entryIds)) {
      const entry = this.getEntry(entryId);
      if (entry) entries.set(entryId, entry);
    }
    return entries;
  }

  promotedTombstones(entryIds: string[]): Map<string, string> {
    const promoted = new Map<string, string>();
    for (const entryId of new Set(entryIds)) {
      const tombstone = this.getTombstoneByEntry(entryId);
      if (tombstone?.promotedItemId) promoted.set(entryId, tombstone.promotedItemId);
    }
    return promoted;
  }

  saveBriefingContent(input: {
    briefingId: string;
    content: FeedBriefingContent;
    composer: string;
    usedPointIds: string[];
    now: string;
  }): void {
    this.transaction(() => {
      this.run(
        `UPDATE feed_briefings SET state = 'composed', composer = ?, content_json = ?,
           revision = revision + 1, composed_at = ? WHERE briefing_id = ?`,
        input.composer, JSON.stringify(input.content), input.now, input.briefingId
      );
      this.run("UPDATE feed_points SET used = 0 WHERE briefing_id = ?", input.briefingId);
      for (const pointId of input.usedPointIds) {
        this.run("UPDATE feed_points SET used = 1 WHERE briefing_id = ? AND point_id = ?", input.briefingId, pointId);
      }
    });
  }

  // ── settings and signals ────────────────────────────────────────────────

  getSettings(): FeedSettings {
    const row = this.get("SELECT * FROM feed_settings WHERE id = 1");
    return {
      coarseHint: row ? String(row.coarse_hint ?? "") : "",
      updatedAt: optionalString(row?.updated_at),
      updatedBy: optionalString(row?.updated_by)
    };
  }

  setSettings(coarseHint: string, updatedBy: string | undefined, now: string): FeedSettings {
    this.run(
      `INSERT INTO feed_settings (id, coarse_hint, updated_at, updated_by) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET coarse_hint = excluded.coarse_hint,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      coarseHint, now, updatedBy ?? null
    );
    return this.getSettings();
  }

  addSignal(type: FeedSignalType, entry: FeedEntry, now: string): void {
    this.run(
      `INSERT INTO feed_signals (signal_id, type, entry_id, source_id, title, topics_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      randomUUID(), type, entry.entryId, entry.sourceId, entry.title, JSON.stringify(entry.topics), now
    );
  }

  listSignals(since: string | undefined, limit: number): FeedSignal[] {
    const rows = since
      ? this.all("SELECT * FROM feed_signals WHERE created_at > ? ORDER BY created_at, signal_id LIMIT ?", since, limit)
      : this.all("SELECT * FROM feed_signals ORDER BY created_at, signal_id LIMIT ?", limit);
    return rows.map((row) => ({
      signalId: String(row.signal_id),
      type: String(row.type) as FeedSignalType,
      entryId: String(row.entry_id),
      sourceId: String(row.source_id),
      title: String(row.title),
      topics: parseStringArray(row.topics_json),
      createdAt: String(row.created_at)
    }));
  }

  // ── retention ───────────────────────────────────────────────────────────

  deleteBriefingsBefore(date: string): number {
    return this.transaction(() => {
      this.run(
        "DELETE FROM feed_points WHERE briefing_id IN (SELECT briefing_id FROM feed_briefings WHERE date < ?)", date
      );
      return this.run("DELETE FROM feed_briefings WHERE date < ?", date);
    });
  }

  deleteTombstonesBefore(iso: string): number {
    return this.run("DELETE FROM feed_tombstones WHERE expired_at < ?", iso);
  }

  deleteSignalsBefore(iso: string): number {
    return this.run("DELETE FROM feed_signals WHERE created_at < ?", iso);
  }

  deleteSourceStatsBefore(date: string): number {
    return this.run("DELETE FROM feed_source_stats WHERE date < ?", date);
  }

  // ── runs ────────────────────────────────────────────────────────────────

  createRun(triggeredBy: string, now: string): FeedRun {
    const runId = randomUUID();
    this.run(
      "INSERT INTO feed_runs (run_id, triggered_by, state, stats_json, started_at) VALUES (?, ?, 'running', ?, ?)",
      runId, triggeredBy, JSON.stringify(emptyRunStats()), now
    );
    return this.getRun(runId)!;
  }

  updateRun(runId: string, patch: {
    state?: FeedRunState;
    stats?: FeedRunStats;
    error?: string;
    briefingId?: string;
    finishedAt?: string;
  }): void {
    const current = this.getRun(runId);
    if (!current) return;
    this.run(
      "UPDATE feed_runs SET state = ?, stats_json = ?, error = ?, briefing_id = ?, finished_at = ? WHERE run_id = ?",
      patch.state ?? current.state,
      JSON.stringify(patch.stats ?? current.stats),
      patch.error ?? current.error ?? null,
      patch.briefingId ?? current.briefingId ?? null,
      patch.finishedAt ?? current.finishedAt ?? null,
      runId
    );
  }

  getRun(runId: string): FeedRun | undefined {
    const row = this.get("SELECT * FROM feed_runs WHERE run_id = ?", runId);
    return row ? mapRun(row) : undefined;
  }

  latestRun(): FeedRun | undefined {
    const row = this.get("SELECT * FROM feed_runs ORDER BY started_at DESC, run_id LIMIT 1");
    return row ? mapRun(row) : undefined;
  }

  /** Runs left in `running` by a previous process can never finish. */
  failStaleRuns(now: string): number {
    return this.run(
      "UPDATE feed_runs SET state = 'failed', error = 'interrupted by server restart', finished_at = ? WHERE state = 'running'",
      now
    );
  }

  // ── entry files ─────────────────────────────────────────────────────────

  private entryFile(directory: "documents" | "raw", entryId: string, extension: string): string {
    if (!ENTRY_ID_PATTERN.test(entryId)) throw new Error(`Invalid feed entry id: ${entryId}`);
    return join(this.root, directory, `${entryId}${extension}`);
  }

  async writeDocument(entryId: string, document: KnowledgeDocument): Promise<void> {
    await mkdir(join(this.root, "documents"), { recursive: true });
    await writeFile(this.entryFile("documents", entryId, ".json"), JSON.stringify(document), "utf8");
  }

  async readDocument(entryId: string): Promise<KnowledgeDocument | undefined> {
    try {
      return JSON.parse(await readFile(this.entryFile("documents", entryId, ".json"), "utf8")) as KnowledgeDocument;
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  async writeRawHtml(entryId: string, html: string): Promise<void> {
    await mkdir(join(this.root, "raw"), { recursive: true });
    await writeFile(this.entryFile("raw", entryId, ".html.gz"), await gzipAsync(Buffer.from(html, "utf8")));
  }

  async readRawHtml(entryId: string): Promise<string | undefined> {
    try {
      const compressed = await readFile(this.entryFile("raw", entryId, ".html.gz"));
      return (await gunzipAsync(compressed)).toString("utf8");
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  async removeEntryFiles(entryId: string): Promise<void> {
    await rm(this.entryFile("documents", entryId, ".json"), { force: true });
    await rm(this.entryFile("raw", entryId, ".html.gz"), { force: true });
  }
}

const ENTRY_SELECT = `
  SELECT e.*, s.title AS source_title
  FROM feed_entries e LEFT JOIN feed_sources s ON s.source_id = e.source_id`;

const BRIEFING_SELECT = `
  SELECT b.*,
    (SELECT COUNT(*) FROM feed_points p WHERE p.briefing_id = b.briefing_id) AS point_count,
    (SELECT COUNT(DISTINCT p.entry_id) FROM feed_points p WHERE p.briefing_id = b.briefing_id) AS entry_count
  FROM feed_briefings b`;

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function mapSource(row: Row): FeedSource {
  return {
    sourceId: String(row.source_id),
    kind: String(row.kind) as FeedSourceKind,
    title: String(row.title),
    url: String(row.url),
    linkPattern: optionalString(row.link_pattern),
    enabled: Number(row.enabled) === 1,
    weight: Number(row.weight),
    lastRunAt: optionalString(row.last_run_at),
    lastError: optionalString(row.last_error),
    createdAt: String(row.created_at),
    createdBy: optionalString(row.created_by),
    updatedBy: optionalString(row.updated_by)
  };
}

function mapEntry(row: Row): FeedEntry {
  return {
    entryId: String(row.entry_id),
    sourceId: String(row.source_id),
    sourceTitle: optionalString(row.source_title),
    url: String(row.url),
    title: String(row.title),
    summary: optionalString(row.summary),
    author: optionalString(row.author),
    publishedAt: optionalString(row.published_at),
    discoveredAt: String(row.discovered_at),
    stage: String(row.stage) as FeedEntryStage,
    score: optionalNumber(row.score),
    effectiveScore: optionalNumber(row.effective_score),
    scoreReason: optionalString(row.score_reason),
    topics: parseStringArray(row.topics_json),
    selected: Number(row.selected) === 1,
    exploration: Number(row.exploration) === 1,
    rescued: Number(row.rescued) === 1,
    batchDate: optionalString(row.batch_date),
    briefingId: optionalString(row.briefing_id),
    hasDocument: Number(row.has_document) === 1,
    openedAt: optionalString(row.opened_at),
    dismissedAt: optionalString(row.dismissed_at),
    promotedItemId: optionalString(row.promoted_item_id),
    promotedAt: optionalString(row.promoted_at),
    expiresAt: String(row.expires_at),
    lastError: optionalString(row.last_error)
  };
}

function mapPoint(row: Row): FeedPointRow {
  return {
    pointId: String(row.point_id),
    briefingId: String(row.briefing_id),
    entryId: String(row.entry_id),
    sourceId: String(row.source_id),
    text: String(row.text),
    sectionId: optionalString(row.section_id),
    quote: optionalString(row.quote),
    entryTitle: String(row.entry_title),
    entryUrl: String(row.entry_url),
    used: Number(row.used) === 1,
    createdAt: String(row.created_at)
  };
}

function mapBriefing(row: Row): FeedBriefingSummary {
  return {
    briefingId: String(row.briefing_id),
    date: String(row.date),
    state: String(row.state) as FeedBriefingState,
    composer: optionalString(row.composer),
    revision: Number(row.revision),
    preparedAt: String(row.prepared_at),
    composedAt: optionalString(row.composed_at),
    pointCount: Number(row.point_count ?? 0),
    entryCount: Number(row.entry_count ?? 0)
  };
}

function mapRun(row: Row): FeedRun {
  let stats = emptyRunStats();
  try {
    stats = { ...stats, ...(JSON.parse(String(row.stats_json)) as Partial<FeedRunStats>) };
  } catch {
    // Keep defaults when a stored stats blob is unreadable.
  }
  return {
    runId: String(row.run_id),
    triggeredBy: String(row.triggered_by),
    state: String(row.state) as FeedRunState,
    stats,
    error: optionalString(row.error),
    startedAt: String(row.started_at),
    finishedAt: optionalString(row.finished_at),
    briefingId: optionalString(row.briefing_id)
  };
}
