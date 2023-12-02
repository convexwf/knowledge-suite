import { z } from "zod";
import type { KnowledgeItemStatus } from "./api.js";

// ── Batch / Collection request schemas ─────────────────────────────────────

export const BatchCandidateSchema = z.object({
  url: z.string().url(),
  text: z.string().optional(),
  titleHint: z.string().optional(),
  source: z.string().optional(),
  order: z.number().int().nonnegative().optional(),
  depth: z.number().int().nonnegative().optional()
});
export type BatchCandidate = z.infer<typeof BatchCandidateSchema>;

export const BatchDiscoverRequestSchema = z.object({
  pageUrl: z.string().url(),
  candidates: z.array(BatchCandidateSchema).max(500),
  scope: z.object({
    sameOrigin: z.boolean().default(true),
    pathPrefix: z.string().optional(),
    maxItems: z.number().int().positive().max(200).default(50)
  }).optional()
});
export type BatchDiscoverRequest = z.infer<typeof BatchDiscoverRequestSchema>;

export const BatchJobItemInputSchema = z.object({
  url: z.string().url(),
  titleHint: z.string().optional(),
  source: z.string().optional(),
  order: z.number().int().nonnegative().optional(),
  depth: z.number().int().nonnegative().optional()
});
export type BatchJobItemInput = z.infer<typeof BatchJobItemInputSchema>;

export const BatchJobCreateRequestSchema = z.object({
  sourcePageUrl: z.string().url(),
  mode: z.literal("server_fetch").default("server_fetch"),
  collection: z.object({
    title: z.string().min(1),
    rootUrl: z.string().url(),
    strategy: z.enum(["create", "update"]).default("create"),
    collectionId: z.string().optional()
  }),
  urls: z.array(z.string().url()).optional(),
  items: z.array(BatchJobItemInputSchema).optional(),
  options: z.object({
    skipExisting: z.boolean().default(true),
    maxConcurrency: z.number().int().positive().max(10).default(3)
  }).optional()
}).refine((value) => Boolean(value.urls?.length || value.items?.length), {
  message: "urls or items is required"
});
export type BatchJobCreateRequest = z.infer<typeof BatchJobCreateRequestSchema>;

// ── Batch / Collection domain types ────────────────────────────────────────

export type BatchItemState =
  | "pending"
  | "fetching"
  | "parsing"
  | "saving"
  | "saved"
  | "skipped"
  | "failed"
  | "cancelled";

export type BatchJobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type CollectionState = "draft" | "active" | "partial" | "archived";

export interface BatchDiscoverItem {
  url: string;
  normalizedUrl: string;
  titleHint?: string;
  source?: string;
  order: number;
  depth: number;
  selectedByDefault: boolean;
  status: KnowledgeItemStatus["state"];
  itemId?: string;
  docId?: string;
  rawdocId?: string;
}

export interface BatchDiscoverResponse {
  pageUrl: string;
  items: BatchDiscoverItem[];
  stats: {
    inputCount: number;
    dedupedCount: number;
    selectedCount: number;
  };
}

export interface CollectionItem {
  collectionItemId: string;
  collectionId: string;
  itemId: string;
  normalizedUrl: string;
  docId?: string;
  rawdocId?: string;
  title?: string;
  pageTitle?: string;
  contentTitle?: string;
  displayTitle?: string;
  orderIndex: number;
  depth: number;
  parentItemId?: string;
  source?: string;
  state: BatchItemState;
  creators?: string[];
  language?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CollectionSummary {
  collectionId: string;
  title: string;
  rootUrl?: string;
  normalizedRootUrl?: string;
  sourceType: string;
  state: CollectionState;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
}

export interface BatchJobItem {
  itemId: string;
  jobId: string;
  collectionId?: string;
  url: string;
  normalizedUrl?: string;
  source?: string;
  titleHint?: string;
  state: BatchItemState;
  rawdocId?: string;
  docId?: string;
  errorCode?: string;
  errorMessage?: string;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface BatchJobResponse {
  collectionId?: string;
  jobId: string;
  state: BatchJobState;
  total: number;
  saved: number;
  skipped: number;
  failed: number;
  cancelled: number;
  items: BatchJobItem[];
}
