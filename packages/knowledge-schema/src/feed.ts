import { z } from "zod";

// ── Feed domain types ─────────────────────────────────────────────────────

export type FeedSourceKind = "rss" | "listing";
export type FeedEntryStage = "discovered" | "scored" | "fetched" | "fetch_failed";
export type FeedBriefingState = "pending" | "composed";
export type FeedRunState = "running" | "completed" | "partial" | "failed";
export type FeedSignalType = "open" | "open_original" | "star" | "dismiss";

export interface FeedSourceStats {
  /** Entries discovered from this source in the stats window. */
  discovered: number;
  /** Entries that passed the coarse filter and were fetched. */
  selected: number;
  /** Entries with at least one point used in a composed briefing. */
  briefed: number;
  opened: number;
  starred: number;
  dismissed: number;
}

export interface FeedSource {
  sourceId: string;
  kind: FeedSourceKind;
  title: string;
  url: string;
  linkPattern?: string;
  enabled: boolean;
  weight: number;
  lastRunAt?: string;
  lastError?: string;
  createdAt: string;
  createdBy?: string;
  updatedBy?: string;
  stats?: FeedSourceStats;
}

export interface FeedEntry {
  entryId: string;
  sourceId: string;
  sourceTitle?: string;
  url: string;
  title: string;
  summary?: string;
  author?: string;
  publishedAt?: string;
  discoveredAt: string;
  stage: FeedEntryStage;
  score?: number;
  effectiveScore?: number;
  scoreReason?: string;
  topics: string[];
  selected: boolean;
  exploration: boolean;
  rescued: boolean;
  batchDate?: string;
  briefingId?: string;
  hasDocument: boolean;
  openedAt?: string;
  dismissedAt?: string;
  promotedItemId?: string;
  promotedAt?: string;
  expiresAt: string;
  lastError?: string;
}

export interface FeedPoint {
  pointId: string;
  entryId: string;
  text: string;
  /** Absent for entry-level citations. */
  sectionId?: string;
  /** Verbatim quote verified against the cited section. */
  quote?: string;
  used: boolean;
}

export interface FeedBriefingSummary {
  briefingId: string;
  date: string;
  state: FeedBriefingState;
  composer?: string;
  revision: number;
  preparedAt: string;
  composedAt?: string;
  pointCount: number;
  entryCount: number;
}

export interface FeedBriefingRef {
  pointId: string;
  entryId: string;
  sectionId?: string;
  quote?: string;
  title: string;
  url: string;
}

export interface FeedBriefingItem {
  text: string;
  /** True when the text was written by the composer rather than the summary model. */
  rewritten: boolean;
  refs: FeedBriefingRef[];
}

export interface FeedBriefingTopic {
  title: string;
  overview?: string;
  items: FeedBriefingItem[];
}

export interface FeedBriefingContent {
  date: string;
  composer: string;
  summary?: string;
  stats: {
    scored: number;
    selected: number;
    candidatePoints: number;
    usedPoints: number;
  };
  topics: FeedBriefingTopic[];
}

/** Live state of an entry referenced by a briefing, for action buttons. */
export interface FeedEntryState {
  exists: boolean;
  hasDocument: boolean;
  promotedItemId?: string;
  dismissedAt?: string;
}

export interface FeedBriefingDetail {
  briefing: FeedBriefingSummary;
  content?: FeedBriefingContent;
  entries: Record<string, FeedEntryState>;
}

export interface FeedCandidateEntry {
  entryId: string;
  title: string;
  url: string;
  sourceId?: string;
  sourceTitle?: string;
  publishedAt?: string;
  score?: number;
  effectiveScore?: number;
  scoreReason?: string;
  topics: string[];
  exploration: boolean;
  rescued: boolean;
  fetchFailed: boolean;
  state: FeedEntryState;
  points: FeedPoint[];
}

export interface FeedSkippedEntry {
  entryId: string;
  title: string;
  summary?: string;
  sourceTitle?: string;
  score?: number;
  effectiveScore?: number;
}

