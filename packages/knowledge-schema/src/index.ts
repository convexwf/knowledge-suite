import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const InputModeSchema = z.enum(["browser_html", "server_fetch"]);
export type InputMode = z.infer<typeof InputModeSchema>;

export const PageSnapshotSchema = z.object({
  pageUrl: z.string().min(1),
  canonicalUrl: z.string().optional(),
  title: z.string().optional(),
  html: z.string().min(1),
  text: z.string().optional(),
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

export const ClipInputSchema = z.discriminatedUnion("inputMode", [
  BrowserHtmlInputSchema,
  ServerFetchInputSchema
]);
export type ClipInput = z.infer<typeof ClipInputSchema>;

export const ClipPreviewRequestSchema = ClipInputSchema;
export type ClipPreviewRequest = z.infer<typeof ClipPreviewRequestSchema>;

export const ClipSaveRequestSchema = ClipInputSchema.and(
  z.object({
    overwrite: z.boolean().optional()
  })
);
export type ClipSaveRequest = z.infer<typeof ClipSaveRequestSchema>;

export interface RawDoc {
  rawdoc_id: string;
  source_type: "url" | "singlefile_html" | "pdf" | "epub";
  source_uri: string;
  fetch_time: string;
  storage_path: string;
  content_type?: string;
  content_length?: number;
  metadata?: Record<string, unknown>;
}

export type DocumentSectionType =
  | "heading"
  | "paragraph"
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
    caption?: string | null;
  }>;
  annotations?: Record<string, unknown>;
}

export interface KnowledgeDocument {
  doc_id: string;
  meta: {
    title: string;
    source: {
      type: "html" | "pdf" | "epub";
      path: string;
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
  };
  references?: Array<{
    ref_id: string;
    label?: string;
    text: string;
    blocks?: string[];
  }>;
  sections: DocumentSection[];
}

export interface ClipStatus {
  normalizedUrl: string;
  urlHash: string;
  saved: boolean;
  savedAt?: string;
  title?: string;
  docId?: string;
  markdownPath?: string;
  documentPath?: string;
}

export interface ClipPreviewResponse {
  rawdoc: RawDoc;
  document: KnowledgeDocument;
  markdown: string;
  status: ClipStatus;
}

export interface ClipSaveResponse extends ClipPreviewResponse {
  saved: true;
  paths: {
    rawHtmlPath: string;
    rawdocPath: string;
    documentPath: string;
    markdownPath: string;
  };
}

export interface ClipStatusResponse extends ClipStatus {}

export interface ClipDeleteResponse extends ClipStatus {
  deleted: boolean;
  deletedPaths: string[];
}

export interface ClipListItem {
  normalizedUrl: string;
  urlHash: string;
  savedAt: string;
  title?: string;
  docId?: string;
  markdownPath?: string;
  documentPath?: string;
}

export interface ClipListResponse {
  clips: ClipListItem[];
}

export function makeId(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
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

export function assertClipInput(value: unknown): ClipInput {
  return ClipInputSchema.parse(value);
}
