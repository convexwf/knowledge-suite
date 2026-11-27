import {
  FEED_SUBMISSION_LIMITS,
  type FeedBriefingContent,
  type FeedBriefingRef,
  type FeedBriefingSubmitRequest,
  type FeedBriefingSummary,
  type FeedBriefingTopic,
  type FeedCandidateEntry,
  type FeedCandidates,
  type FeedEntry,
  type FeedEntryState,
  type FeedSubmissionError
} from "@uknowledge/knowledge-schema";
import type { FeedPointRow, FeedStore } from "./store.js";

const MAX_SKIPPED_ENTRIES = 200;

export function entryState(entry: FeedEntry | undefined, promotedItemId?: string): FeedEntryState {
  if (!entry) return { exists: false, hasDocument: false, promotedItemId };
  return {
    exists: true,
    hasDocument: entry.hasDocument,
    promotedItemId: entry.promotedItemId,
    dismissedAt: entry.dismissedAt
  };
}

/** Live state of every entry a briefing's points refer to. */
export function entryStatesForPoints(store: FeedStore, points: FeedPointRow[]): Record<string, FeedEntryState> {
  const entryIds = [...new Set(points.map((point) => point.entryId))];
  const entries = store.getEntries(entryIds);
  const missing = entryIds.filter((entryId) => !entries.has(entryId));
  const promoted = store.promotedTombstones(missing);
  const states: Record<string, FeedEntryState> = {};
  for (const entryId of entryIds) {
    states[entryId] = entryState(entries.get(entryId), promoted.get(entryId));
  }
  return states;
}

/** Everything the composing agent (or the unarranged view) needs for one briefing. */
export function buildCandidates(
  store: FeedStore,
  briefing: FeedBriefingSummary,
  maxRescuePerBriefing: number
): FeedCandidates {
  const points = store.pointsForBriefing(briefing.briefingId);
  const attached = store.entriesForBriefing(briefing.briefingId);
  const states = entryStatesForPoints(store, points);

  const byEntry = new Map<string, FeedCandidateEntry>();
  const ensure = (entryId: string, title: string, url: string): FeedCandidateEntry => {
    let candidate = byEntry.get(entryId);
    if (!candidate) {
      const entry = attached.get(entryId);
      candidate = {
        entryId,
        title: entry?.title ?? title,
        url: entry?.url ?? url,
        sourceId: entry?.sourceId,
        sourceTitle: entry?.sourceTitle,
        publishedAt: entry?.publishedAt,
        score: entry?.score,
        effectiveScore: entry?.effectiveScore,
        scoreReason: entry?.scoreReason,
        topics: entry?.topics ?? [],
        exploration: entry?.exploration ?? false,
        rescued: entry?.rescued ?? false,
        fetchFailed: entry?.stage === "fetch_failed",
        state: states[entryId] ?? entryState(entry),
        points: []
      };
      byEntry.set(entryId, candidate);
    }
    return candidate;
  };

  for (const point of points) {
    ensure(point.entryId, point.entryTitle, point.entryUrl).points.push({
      pointId: point.pointId,
      entryId: point.entryId,
      text: point.text,
      sectionId: point.sectionId,
      quote: point.quote,
      used: point.used
    });
  }
  // Entries whose extraction produced no usable point still belong to the batch.
  for (const entry of attached.values()) ensure(entry.entryId, entry.title, entry.url);

  const entries = [...byEntry.values()].sort((left, right) =>
    (right.effectiveScore ?? -1) - (left.effectiveScore ?? -1) || left.entryId.localeCompare(right.entryId)
  );
  const skipped = store.skippedEntries(briefing.date, MAX_SKIPPED_ENTRIES).map((entry) => ({
    entryId: entry.entryId,
    title: entry.title,
    summary: entry.summary?.slice(0, 200),
    sourceTitle: entry.sourceTitle,
    score: entry.score,
    effectiveScore: entry.effectiveScore
  }));
  return {
    briefing,
    entries,
    skipped,
    rescueRemaining: Math.max(0, maxRescuePerBriefing - store.countRescued(briefing.briefingId))
  };
}

export type SubmissionResult =
  | { ok: true; content: FeedBriefingContent; usedPointIds: string[] }
  | { ok: false; errors: FeedSubmissionError[] };

