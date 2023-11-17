export type InputMode = "browser_html" | "server_fetch";
export type PanelView = "preview" | "json" | "rawdoc" | "parser" | "saved" | "batch";
export type ClipState = "empty" | "captured" | "parsed";
export type ClipDeleteMode = "remove" | "purge";
export type KnowledgeSourceType = "url" | "singlefile_html" | "pdf" | "epub";
export type KnowledgeItemDeleteMode = "remove" | "purge";
export const STORE_CLEAR_CONFIRMATION = "CLEAR KNOWLEDGE STORE";
export const STORE_CLEAR_PARSED_CONFIRMATION = "CLEAR PARSED RESULTS";

export interface PageSnapshot {
  pageUrl: string;
  canonicalUrl?: string;
  pageTitle?: string;
  title?: string;
  html: string;
  text?: string;
  diagnostics?: {
    htmlLength: number;
    textLength: number;
    shadowRootCount: number;
  };
  capturedAt: string;
  meta: Record<string, string>;
  selectionHtml?: string;
}

export interface ExtensionSettings {
  serverUrl: string;
  token: string;
  defaultInputMode: InputMode;
  allowServerFetch: boolean;
  autoRefresh: boolean;
  healthCheckOnOpen: boolean;
  requestTimeoutMs: number;
  showParserDiagnostics: boolean;
  savedListLimit: number;
  defaultPanelTab: PanelView;
}

export type ClipRequestBody =
  | { inputMode: "browser_html"; snapshot: PageSnapshot }
  | { inputMode: "server_fetch"; url: string };

export type ClipSaveRequestBody = ClipRequestBody & {
  candidateId?: string;
};

export interface ActiveTabInfo {
  tabId: number;
  url: string;
  title?: string;
  isFileUrl: boolean;
}

export interface PreviewResult {
  rawdoc: RawDoc;
  markdown: string;
  document: KnowledgeDocument;
  candidatePreviews?: CandidatePreview[];
  selectedCandidateId?: string;
  serverSelectedCandidateId?: string;
  activeCandidateId?: string;
  status: ClipStatusResult;
}

export interface CandidatePreview {
  id: string;
  method: string;
  adapterId?: string;
  selector?: string;
  selected: boolean;
  serverSelected?: boolean;
  score: number;
  metrics: Record<string, unknown>;
  warnings: string[];
  reason: string;
  markdown: string;
  document: KnowledgeDocument;
}

export interface RawDoc {
  rawdoc_id: string;
  source_type: KnowledgeSourceType;
  source_uri: string;
  fetch_time: string;
  content_type?: string;
  content_length?: number;
  metadata?: {
    inputMode?: InputMode;
    normalizedUrl?: string;
    title?: string;
    pageTitle?: string;
    contentTitle?: string;
    displayTitle?: string;
    parserMethod?: string;
    parserProfile?: string;
    parserWarnings?: string[];
    matchedAdapters?: Array<Record<string, unknown>>;
    parserCandidates?: Array<Record<string, unknown>>;
    defuddle?: Record<string, unknown>;
    meta?: Record<string, string>;
    [key: string]: unknown;
  };
}

export interface KnowledgeDocument {
  doc_id: string;
  meta: {
    title: string;
    page_title?: string;
    source?: {
      type?: "html" | "pdf" | "epub";
      url?: string | null;
      rawdoc_id?: string;
      [key: string]: unknown;
    };
    authors?: string[];
    published_at?: string | null;
    updated_at?: string | null;
    ingested_at?: string;
    language?: string;
    tags?: string[];
    parser_version?: string;
  };
  sections: Array<{
    type: string;
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
    [key: string]: unknown;
  }>;
}

