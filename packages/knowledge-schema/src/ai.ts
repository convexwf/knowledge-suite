import { z } from "zod";

// ── AI Annotation types ────────────────────────────────────────────────────

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

// ── Result items ───────────────────────────────────────────────────────────

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

// ── Config ─────────────────────────────────────────────────────────────────

export interface AIConfig {
  enabled: boolean;
  provider: string;
  model: string;
}