/**
 * Check a submission against the briefing's candidate points and expand it
 * into stored content. The composer supplies structure and optional wording;
 * every citation is copied from a verified point, never from the submission.
 */
export function composeBriefing(
  submission: FeedBriefingSubmitRequest,
  points: FeedPointRow[],
  context: { date: string; scored: number; selected: number }
): SubmissionResult {
  const limits = FEED_SUBMISSION_LIMITS;
  const errors: FeedSubmissionError[] = [];
  const pointsById = new Map(points.map((point) => [point.pointId, point]));
  const used = new Set<string>();
  const topics: FeedBriefingTopic[] = [];
  let itemCount = 0;

  const summary = cleanText(submission.summary);
  if (summary && summary.length > limits.maxSummaryLength) {
    errors.push({ path: "summary", message: `must be at most ${limits.maxSummaryLength} characters` });
  }
  if (submission.topics.length === 0) {
    errors.push({ path: "topics", message: "at least one topic is required" });
  }
  if (submission.topics.length > limits.maxTopics) {
    errors.push({ path: "topics", message: `at most ${limits.maxTopics} topics are allowed` });
  }

  submission.topics.forEach((topic, topicIndex) => {
    const topicPath = `topics[${topicIndex}]`;
    const title = cleanText(topic.title);
    if (!title) errors.push({ path: `${topicPath}.title`, message: "must not be empty" });
    if (title.length > limits.maxTitleLength) {
      errors.push({ path: `${topicPath}.title`, message: `must be at most ${limits.maxTitleLength} characters` });
    }
    const overview = cleanText(topic.overview);
    if (overview.length > limits.maxTextLength) {
      errors.push({ path: `${topicPath}.overview`, message: `must be at most ${limits.maxTextLength} characters` });
    }
    if (topic.items.length === 0) {
      errors.push({ path: `${topicPath}.items`, message: "at least one item is required" });
    }

    const items: FeedBriefingTopic["items"] = [];
    topic.items.forEach((item, itemIndex) => {
      const itemPath = `${topicPath}.items[${itemIndex}]`;
      itemCount += 1;
      const pointIds = [...new Set(item.pointIds.map((pointId) => pointId.trim()).filter(Boolean))];
      if (pointIds.length === 0) {
        errors.push({ path: `${itemPath}.pointIds`, message: "at least one point id is required" });
        return;
      }
      if (pointIds.length > limits.maxPointIdsPerItem) {
        errors.push({
          path: `${itemPath}.pointIds`,
          message: `at most ${limits.maxPointIdsPerItem} point ids are allowed per item`
        });
      }
      const refs: FeedBriefingRef[] = [];
      for (const pointId of pointIds) {
        const point = pointsById.get(pointId);
        if (!point) {
          errors.push({ path: `${itemPath}.pointIds`, message: `point '${pointId}' is not a candidate of this briefing` });
          continue;
        }
        used.add(pointId);
        refs.push({
          pointId,
          entryId: point.entryId,
          sectionId: point.sectionId,
          quote: point.quote,
          title: point.entryTitle,
          url: point.entryUrl
        });
      }
      const text = cleanText(item.text);
      if (text.length > limits.maxTextLength) {
        errors.push({ path: `${itemPath}.text`, message: `must be at most ${limits.maxTextLength} characters` });
      }
      if (!text && pointIds.length > 1) {
        errors.push({ path: `${itemPath}.text`, message: "is required when an item cites more than one point" });
        return;
      }
      if (refs.length === 0) return;
      const original = pointsById.get(pointIds[0])?.text ?? "";
      items.push({
        text: text || original,
        rewritten: Boolean(text) && text !== original,
        refs
      });
    });
    topics.push({ title, ...(overview ? { overview } : {}), items });
  });

  if (itemCount > limits.maxItems) {
    errors.push({ path: "topics", message: `at most ${limits.maxItems} items are allowed in total` });
  }
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    usedPointIds: [...used],
    content: {
      date: context.date,
      composer: submission.composer,
      ...(summary ? { summary } : {}),
      stats: {
        scored: context.scored,
        selected: context.selected,
        candidatePoints: points.length,
        usedPoints: used.size
      },
      topics
    }
  };
}

function cleanText(value: string | undefined): string {
  return (value ?? "").replace(/[ \t\r\f\v]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
