import { z } from "zod";
import type { KnowledgeItem, KnowledgeDocument, ParserCandidatePreview } from "./document.js";
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
  overwrite: z.boolean().optional()
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

export interface KnowledgeItemListResponse {
  items: KnowledgeItem[];
}

export interface KnowledgeItemDetailResponse {
  item: KnowledgeItem;
  rawdoc?: RawDoc;
  document?: KnowledgeDocument;
  collectionIds?: string[];
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
