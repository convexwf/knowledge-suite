import { z } from "zod";
import type { KnowledgeItem, KnowledgeDocument, ParserCandidatePreview, ReadingProgressSnapshot } from "./document.js";
import type { RawDoc } from "./document.js";

// ── Input / Capture schemas ────────────────────────────────────────────────

export const InputModeSchema = z.enum(["browser_html", "server_fetch"]);
export type InputMode = z.infer<typeof InputModeSchema>;

export const PageSnapshotSchema = z.object({
  pageUrl: z.string().min(1),
  canonicalUrl: z.string().optional(),
  pageTitle: z.string().optional(),
  title: z.string().optional(),
  html: z.string().min(1),
  text: z.string().optional(),
  diagnostics: z.object({
    htmlLength: z.number(),
    textLength: z.number(),
    shadowRootCount: z.number()
  }).optional(),
  capturedAt: z.string().datetime(),
  meta: z.record(z.string(), z.string()).default({}),
  selectionHtml: z.string().optional()
});
export type PageSnapshot = z.infer<typeof PageSnapshotSchema>;

export const BrowserHtmlInputSchema = z.object({
  inputMode: z.literal("browser_html"),
  snapshot: PageSnapshotSchema
});

export const ServerFetchInputSchema = z.object({
  inputMode: z.literal("server_fetch"),
  url: z.string().url()
});

export const KnowledgeCaptureInputSchema = z.discriminatedUnion("inputMode", [
  BrowserHtmlInputSchema,
  ServerFetchInputSchema
]);
export type KnowledgeCaptureInput = z.infer<typeof KnowledgeCaptureInputSchema>;

export const KnowledgeCapturePreviewRequestSchema = KnowledgeCaptureInputSchema;
export type KnowledgeCapturePreviewRequest = z.infer<typeof KnowledgeCapturePreviewRequestSchema>;

const KnowledgeCaptureSaveOptionsSchema = z.object({
  candidateId: z.string().optional(),
  overwrite: z.boolean().optional(),
  owner: z.string().min(1).max(64).optional()
});

export const KnowledgeCaptureSaveRequestSchema = z.discriminatedUnion("inputMode", [
  BrowserHtmlInputSchema.merge(KnowledgeCaptureSaveOptionsSchema),
  ServerFetchInputSchema.merge(KnowledgeCaptureSaveOptionsSchema)
]);
export type KnowledgeCaptureSaveRequest = z.infer<typeof KnowledgeCaptureSaveRequestSchema>;

export const KnowledgeCaptureReparseRequestSchema = z.object({
  url: z.string().min(1)
});
export type KnowledgeCaptureReparseRequest = z.infer<typeof KnowledgeCaptureReparseRequestSchema>;

export const KnowledgeItemReadingProgressRequestSchema = z.object({
  section_id: z.string().min(1).max(512).nullable(),
  expected_revision: z.number().int().nonnegative()
});
export type KnowledgeItemReadingProgressRequest = z.infer<typeof KnowledgeItemReadingProgressRequestSchema>;

export const KnowledgeItemDeleteModeSchema = z.enum(["remove", "purge"]);
export type KnowledgeItemDeleteMode = z.infer<typeof KnowledgeItemDeleteModeSchema>;
export const KnowledgeCaptureDeleteModeSchema = z.enum(["remove", "purge"]);
export type KnowledgeCaptureDeleteMode = z.infer<typeof KnowledgeCaptureDeleteModeSchema>;

export const STORE_CLEAR_CONFIRMATION = "CLEAR KNOWLEDGE STORE";
export const STORE_CLEAR_PARSED_CONFIRMATION = "CLEAR PARSED RESULTS";

export const StoreClearRequestSchema = z.object({
  confirm: z.literal(true),
  confirmation: z.literal(STORE_CLEAR_CONFIRMATION)
});
export type StoreClearRequest = z.infer<typeof StoreClearRequestSchema>;

export const StoreClearParsedRequestSchema = z.object({
  confirm: z.literal(true),
  confirmation: z.literal(STORE_CLEAR_PARSED_CONFIRMATION)
});
export type StoreClearParsedRequest = z.infer<typeof StoreClearParsedRequestSchema>;

// ── Structured import (external content producers such as catbus) ──────────

export const StructuredImportReplySchema = z.object({
  id: z.string().min(1).max(512).optional(),
  author: z.string().max(256).optional(),
  text: z.string().min(1),
  createdAt: z.string().min(1).max(64).optional(),
  likes: z.number().int().nonnegative().optional()
});
export type StructuredImportReply = z.infer<typeof StructuredImportReplySchema>;

export const StructuredImportCommentSchema = z.object({
  id: z.string().min(1).max(512).optional(),
  parentId: z.string().min(1).max(512).optional(),
  author: z.string().max(256).optional(),
  text: z.string().min(1),
  createdAt: z.string().min(1).max(64).optional(),
  likes: z.number().int().nonnegative().optional(),
  replies: z.array(StructuredImportReplySchema).max(10).optional()
});
export type StructuredImportComment = z.infer<typeof StructuredImportCommentSchema>;

export const StructuredImportMediaSchema = z.object({
  type: z.enum(["image", "video", "audio", "file"]),
  url: z.string().url(),
  alt: z.string().max(512).optional(),
  caption: z.string().max(1024).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional()
});
export type StructuredImportMedia = z.infer<typeof StructuredImportMediaSchema>;

