import type { KnowledgeItemDeleteMode, KnowledgeItemStatus } from "./api.js";

// ── Store maintenance ─────────────────────────────────────────────────────

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

// ── Saved items ────────────────────────────────────────────────────────────

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

// ── Search ─────────────────────────────────────────────────────────────────

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

// ── Context pack ───────────────────────────────────────────────────────────

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
