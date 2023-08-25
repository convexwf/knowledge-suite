export type InputMode = "browser_html" | "server_fetch";
export type PanelView = "preview" | "json" | "rawdoc" | "parser" | "saved";
export type ClipState = "empty" | "captured" | "parsed";
export type ClipDeleteMode = "remove" | "purge";

export interface PageSnapshot {
  pageUrl: string;
  canonicalUrl?: string;
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
  status: ClipStatusResult;
}

export interface RawDoc {
  rawdoc_id: string;
  source_type: string;
  source_uri: string;
  fetch_time: string;
  content_type?: string;
  content_length?: number;
  metadata?: {
    inputMode?: InputMode;
    normalizedUrl?: string;
    title?: string;
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
    source?: Record<string, unknown>;
    authors?: string[];
    published_at?: string | null;
    ingested_at?: string;
    language?: string;
    tags?: string[];
    parser_version?: string;
  };
  sections: Array<{
    type: string;
    content?: string;
    items?: unknown[];
    [key: string]: unknown;
  }>;
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
  };
}
