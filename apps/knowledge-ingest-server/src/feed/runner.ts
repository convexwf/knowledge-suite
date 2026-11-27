import type { FeedEntry, FeedRun, FeedRunStats } from "@uknowledge/knowledge-schema";
import type { FeedConfig, ServerConfig } from "../config.js";
import { fetchFulltext, mapWithConcurrency } from "./fulltext.js";
import type { FeedLlm } from "./llm.js";
import { extractPoints, fallbackPoint } from "./points.js";
import { runRetention } from "./retention.js";
import { clampWeight, SCORE_BATCH_SIZE, scoreBatchWithRetry, selectEntries } from "./score.js";
import { discoverSource, feedUrlHash } from "./sources.js";
import { addDays, emptyRunStats, localDate, type FeedStore, type NewFeedPoint } from "./store.js";

const FETCH_CONCURRENCY = 3;
const STATS_WINDOW_DAYS = 30;

export class FeedBusyError extends Error {
  constructor(readonly runId: string) {
    super("A feed run is already in progress");
    this.name = "FeedBusyError";
  }
}

export class FeedRescueError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 409) {
    super(message);
    this.name = "FeedRescueError";
  }
}

export interface FeedRunnerLogger {
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
  error(details: object, message: string): void;
}

export interface FeedRunnerOptions {
  store: FeedStore;
  config: FeedConfig;
  serverConfig: ServerConfig;
  llm: FeedLlm;
  /** True when the URL already exists in any knowledge-base category. */
  knowledgeHasUrl: (url: string) => Promise<boolean>;
  log: FeedRunnerLogger;
  now?: () => Date;
}

/**
 * Runs the prepare stage: retention, discovery, dedupe, coarse scoring,
 * full-text fetch and point extraction. There is no scheduler here; a run
 * starts only when a caller asks for one, and only one runs at a time.
 */
export class FeedRunner {
  private readonly store: FeedStore;
  private readonly config: FeedConfig;
  private readonly now: () => Date;
  private active?: { runId: string; promise: Promise<void>; controller: AbortController };
  private rescueInProgress = false;

  constructor(private readonly options: FeedRunnerOptions) {
    this.store = options.store;
    this.config = options.config;
    this.now = options.now ?? (() => new Date());
    this.store.failStaleRuns(this.now().toISOString());
  }

  get activeRunId(): string | undefined {
    return this.active?.runId;
  }

  /** Start a run in the background and return immediately. */
  start(triggeredBy: string): FeedRun {
    if (this.active) throw new FeedBusyError(this.active.runId);
    if (this.rescueInProgress) throw new FeedBusyError("rescue");
    const run = this.store.createRun(triggeredBy, this.now().toISOString());
    const controller = new AbortController();
    const promise = this.execute(run.runId, controller.signal)
      .catch((error: unknown) => {
        this.options.log.error({ err: error, runId: run.runId }, "feed run failed");
      })
      .finally(() => {
        if (this.active?.runId === run.runId) this.active = undefined;
      });
    this.active = { runId: run.runId, promise, controller };
    return run;
  }

  /** Resolves when the active run (if any) has finished. */
  async waitForIdle(): Promise<void> {
    await this.active?.promise;
  }

  async stop(): Promise<void> {
    this.active?.controller.abort();
    await this.active?.promise;
  }

  private async execute(runId: string, signal: AbortSignal): Promise<void> {
    const stats = emptyRunStats();
    let briefingId: string | undefined;
    const setStage = (stage: string): void => {
      stats.stage = stage;
      this.store.updateRun(runId, { stats });
    };
    try {
      setStage("retention");
      stats.expired = await runRetention(this.store, this.config, this.now());

      setStage("discover");
      await this.discover(stats, signal);

      setStage("score");
      await this.score(stats, signal);

      setStage("fulltext");
      await this.fetchSelected(this.store.entriesAwaitingFulltext(), stats, signal);

      setStage("points");
      briefingId = await this.extract(runId, this.store.entriesAwaitingPoints(), stats, signal);

      stats.stage = "done";
      const partial = signal.aborted || stats.scoreFailed > 0 || stats.pointsFailed > 0;
      this.store.updateRun(runId, {
        state: partial ? "partial" : "completed",
        stats,
        briefingId,
        finishedAt: this.now().toISOString(),
        error: signal.aborted ? "run was stopped before it finished" : undefined
      });
    } catch (error) {
      this.store.updateRun(runId, {
        state: "failed",
        stats,
        briefingId,
        error: error instanceof Error ? error.message : String(error),
        finishedAt: this.now().toISOString()
      });
      throw error;
    }
  }

