import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodType } from "zod";
import {
  FeedBriefingSubmitRequestSchema,
  FeedPrepareEntryRequestSchema,
  FeedRunRequestSchema,
  FeedSettingsUpdateRequestSchema,
  FeedSignalRequestSchema,
  FeedSourceCreateRequestSchema,
  FeedSourceUpdateRequestSchema,
  type FeedBriefingDetail,
  type FeedSource,
  type FeedStatus
} from "@uknowledge/knowledge-schema";
import type { FeedConfig } from "../config.js";
import { buildCandidates, composeBriefing, entryStatesForPoints } from "./compose.js";
import { promoteEntry, type KnowledgeSaver } from "./promote.js";
import { expireEntry } from "./retention.js";
import { FeedBusyError, FeedRescueError, type FeedRunner } from "./runner.js";
import { compileLinkPattern } from "./sources.js";
import { addDays, localDate, type FeedStore } from "./store.js";

const STATS_WINDOW_DAYS = 30;

export interface FeedRouteOptions {
  store: FeedStore;
  runner: FeedRunner;
  config: FeedConfig;
  saveToKnowledge: KnowledgeSaver;
  summaryModel: string;
  now?: () => Date;
}

/** Registered instead of the real routes when the feed module is switched off. */
export function registerFeedDisabledRoutes(app: FastifyInstance): void {
  app.all("/api/feed/*", async (_request, reply) => reply.code(404).send({
    error: "feed_disabled",
    message: "Feed is disabled. Set KNOWLEDGE_FEED_ENABLED=true to enable it."
  }));
}

