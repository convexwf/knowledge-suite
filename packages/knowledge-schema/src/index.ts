import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

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

export interface RawDoc {
  rawdoc_id: string;
  source_type: "url" | "singlefile_html" | "pdf" | "epub";
  source_uri: string;
  fetch_time: string;
  content_type?: string;
  content_length?: number;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeItem {
  itemId: string;
  sourceType: "url" | "singlefile_html" | "pdf" | "epub";
  identityHash: string;
  activeRawdocId: string;
  activeDocId?: string;
  normalizedUrl?: string;
  originalUrl?: string;
  canonicalUrl?: string;
  title?: string;
  pageTitle?: string;
  contentTitle?: string;
  displayTitle?: string;
  subtitle?: string;
  creators: string[];
  language?: string;
  tags: string[];
  state: "captured" | "parsed";
  createdAt: string;
  updatedAt: string;
  parsedAt?: string;
  collectionIds?: string[];
}

export type DocumentSectionType =
  | "heading"
  | "paragraph"
  | "blockquote"
  | "list"
  | "table"
  | "code"
  | "figure";

export interface DocumentSection {
  section_id?: string;
  type: DocumentSectionType;
  level?: number;
  content?: string;
  items?: Array<string | { text: string; items?: string[] }>;
  rows?: unknown[];
  assets?: Array<{
    asset_id?: string;
    path?: string;
    source_url?: string;
    alt?: string;
    caption?: string | null;
  }>;
  annotations?: Record<string, unknown>;
}

export interface KnowledgeDocument {
  doc_id: string;
  meta: {
    title: string;
    page_title?: string;
    source: {
      type: "html" | "pdf" | "epub";
      url?: string | null;
      rawdoc_id?: string;
    };
    authors?: string[];
    published_at?: string | null;
    updated_at?: string | null;
    ingested_at: string;
    language?: string;
    tags?: string[];
    parser_version?: string;
    cover_asset_id?: string;
    statistics?: {
      sectionCount: number;
      headingCount: number;
      paragraphCount: number;
      tableCount: number;
      figureCount: number;
      imageCount: number;
      assetCount: number;
      charCount: number;
    };
  };
  references?: Array<{
    ref_id: string;
    label?: string;
    text: string;
    blocks?: string[];
  }>;
  sections: DocumentSection[];
}

export interface ParserCandidateMetrics {
  textLength: number;
  sectionCount: number;
  headingCount: number;
  linkCount: number;
  imageCount: number;
  tableCount: number;
  codeCount: number;
  linkDensity: number;
}

export interface ParserCandidatePreview {
  id: string;
  method: string;
  adapterId?: string;
  selector?: string;
  selected: boolean;
  score: number;
  metrics: ParserCandidateMetrics;
  warnings: string[];
  reason: string;
  serverSelected?: boolean;
  document: KnowledgeDocument;
  markdown: string;
}

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

export interface StoreMaintenanceScan {
  storeRoot: string;
  scannedAt: string;
  database: {
    exists: boolean;
    path: "index.sqlite3";
    sizeBytes: number;
  };
  tables: {
    knowledgeItems: number;
    webItems: number;
    epubMetadata: number;
    rawdocs: number;
    documents: number;
    chunks: number;
    collections: number;
    collectionItems: number;
    batchJobs: number;
    batchItems: number;
  };
  files: {
    rawdocs: number;
    documents: number;
    markdown: number;
    assets: number;
    totalContentFiles: number;
  };
  totals: {
    rows: number;
    contentFiles: number;
  };
  parsedResults: {
    parsedItems: number;
    parsedWebItems: number;
    documentRows: number;
    chunkRows: number;
    collectionItemRefs: number;
    batchItemRefs: number;
    derivedFiles: number;
  };
}

export interface StoreClearResponse {
  cleared: true;
  mode: "all";
  before: StoreMaintenanceScan;
  after: StoreMaintenanceScan;
}

export interface StoreClearParsedResponse {
  cleared: true;
  mode: "parsed";
  before: StoreMaintenanceScan;
  after: StoreMaintenanceScan;
}

export interface SavedKnowledgeItem extends KnowledgeItemStatus {}
export interface SavedKnowledgeItemListEntry extends SavedKnowledgeItem {
  normalizedUrl: string;
  urlHash: string;
  state: "captured" | "parsed";
  hasRawdoc: true;
  hasDocument: boolean;
  originalUrl?: string;
  canonicalUrl?: string;
  captureSavedAt: string;
  captureUpdatedAt: string;
  parseUpdatedAt?: string;
  title?: string;
  pageTitle?: string;
  contentTitle?: string;
  displayTitle?: string;
  itemId?: string;
  docId?: string;
  rawdocId?: string;
}

export interface SavedKnowledgeItemListResponse {
  items: SavedKnowledgeItemListEntry[];
}

export interface SearchResultItem {
  chunkId: string;
  docId: string;
  rawdocId: string;
  sectionIds: string[];
  title: string;
  pageTitle?: string;
  contentTitle?: string;
  displayTitle?: string;
  sourceUrl?: string;
  normalizedUrl?: string;
  headingPath?: string;
  snippet: string;
  score: number;
  parserVersion?: string;
  parserMethod?: string;
  parserProfile?: string;
  trace?: SearchTrace;
}

export interface SearchTrace {
  queryTerms: string[];
  matchedTerms: string[];
  termCoverage: number;
  bm25Score: number;
  rankingScore: number;
  titleMatches: number;
  headingMatches: number;
  phraseMatched: boolean;
}

export interface SearchResponse {
  query: string;
  retriever: "sqlite_fts";
  results: SearchResultItem[];
}

export interface ContextCitation {
  citationId: string;
  marker: string;
  rank: number;
  chunkId: string;
  docId: string;
  rawdocId: string;
  sectionIds: string[];
  title: string;
  pageTitle?: string;
  contentTitle?: string;
  displayTitle?: string;
  sourceUrl?: string;
  normalizedUrl?: string;
  headingPath?: string;
  content: string;
  score: number;
  parserVersion?: string;
  parserMethod?: string;
  parserProfile?: string;
  truncated: boolean;
  trace?: SearchTrace;
}

export interface ContextPackResponse {
  query: string;
  retriever: "sqlite_fts";
  packer: "section_chunk_v1";
  budget: {
    maxChars: number;
    usedChars: number;
  };
  contextText: string;
  citations: ContextCitation[];
}

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

export function makeId(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function sectionDeterministicText(section: DocumentSection): string {
  switch (section.type) {
    case "heading":
      return `heading:${section.level ?? 0}:${section.content ?? ""}`;
    case "paragraph":
    case "blockquote":
    case "code":
      return `${section.type}:${section.content ?? ""}`;
    case "list": {
      const items = (section.items ?? [])
        .map((item) => typeof item === "string" ? item : item.text)
        .join("|");
      return `list:${items}`;
    }
    case "table": {
      const rows = (section.rows ?? [])
        .map((row) => Array.isArray(row) ? row.map(String).join("|") : String(row))
        .join("\n");
      return `table:${rows}`;
    }
    case "figure": {
      const assets = (section.assets ?? [])
        .map((a) => (a.alt ?? "") + ":" + (a.caption ?? ""))
        .join("|");
      return `figure:${section.content ?? ""}:${assets}`;
    }
    default:
      return `${section.type}:`;
  }
}

export function deterministicSectionId(section: DocumentSection): string {
  const text = sectionDeterministicText(section);
  return "s-" + createHash("sha256").update(text).digest("hex").slice(0, 10);
}

export function assignDeterministicSectionIds(sections: DocumentSection[]): void {
  const seen = new Set<string>();
  for (const section of sections) {
    if (section.section_id && !section.section_id.includes("s-")) {
      continue;
    }
    const base = deterministicSectionId(section);
    let candidate = base;
    let counter = 1;
    while (seen.has(candidate)) {
      candidate = base + "-" + counter;
      counter++;
    }
    seen.add(candidate);
    section.section_id = candidate;
  }
}

export function normalizeUrlForKnowledge(input: string): string {
  if (input.startsWith("file://")) {
    return input;
  }

  const url = new URL(input);
  url.hash = "";

  for (const key of [...url.searchParams.keys()]) {
    if (
      key.startsWith("utm_") ||
      key === "fbclid" ||
      key === "gclid" ||
      key === "igshid"
    ) {
      url.searchParams.delete(key);
    }
  }

  url.searchParams.sort();
  return url.toString();
}

export function urlHash(input: string): string {
  return createHash("sha256").update(normalizeUrlForKnowledge(input)).digest("hex").slice(0, 16);
}

export function isFileUrl(input: string): boolean {
  return input.startsWith("file://");
}

export function slugifyTitle(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[^\w\s.-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
  return slug || "untitled";
}

export function assertKnowledgeCaptureInput(value: unknown): KnowledgeCaptureInput {
  return KnowledgeCaptureInputSchema.parse(value);
}

// ---- Annotation types ----

export type AnnotationType = "highlight" | "note" | "summary" | "tag" | "bookmark";

export interface AnnotationBase {
  annotation_id: string;
  doc_id: string;
  section_id: string;
  created_at: string;
  updated_at: string;
  orphaned?: boolean;
  orphaned_at?: string;
}

export interface HighlightAnnotation extends AnnotationBase {
  type: "highlight";
  text_ref: string;
  note?: string;
  color?: string;
}

export interface NoteAnnotation extends AnnotationBase {
  type: "note";
  note: string;
  text_ref?: string;
}

export interface SummaryAnnotation extends AnnotationBase {
  type: "summary";
  note: string;
  ai_model: string;
}

export interface TagAnnotation extends AnnotationBase {
  type: "tag";
  label: string;
}

export interface BookmarkAnnotation extends AnnotationBase {
  type: "bookmark";
  label?: string;
}

export type Annotation =
  | HighlightAnnotation
  | NoteAnnotation
  | SummaryAnnotation
  | TagAnnotation
  | BookmarkAnnotation;

export interface AnnotationFile {
  doc_id: string;
  version: number;
  updated_at: string;
  annotations: Annotation[];
}

export interface AnnotationReparseWarning {
  orphanedCount: number;
  orphanedAnnotations: Array<{
    annotation_id: string;
    type: AnnotationType;
    section_id: string;
    text_ref?: string | null;
    label?: string;
  }>;
}

// ---- Annotation Zod schemas ----

export const AnnotationBaseSchema = z.object({
  annotation_id: z.string(),
  doc_id: z.string(),
  section_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  orphaned: z.boolean().optional(),
  orphaned_at: z.string().optional(),
});

export const HighlightAnnotationSchema = AnnotationBaseSchema.extend({
  type: z.literal("highlight"),
  text_ref: z.string(),
  note: z.string().optional(),
  color: z.string().optional(),
});

export const NoteAnnotationSchema = AnnotationBaseSchema.extend({
  type: z.literal("note"),
  note: z.string(),
  text_ref: z.string().optional(),
});

export const SummaryAnnotationSchema = AnnotationBaseSchema.extend({
  type: z.literal("summary"),
  note: z.string(),
  ai_model: z.string(),
});

export const TagAnnotationSchema = AnnotationBaseSchema.extend({
  type: z.literal("tag"),
  label: z.string(),
});

export const BookmarkAnnotationSchema = AnnotationBaseSchema.extend({
  type: z.literal("bookmark"),
  label: z.string().optional(),
});

export const AnnotationSchema = z.discriminatedUnion("type", [
  HighlightAnnotationSchema,
  NoteAnnotationSchema,
  SummaryAnnotationSchema,
  TagAnnotationSchema,
  BookmarkAnnotationSchema,
]);

export const AnnotationFileSchema = z.object({
  doc_id: z.string(),
  version: z.number(),
  updated_at: z.string(),
  annotations: z.array(AnnotationSchema),
});

// ---- AI Annotation types ----

export type AIAnnotationType = "summary" | "tag" | "note" | "highlight";

export const AIAnnotationTypeSchema = z.enum(["summary", "tag", "note", "highlight"]);

export interface AIAnnotationGenerateRequest {
  types?: AIAnnotationType[];
  section_ids?: string[];
  force?: boolean;
}

export const AIAnnotationGenerateRequestSchema = z.object({
  types: z.array(AIAnnotationTypeSchema).optional().default(["summary"]),
  section_ids: z.array(z.string()).optional(),
  force: z.boolean().optional().default(false),
});

export interface SummaryResultItem {
  type: "summary";
  annotation_id: string;
  section_id: string;
  heading_text: string;
  heading_level: number;
  content: string;
  ai_model: string;
  hit_cache: boolean;
  strategy: "single" | "two-pass";
}

export interface TagResultItem {
  type: "tag";
  annotation_ids: string[];
  section_id: string;
  heading_text?: string;
  labels: string[];
  hit_cache: boolean;
  strategy: "single" | "two-pass";
}

export interface NoteResultItem {
  type: "note";
  annotation_id: string;
  section_id: string;
  heading_text?: string;
  content: string;
  hit_cache: boolean;
  strategy: "single" | "two-pass";
}

export interface HighlightResultItem {
  type: "highlight";
  annotation_ids: string[];
  section_id: string;
  heading_text?: string;
  text_refs: string[];
  validated: number;
  hit_cache: boolean;
  strategy: "single" | "two-pass";
}

export type AIAnnotationResultItem =
  | SummaryResultItem
  | TagResultItem
  | NoteResultItem
  | HighlightResultItem;

export interface AIAnnotationGenerateResult {
  doc_id: string;
  generated: number;
  skipped: number;
  results: AIAnnotationResultItem[];
}

export interface AIConfig {
  enabled: boolean;
  provider: string;
  model: string;
}