export interface FeedCandidates {
  briefing: FeedBriefingSummary;
  entries: FeedCandidateEntry[];
  /** Entries scored in the same batch that were not selected, best first. */
  skipped: FeedSkippedEntry[];
  rescueRemaining: number;
}

export interface FeedRunStats {
  expired: number;
  sourcesOk: number;
  sourcesFailed: number;
  discovered: number;
  duplicates: number;
  scored: number;
  scoreFailed: number;
  selected: number;
  fetched: number;
  fetchFailed: number;
  points: number;
  pointsFailed: number;
  stage: string;
}

export interface FeedRun {
  runId: string;
  triggeredBy: string;
  state: FeedRunState;
  stats: FeedRunStats;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  briefingId?: string;
}

export interface FeedStatus {
  enabled: true;
  running: boolean;
  run?: FeedRun;
  pendingBriefings: number;
  summaryModel: string;
}

export interface FeedSignal {
  signalId: string;
  type: FeedSignalType;
  entryId: string;
  sourceId: string;
  title: string;
  topics: string[];
  createdAt: string;
}

export interface FeedSettings {
  coarseHint: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface FeedSubmissionError {
  path: string;
  message: string;
}

// ── Request schemas ───────────────────────────────────────────────────────

const actorSchema = z.string().trim().min(1).max(100);

export const FeedSourceCreateRequestSchema = z.object({
  kind: z.enum(["rss", "listing"]),
  title: z.string().trim().min(1).max(200),
  url: z.string().url().max(2000),
  linkPattern: z.string().min(1).max(500).optional(),
  weight: z.number().min(0).max(2).optional(),
  createdBy: actorSchema.optional()
}).refine((input) => input.kind !== "listing" || Boolean(input.linkPattern), {
  message: "linkPattern is required for listing sources",
  path: ["linkPattern"]
});
export type FeedSourceCreateRequest = z.infer<typeof FeedSourceCreateRequestSchema>;

export const FeedSourceUpdateRequestSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
  weight: z.number().min(0).max(2).optional(),
  linkPattern: z.string().min(1).max(500).optional(),
  updatedBy: actorSchema.optional()
});
export type FeedSourceUpdateRequest = z.infer<typeof FeedSourceUpdateRequestSchema>;

export const FeedSettingsUpdateRequestSchema = z.object({
  coarseHint: z.string().max(4000),
  updatedBy: actorSchema.optional()
});
export type FeedSettingsUpdateRequest = z.infer<typeof FeedSettingsUpdateRequestSchema>;

export const FeedRunRequestSchema = z.object({
  triggeredBy: actorSchema.optional()
});
export type FeedRunRequest = z.infer<typeof FeedRunRequestSchema>;

export const FeedSignalRequestSchema = z.object({
  type: z.enum(["open", "open_original"])
});
export type FeedSignalRequest = z.infer<typeof FeedSignalRequestSchema>;

export const FeedPrepareEntryRequestSchema = z.object({
  briefingId: z.string().min(1).max(100).optional()
});
export type FeedPrepareEntryRequest = z.infer<typeof FeedPrepareEntryRequestSchema>;

export const FEED_SUBMISSION_LIMITS = {
  maxTopics: 30,
  maxItems: 200,
  maxPointIdsPerItem: 12,
  maxTitleLength: 200,
  maxTextLength: 1000,
  maxSummaryLength: 2000
} as const;

/**
 * Deliberately loose: structural rules are checked by the server so that a
 * rejected submission reports every problem with its path at once.
 */
export const FeedBriefingSubmitRequestSchema = z.object({
  composer: actorSchema,
  summary: z.string().optional(),
  topics: z.array(z.object({
    title: z.string(),
    overview: z.string().optional(),
    items: z.array(z.object({
      pointIds: z.array(z.string()),
      text: z.string().optional()
    }))
  }))
});
export type FeedBriefingSubmitRequest = z.infer<typeof FeedBriefingSubmitRequestSchema>;