export const StructuredImportRequestSchema = z.object({
  provider: z.string().min(1).max(64),
  platform: z.string().min(1).max(64),
  itemId: z.string().min(1).max(512),
  url: z.string().url(),
  canonicalUrl: z.string().url().optional(),
  title: z.string().min(1).max(1000),
  authors: z.array(z.string().min(1).max(256)).max(50).optional(),
  publishedAt: z.string().min(1).max(64).optional(),
  language: z.string().min(1).max(64).optional(),
  tags: z.array(z.string().min(1).max(64)).max(50).optional(),
  owner: z.string().min(1).max(64).optional(),
  markdown: z.string().min(1),
  comments: z.array(StructuredImportCommentSchema).max(100).optional(),
  media: z.array(StructuredImportMediaSchema).max(50).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  commentsMode: z.enum(["append", "none"]).default("append"),
  overwrite: z.boolean().default(true)
});
export type StructuredImportRequest = z.infer<typeof StructuredImportRequestSchema>;

// ── Response types ─────────────────────────────────────────────────────────

export interface KnowledgeItemStatus {
  normalizedUrl: string;
  urlHash: string;
  state: "empty" | "captured" | "parsed";
  hasRawdoc: boolean;
  hasDocument: boolean;
  originalUrl?: string;
  canonicalUrl?: string;
  captureSavedAt?: string;
  captureUpdatedAt?: string;
  parseUpdatedAt?: string;
  title?: string;
  pageTitle?: string;
  contentTitle?: string;
  displayTitle?: string;
  itemId?: string;
  docId?: string;
  rawdocId?: string;
}

export interface KnowledgePreviewResponse {
  rawdoc: RawDoc;
  document: KnowledgeDocument;
  markdown: string;
  candidatePreviews?: ParserCandidatePreview[];
  selectedCandidateId?: string;
  serverSelectedCandidateId?: string;
  activeCandidateId?: string;
  status: KnowledgeItemStatus;
}

export interface KnowledgeSaveResponse extends KnowledgePreviewResponse {
  saved: true;
  paths: {
    rawHtmlPath: string;
    rawdocPath: string;
    documentPath: string;
    markdownPath: string;
  };
}

export interface EpubImportResponse {
  knowledgeItem: KnowledgeItem;
  rawdoc: RawDoc;
  document: KnowledgeDocument;
  markdown: string;
  saved: true;
  paths: {
    rawContentPath: string;
    rawdocPath: string;
    documentPath: string;
    markdownPath: string;
  };
}

export interface MarkdownImportResponse extends EpubImportResponse {
  warnings?: string[];
}

export interface GitHubMarkdownImportRequest {
  owner: string;
  repo: string;
  ref: string;
  path: string;
  tags?: string[];
}

export interface GitHubMarkdownAssetSummary {
  path: string;
  blobSha?: string;
  size?: number;
  mediaType: string;
  delivery: "raw" | "proxy";
}

export interface GitHubMarkdownScanFile {
  path: string;
  blobSha: string;
  size: number;
  referencedAssetCount: number;
  assets: GitHubMarkdownAssetSummary[];
  warnings: string[];
}

export interface GitHubMarkdownScanResponse {
  owner: string;
  repo: string;
  ref: string;
  path: string;
  commitSha: string;
  private: boolean;
  files: GitHubMarkdownScanFile[];
  warnings: string[];
}

export interface GitHubMarkdownImportResponse {
  commitSha: string;
  results: Array<{
    path: string;
    saved: boolean;
    knowledgeItem?: KnowledgeItem;
    warnings?: string[];
    error?: string;
  }>;
}

export interface GitHubMarkdownRefreshResponse {
  updated: boolean;
  status: "up_to_date" | "updated" | "remote_deleted";
  commitSha?: string;
  checkedAt: string;
  knowledgeItem?: KnowledgeItem;
  rawdoc?: RawDoc;
  document?: KnowledgeDocument;
  markdown?: string;
  warnings?: string[];
  oldCommitSha?: string;
}

export interface GitHubMarkdownUpdateStatusResponse {
  status: "up_to_date" | "update_available" | "remote_deleted" | "unavailable";
  commitSha?: string;
  checkedAt: string;
}

export interface KnowledgeItemListResponse {
  items: KnowledgeItem[];
}

export interface KnowledgeItemDetailResponse {
  item: KnowledgeItem;
  rawdoc?: RawDoc;
  document?: KnowledgeDocument;
  collectionIds?: string[];
}

export interface KnowledgeItemReadingProgressResponse {
  itemId: string;
  progress: ReadingProgressSnapshot | null;
}

export interface KnowledgeItemReadingProgressConflictResponse {
  error: "reading_progress_conflict";
  currentProgress: ReadingProgressSnapshot | null;
}

export interface DocumentOutlineEntry {
  title: string;
  level: number;
  target: string;
}

export interface DocumentOutlineFile {
  formatVersion: 1;
  docId: string;
  entries: DocumentOutlineEntry[];
}

export interface DocumentOutlineResponse extends Omit<DocumentOutlineFile, "entries"> {
  entries: Array<DocumentOutlineEntry & { targetAvailable: boolean }>;
  diagnostics: Array<{
    entryIndex: number;
    code: "target_not_found";
    target: string;
  }>;
}

export interface KnowledgeItemDeleteResponse {
  itemId: string;
  deleted: boolean;
  mode: KnowledgeItemDeleteMode;
  previousState: "captured" | "parsed";
  currentState: "empty" | "captured";
  deletedFiles: string[];
  removedDocId?: string;
  removedRawdocId?: string;
}

export interface KnowledgeItemStatusResponse extends KnowledgeItemStatus {}

export interface KnowledgeDeleteByUrlResponse extends KnowledgeItemStatus {
  deleted: boolean;
  mode: KnowledgeItemDeleteMode;
  previousState: "captured" | "parsed";
  currentState: "empty" | "captured";
  deletedFiles: string[];
  removedDocId?: string;
  removedRawdocId?: string;
}