  private async discover(stats: FeedRunStats, signal: AbortSignal): Promise<void> {
    const sources = this.store.listSources().filter((source) => source.enabled);
    for (const source of sources) {
      if (signal.aborted) return;
      const now = this.now();
      try {
        const discovered = await discoverSource(source, {
          timeoutMs: this.options.serverConfig.fetchTimeoutMs,
          limit: this.config.maxDiscoverPerSource,
          signal
        });
        let added = 0;
        for (const candidate of discovered) {
          let urlHash: string;
          try {
            urlHash = feedUrlHash(candidate.url);
          } catch {
            continue;
          }
          if (this.store.isUrlHashKnown(urlHash) || await this.options.knowledgeHasUrl(candidate.url)) {
            stats.duplicates += 1;
            continue;
          }
          this.store.insertEntry({
            sourceId: source.sourceId,
            url: candidate.url,
            urlHash,
            title: candidate.title,
            summary: candidate.summary,
            author: candidate.author,
            publishedAt: candidate.publishedAt,
            discoveredAt: now.toISOString(),
            expiresAt: addDays(now, this.config.skippedRetentionDays).toISOString()
          });
          added += 1;
        }
        stats.discovered += added;
        stats.sourcesOk += 1;
        this.store.bumpSourceStat(source.sourceId, localDate(now), "discovered", added);
        this.store.setSourceRunResult(source.sourceId, now.toISOString());
      } catch (error) {
        if (signal.aborted) return;
        stats.sourcesFailed += 1;
        const message = error instanceof Error ? error.message : String(error);
        this.store.setSourceRunResult(source.sourceId, now.toISOString(), message.slice(0, 500));
        this.options.log.warn({ sourceId: source.sourceId, url: source.url, error: message }, "feed source failed");
      }
    }
  }

  private async score(stats: FeedRunStats, signal: AbortSignal): Promise<void> {
    const pending = this.store.entriesByStage("discovered");
    if (pending.length === 0) return;
    const now = this.now();
    const batchDate = localDate(now);
    const weights = new Map(this.store.listSources().map((source) => [source.sourceId, clampWeight(source.weight)]));
    const coarseHint = this.store.getSettings().coarseHint;
    const scoredNow: FeedEntry[] = [];

    for (let offset = 0; offset < pending.length; offset += SCORE_BATCH_SIZE) {
      if (signal.aborted) return;
      const batch = pending.slice(offset, offset + SCORE_BATCH_SIZE);
      try {
        const scores = await scoreBatchWithRetry(this.options.llm, batch, {
          coarseHint,
          outputLanguage: this.config.outputLanguage,
          signal
        });
        for (const entry of batch) {
          const result = scores.get(entry.entryId);
          if (!result) {
            stats.scoreFailed += 1;
            continue;
          }
          const effectiveScore = result.score * (weights.get(entry.sourceId) ?? 1);
          this.store.setEntryScored(entry.entryId, {
            score: result.score,
            effectiveScore,
            reason: result.reason,
            topics: result.topics,
            batchDate
          });
          scoredNow.push({ ...entry, effectiveScore });
          stats.scored += 1;
        }
      } catch (error) {
        if (signal.aborted) return;
        // Entries stay `discovered` and are scored by the next run.
        stats.scoreFailed += batch.length;
        this.options.log.warn(
          { error: error instanceof Error ? error.message : String(error), batchSize: batch.length },
          "feed scoring batch failed"
        );
      }
    }

    const recent = this.store.sourceStats(
      localDate(addDays(now, -STATS_WINDOW_DAYS)),
      addDays(now, -STATS_WINDOW_DAYS).toISOString()
    );
    const selection = selectEntries(
      scoredNow.map((entry) => ({
        entryId: entry.entryId,
        sourceId: entry.sourceId,
        effectiveScore: entry.effectiveScore ?? 0
      })),
      {
        minScore: this.config.minScore,
        maxSelected: this.config.maxFulltextPerRun,
        recentSelectedBySource: new Map([...recent].map(([sourceId, value]) => [sourceId, value.selected]))
      }
    );
    const bySource = new Map(scoredNow.map((entry) => [entry.entryId, entry.sourceId]));
    for (const choice of selection) {
      const entry = scoredNow.find((candidate) => candidate.entryId === choice.entryId);
      if (!entry) continue;
      this.store.markSelected(choice.entryId, {
        exploration: choice.exploration,
        expiresAt: addDays(new Date(entry.discoveredAt), this.config.retentionDays).toISOString()
      });
      this.store.bumpSourceStat(bySource.get(choice.entryId)!, batchDate, "selected");
    }
    stats.selected += selection.length;
  }

  private async fetchSelected(entries: FeedEntry[], stats: FeedRunStats, signal: AbortSignal): Promise<void> {
    await mapWithConcurrency(entries, FETCH_CONCURRENCY, async (entry) => {
      if (signal.aborted) return;
      try {
        const fulltext = await fetchFulltext(entry.url, this.options.serverConfig);
        await this.store.writeDocument(entry.entryId, fulltext.document);
        await this.store.writeRawHtml(entry.entryId, fulltext.html);
        this.store.setEntryFetched(entry.entryId, true);
        stats.fetched += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.store.removeEntryFiles(entry.entryId);
        this.store.setEntryFetched(entry.entryId, false, message.slice(0, 500));
        stats.fetchFailed += 1;
      }
    });
  }