export interface KnowledgeItem {
  itemId: string;
  sourceType: KnowledgeSourceType;
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

export interface KnowledgeItemListResult {
  items: KnowledgeItem[];
}

export interface KnowledgeItemDetailResult {
  item: KnowledgeItem;
  rawdoc?: RawDoc;
  document?: KnowledgeDocument;
  collectionIds?: string[];
}

export interface KnowledgeItemDeleteResult {
  itemId: string;
  deleted: boolean;
  mode: KnowledgeItemDeleteMode;
  previousState: "captured" | "parsed";
  currentState: "empty" | "captured";
  deletedFiles: string[];
  removedDocId?: string;
  removedRawdocId?: string;
}

export interface EpubImportResult {
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

export interface ClipListItem {
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

export interface ClipListResult {
  clips: ClipListItem[];
}

export interface ClipDeleteResult extends ClipStatusResult {
  deleted: boolean;
  mode: ClipDeleteMode;
  previousState: "captured" | "parsed";
  currentState: "empty" | "captured";
  removedDocId?: string;
  removedRawdocId?: string;
  deletedFiles?: string[];
}

export interface CheckCollectionNameResult {
  exists: boolean;
}

export interface CollectionSummary {
  collectionId: string;
  title: string;
  rootUrl?: string;
  normalizedRootUrl?: string;
  sourceType: string;
  state: string;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CollectionDetail {
  collection: CollectionSummary;
  items: Array<{
    collectionItemId: string;
    itemId?: string;
    normalizedUrl: string;
    docId?: string;
    rawdocId?: string;
    title?: string;
    pageTitle?: string;
    orderIndex: number;
    source?: string;
    state: string;
    creators?: string[];
    language?: string;
    updatedAt: string;
  }>;
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
    knowledgeItems?: number;
    clips: number;
    epubMetadata?: number;
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
  parsedResults?: {
    parsedItems?: number;
    parsedClips: number;
    documentRows: number;
    chunkRows: number;
    collectionItemRefs: number;
    batchItemRefs: number;
    derivedFiles: number;
  };
}

export interface StoreClearResult {
  cleared: true;
  mode: "all";
  before: StoreMaintenanceScan;
  after: StoreMaintenanceScan;
}

export interface StoreClearParsedResult {
  cleared: true;
  mode: "parsed";
  before: StoreMaintenanceScan;
  after: StoreMaintenanceScan;
}

// ---- Annotation types ----

export type AnnotationType = "highlight" | "note" | "summary" | "tag" | "bookmark";

export interface HighlightAnnotation {
  type: "highlight";
  annotation_id: string;
  doc_id: string;
  section_id: string;
  text_ref: string;
  note?: string;
  color?: string;
  created_at: string;
  updated_at: string;
  orphaned?: boolean;
  orphaned_at?: string;
}

export interface NoteAnnotation {
  type: "note";
  annotation_id: string;
  doc_id: string;
  section_id: string;
  note: string;
  text_ref?: string;
  created_at: string;
  updated_at: string;
  orphaned?: boolean;
  orphaned_at?: string;
}

export interface SummaryAnnotation {
  type: "summary";
  annotation_id: string;
  doc_id: string;
  section_id: string;
  note: string;
  ai_model: string;
  created_at: string;
  updated_at: string;
  orphaned?: boolean;
  orphaned_at?: string;
}

export interface TagAnnotation {
  type: "tag";
  annotation_id: string;
  doc_id: string;
  section_id: string;
  label: string;
  created_at: string;
  updated_at: string;
  orphaned?: boolean;
  orphaned_at?: string;
}

export interface BookmarkAnnotation {
  type: "bookmark";
  annotation_id: string;
  doc_id: string;
  section_id: string;
  label?: string;
  created_at: string;
  updated_at: string;
  orphaned?: boolean;
  orphaned_at?: string;
}

export type Annotation =
  | HighlightAnnotation
  | NoteAnnotation
  | SummaryAnnotation
  | TagAnnotation
  | BookmarkAnnotation;

export interface AnnotationListResult {
  doc_id: string | null;
  annotations: Annotation[];
}

export interface AnnotationSaveResult {
  saved: boolean;
  annotation_id: string;
}

export interface AnnotationDeleteResult {
  deleted: boolean;
  annotation_id: string;
}

export interface AnnotationDeleteAllResult {
  deleted: boolean;
  doc_id: string;
  count: number;
}

export interface AnnotationDocSummary {
  doc_id: string;
  title: string | null;
  count: number;
  types: Record<string, number>;
}

export interface AnnotationDocListResult {
  docs: AnnotationDocSummary[];
}

export interface TaskState {
  task_id: string;
  doc_id: string;
  status: "running" | "paused" | "cancelled" | "done";
  total: number;
  skipped: number;
  completed: number;
  failed: number;
  pending_section_ids: string[];
  completed_section_ids: string[];
  failed_section_ids: string[];
  current_section_id: string | null;
  current_heading_text: string | null;
  replaced?: string;
}

export interface AIAnnotationGenerateRequest {
  types?: string[];
  section_ids?: string[];
  force?: boolean;
}

export interface AIAnnotationResultItem {
  type: string;
  annotation_id?: string;
  annotation_ids?: string[];
  section_id: string;
  heading_text?: string;
  heading_level?: number;
  content?: string;
  labels?: string[];
  text_refs?: string[];
  validated?: number;
  ai_model?: string;
  hit_cache: boolean;
  strategy: string;
}

export interface AIAnnotationGenerateResult {
  doc_id: string;
  generated: number;
  skipped: number;
  results: AIAnnotationResultItem[];
}

export interface ClipStatusResult {
  normalizedUrl: string;
  urlHash: string;
  state: ClipState;
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

export interface HealthResult {
  ok: boolean;
  service: string;
  version: string;
  storeRoot: string;
  store: {
    type: string;
    indexPath: string;
  };
  limits: {
    fetchTimeoutMs: number;
    maxHtmlBytes: number;
    maxImportBytes?: number;
  };
}

export interface BatchCandidate {
  url: string;
  text?: string;
  titleHint?: string;
  source?: string;
  order?: number;
  depth?: number;
}

export interface BatchDiscoverItem {
  url: string;
  normalizedUrl: string;
  titleHint?: string;
  source?: string;
  order: number;
  depth: number;
  selectedByDefault: boolean;
  status: ClipState;
  docId?: string;
  rawdocId?: string;
}

export interface CollectionItem {
  collectionItemId: string;
  collectionId: string;
  normalizedUrl: string;
  docId?: string;
  rawdocId?: string;
  title?: string;
  pageTitle?: string;
  contentTitle?: string;
  displayTitle?: string;
}

export interface BatchDiscoverResult {
  pageUrl: string;
  items: BatchDiscoverItem[];
  stats: {
    inputCount: number;
    dedupedCount: number;
    selectedCount: number;
  };
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

export interface BatchJobResult {
  collectionId?: string;
  jobId: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  total: number;
  saved: number;
  skipped: number;
  failed: number;
  cancelled: number;
  items: BatchJobItem[];
}