export function registerFeedRoutes(app: FastifyInstance, options: FeedRouteOptions): void {
  const { store, runner, config } = options;
  const now = options.now ?? (() => new Date());

  function parseBody<T>(schema: ZodType<T>, body: unknown, reply: FastifyReply): T | undefined {
    const parsed = schema.safeParse(body ?? {});
    if (parsed.success) return parsed.data;
    void reply.code(400).send({
      error: "bad_request",
      message: "Invalid request body",
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
    });
    return undefined;
  }

  function withStats(sources: FeedSource[]): FeedSource[] {
    const current = now();
    const stats = store.sourceStats(
      localDate(addDays(current, -STATS_WINDOW_DAYS)),
      addDays(current, -STATS_WINDOW_DAYS).toISOString()
    );
    return sources.map((source) => ({
      ...source,
      stats: stats.get(source.sourceId)
        ?? { discovered: 0, selected: 0, briefed: 0, opened: 0, starred: 0, dismissed: 0 }
    }));
  }

  function notFound(reply: FastifyReply, error: string, message: string) {
    return reply.code(404).send({ error, message });
  }

  // ── sources ───────────────────────────────────────────────────────────

  app.get("/api/feed/sources", async () => ({ sources: withStats(store.listSources()) }));

  app.post("/api/feed/sources", async (request, reply) => {
    const input = parseBody(FeedSourceCreateRequestSchema, request.body, reply);
    if (!input) return reply;
    if (input.linkPattern) {
      try {
        compileLinkPattern(input.linkPattern);
      } catch (error) {
        return reply.code(400).send({ error: "invalid_link_pattern", message: (error as Error).message });
      }
    }
    const existing = store.getSourceByUrl(input.url);
    if (existing) {
      return reply.code(409).send({ error: "feed_source_exists", sourceId: existing.sourceId });
    }
    const source = store.createSource({
      kind: input.kind,
      title: input.title,
      url: input.url,
      linkPattern: input.kind === "listing" ? input.linkPattern : undefined,
      weight: input.weight,
      createdBy: input.createdBy,
      now: now().toISOString()
    });
    return reply.code(201).send({ source });
  });

  app.patch("/api/feed/sources/:sourceId", async (request, reply) => {
    const { sourceId } = request.params as { sourceId: string };
    const input = parseBody(FeedSourceUpdateRequestSchema, request.body, reply);
    if (!input) return reply;
    if (input.linkPattern) {
      try {
        compileLinkPattern(input.linkPattern);
      } catch (error) {
        return reply.code(400).send({ error: "invalid_link_pattern", message: (error as Error).message });
      }
    }
    const source = store.updateSource(sourceId, input);
    if (!source) return notFound(reply, "feed_source_not_found", "Feed source not found");
    return { source };
  });

  app.delete("/api/feed/sources/:sourceId", async (request, reply) => {
    const { sourceId } = request.params as { sourceId: string };
    if (!store.getSource(sourceId)) return notFound(reply, "feed_source_not_found", "Feed source not found");
    if (runner.activeRunId) {
      return reply.code(409).send({ error: "feed_run_in_progress", runId: runner.activeRunId });
    }
    const entries = store.entriesBySource(sourceId);
    for (const entry of entries) await expireEntry(store, entry, now());
    store.deleteSourceRow(sourceId);
    return { deleted: true, removedEntries: entries.length };
  });

  // ── entries ───────────────────────────────────────────────────────────

  app.get("/api/feed/entries", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const limit = clampInt(query.limit, 50, 1, 200);
    const offset = clampInt(query.cursor, 0, 0, Number.MAX_SAFE_INTEGER);
    const result = store.listEntries({
      briefingId: query.briefingId || undefined,
      sourceId: query.sourceId || undefined,
      selected: query.selected === "true" ? true : query.selected === "false" ? false : undefined,
      limit,
      offset
    });
    const nextOffset = offset + result.entries.length;
    return {
      entries: result.entries,
      total: result.total,
      nextCursor: nextOffset < result.total ? String(nextOffset) : undefined
    };
  });

  app.get("/api/feed/entries/:entryId", async (request, reply) => {
    const { entryId } = request.params as { entryId: string };
    const entry = store.getEntry(entryId);
    if (entry) return { entry };
    return sendMissingEntry(reply, entryId);
  });

  app.get("/api/feed/entries/:entryId/document", async (request, reply) => {
    const { entryId } = request.params as { entryId: string };
    const entry = store.getEntry(entryId);
    if (!entry) return sendMissingEntry(reply, entryId);
    const document = entry.hasDocument ? await store.readDocument(entryId) : undefined;
    if (!document) {
      return reply.code(404).send({
        error: "feed_document_not_found",
        message: "This entry has no fetched full text.",
        url: entry.url
      });
    }
    return { entry, document };
  });

  app.post("/api/feed/entries/:entryId/prepare", async (request, reply) => {
    const { entryId } = request.params as { entryId: string };
    const input = parseBody(FeedPrepareEntryRequestSchema, request.body, reply);
    if (!input) return reply;
    try {
      const result = await runner.rescueEntry(entryId, input.briefingId);
      const points = store.pointsForBriefing(result.briefingId)
        .filter((point) => point.entryId === entryId)
        .map((point) => ({
          pointId: point.pointId,
          entryId: point.entryId,
          text: point.text,
          sectionId: point.sectionId,
          quote: point.quote,
          used: point.used
        }));
      return { briefingId: result.briefingId, entry: result.entry, points };
    } catch (error) {
      if (error instanceof FeedBusyError) {
        return reply.code(409).send({ error: "feed_run_in_progress", runId: error.runId });
      }
      if (error instanceof FeedRescueError) {
        return reply.code(error.statusCode).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post("/api/feed/entries/:entryId/star", async (request, reply) => {
    const { entryId } = request.params as { entryId: string };
    const entry = store.getEntry(entryId);
    if (!entry) return sendMissingEntry(reply, entryId);
    const itemId = await promoteEntry(store, entry, options.saveToKnowledge, now());
    return { itemId, entry: store.getEntry(entryId) };
  });

  app.post("/api/feed/entries/:entryId/dismiss", async (request, reply) => {
    const { entryId } = request.params as { entryId: string };
    const entry = store.getEntry(entryId);
    if (!entry) return sendMissingEntry(reply, entryId);
    if (!entry.dismissedAt) {
      const at = now().toISOString();
      store.markDismissed(entryId, at);
      store.addSignal("dismiss", entry, at);
    }
    return { entry: store.getEntry(entryId) };
  });

  app.post("/api/feed/entries/:entryId/signals", async (request, reply) => {
    const { entryId } = request.params as { entryId: string };
    const input = parseBody(FeedSignalRequestSchema, request.body, reply);
    if (!input) return reply;
    const entry = store.getEntry(entryId);
    if (!entry) return sendMissingEntry(reply, entryId);
    const at = now().toISOString();
    store.markOpened(entryId, at);
    store.addSignal(input.type, entry, at);
    return { recorded: true };
  });

  function sendMissingEntry(reply: FastifyReply, entryId: string) {
    const tombstone = store.getTombstoneByEntry(entryId);
    if (!tombstone) return notFound(reply, "feed_entry_not_found", "Feed entry not found");
    return reply.code(410).send({
      error: "feed_entry_expired",
      url: tombstone.url,
      ...(tombstone.promotedItemId ? { promotedItemId: tombstone.promotedItemId } : {})
    });
  }

  // ── briefings ─────────────────────────────────────────────────────────

  app.get("/api/feed/briefings", async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    if (query.state && query.state !== "pending" && query.state !== "composed") {
      return reply.code(400).send({ error: "bad_request", message: "state must be pending or composed" });
    }
    return {
      briefings: store.listBriefings(
        query.state as "pending" | "composed" | undefined,
        clampInt(query.limit, 30, 1, 200)
      )
    };
  });

  app.get("/api/feed/briefings/:briefingId", async (request, reply) => {
    const { briefingId } = request.params as { briefingId: string };
    const found = store.getBriefing(briefingId);
    if (!found) return notFound(reply, "feed_briefing_not_found", "Feed briefing not found");
    const { content, ...briefing } = found;
    const detail: FeedBriefingDetail = {
      briefing,
      content,
      entries: entryStatesForPoints(store, store.pointsForBriefing(briefing.briefingId))
    };
    return detail;
  });

  app.get("/api/feed/briefings/:briefingId/candidates", async (request, reply) => {
    const { briefingId } = request.params as { briefingId: string };
    const found = store.getBriefing(briefingId);
    if (!found) return notFound(reply, "feed_briefing_not_found", "Feed briefing not found");
    const { content: _content, ...briefing } = found;
    return buildCandidates(store, briefing, config.maxRescuePerBriefing);
  });

  app.put("/api/feed/briefings/:briefingId/content", async (request, reply) => {
    const { briefingId } = request.params as { briefingId: string };
    const input = parseBody(FeedBriefingSubmitRequestSchema, request.body, reply);
    if (!input) return reply;
    const found = store.getBriefing(briefingId);
    if (!found) return notFound(reply, "feed_briefing_not_found", "Feed briefing not found");
    const points = store.pointsForBriefing(found.briefingId);
    const result = composeBriefing(input, points, {
      date: found.date,
      scored: store.countScored(found.date),
      selected: new Set(points.map((point) => point.entryId)).size
    });
    if (!result.ok) {
      return reply.code(400).send({
        error: "invalid_briefing",
        message: "The submission was rejected; fix the listed errors and submit again.",
        errors: result.errors
      });
    }
    store.saveBriefingContent({
      briefingId: found.briefingId,
      content: result.content,
      composer: input.composer,
      usedPointIds: result.usedPointIds,
      now: now().toISOString()
    });
    const saved = store.getBriefing(found.briefingId)!;
    const { content, ...briefing } = saved;
    return { briefing, content };
  });

  // ── signals and settings ──────────────────────────────────────────────

  app.get("/api/feed/signals", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const signals = store.listSignals(query.since || undefined, clampInt(query.limit, 200, 1, 1000));
    return {
      signals,
      nextSince: signals.length > 0 ? signals[signals.length - 1].createdAt : query.since,
      sources: withStats(store.listSources()).map((source) => ({
        sourceId: source.sourceId,
        title: source.title,
        enabled: source.enabled,
        weight: source.weight,
        stats: source.stats
      }))
    };
  });

  app.get("/api/feed/settings", async () => ({ settings: store.getSettings() }));

  app.put("/api/feed/settings", async (request, reply) => {
    const input = parseBody(FeedSettingsUpdateRequestSchema, request.body, reply);
    if (!input) return reply;
    return { settings: store.setSettings(input.coarseHint.trim(), input.updatedBy, now().toISOString()) };
  });

  // ── runs ──────────────────────────────────────────────────────────────

  app.post("/api/feed/run", async (request, reply) => {
    const input = parseBody(FeedRunRequestSchema, request.body, reply);
    if (!input) return reply;
    try {
      const run = runner.start(input.triggeredBy ?? "manual");
      return reply.code(202).send({ runId: run.runId, run });
    } catch (error) {
      if (error instanceof FeedBusyError) {
        return reply.code(409).send({ error: "feed_run_in_progress", runId: error.runId });
      }
      throw error;
    }
  });

  app.get("/api/feed/status", async () => {
    const status: FeedStatus = {
      enabled: true,
      running: Boolean(runner.activeRunId),
      run: runner.activeRunId ? store.getRun(runner.activeRunId) : store.latestRun(),
      pendingBriefings: store.pendingBriefingCount(),
      summaryModel: options.summaryModel
    };
    return status;
  });
}

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}
