// ── Core domain models ────────────────────────────────────────────────────

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