  /**
   * Extract points entry by entry. Each entry is attached to the briefing in
   * its own transaction, so an interrupted run loses at most the entry in flight.
   */
  private async extract(
    runId: string,
    entries: FeedEntry[],
    stats: FeedRunStats,
    signal: AbortSignal,
    targetBriefingId?: string
  ): Promise<string | undefined> {
    let briefingId = targetBriefingId;
    for (const stale of entries) {
      if (signal.aborted) break;
      const entry = this.store.getEntry(stale.entryId);
      if (!entry) continue;
      let points: NewFeedPoint[];
      try {
        points = await this.pointsFor(entry, signal);
      } catch (error) {
        if (signal.aborted) break;
        // Leave the entry unattached so the next run retries the extraction.
        stats.pointsFailed += 1;
        const message = error instanceof Error ? error.message : String(error);
        this.store.setEntryError(entry.entryId, message.slice(0, 500));
        this.options.log.warn({ entryId: entry.entryId, error: message }, "feed point extraction failed");
        continue;
      }
      const now = this.now();
      const attached = this.store.attachEntryToBriefing({
        briefingId: targetBriefingId,
        date: entry.batchDate ?? localDate(now),
        runId,
        entry,
        points,
        now: now.toISOString()
      });
      briefingId = attached.briefingId;
      stats.points += attached.pointIds.length;
    }
    return briefingId;
  }

  private async pointsFor(entry: FeedEntry, signal: AbortSignal): Promise<NewFeedPoint[]> {
    if (entry.stage !== "fetched") return [fallbackPoint(entry)];
    const document = await this.store.readDocument(entry.entryId);
    if (!document) return [fallbackPoint(entry)];
    return extractPoints(this.options.llm, entry, document, {
      outputLanguage: this.config.outputLanguage,
      signal
    });
  }

  /**
   * Fetch and extract an entry the coarse filter skipped, on request of the
   * composing agent, and add its points to the briefing of the same batch.
   */
  async rescueEntry(entryId: string, requestedBriefingId?: string): Promise<{ briefingId: string; entry: FeedEntry }> {
    if (this.active) throw new FeedBusyError(this.active.runId);
    if (this.rescueInProgress) throw new FeedBusyError("rescue");
    const entry = this.store.getEntry(entryId);
    if (!entry) throw new FeedRescueError("feed_entry_not_found", "Feed entry not found", 404);
    if (entry.selected || entry.stage !== "scored") {
      throw new FeedRescueError("feed_entry_not_skipped", "Only scored entries that were not selected can be prepared");
    }
    const briefing = requestedBriefingId
      ? this.store.getBriefing(requestedBriefingId)
      : entry.batchDate ? this.store.latestBriefingForDate(entry.batchDate) : undefined;
    if (!briefing) {
      throw new FeedRescueError("feed_briefing_not_found", "No briefing exists for this entry's batch", 404);
    }
    if (briefing.date !== entry.batchDate) {
      throw new FeedRescueError("feed_briefing_mismatch", "The entry was not scored in this briefing's batch");
    }
    if (this.store.countRescued(briefing.briefingId) >= this.config.maxRescuePerBriefing) {
      throw new FeedRescueError(
        "feed_rescue_limit_reached",
        `At most ${this.config.maxRescuePerBriefing} entries can be prepared per briefing`
      );
    }

    this.rescueInProgress = true;
    try {
      const signal = new AbortController().signal;
      const stats = emptyRunStats();
      this.store.markSelected(entry.entryId, {
        exploration: false,
        rescued: true,
        expiresAt: addDays(new Date(entry.discoveredAt), this.config.retentionDays).toISOString()
      });
      this.store.bumpSourceStat(entry.sourceId, briefing.date, "selected");
      await this.fetchSelected([entry], stats, signal);
      const fetched = this.store.getEntry(entry.entryId);
      if (!fetched) throw new FeedRescueError("feed_entry_not_found", "Feed entry not found", 404);
      await this.extract(briefing.briefingId, [fetched], stats, signal, briefing.briefingId);
      if (stats.pointsFailed > 0) {
        // The summary model failed: attach a summary-based point instead of leaving the entry in limbo.
        this.store.attachEntryToBriefing({
          briefingId: briefing.briefingId,
          date: briefing.date,
          runId: briefing.briefingId,
          entry: fetched,
          points: [fallbackPoint(fetched)],
          now: this.now().toISOString()
        });
      }
      return { briefingId: briefing.briefingId, entry: this.store.getEntry(entry.entryId)! };
    } finally {
      this.rescueInProgress = false;
    }
  }
}
