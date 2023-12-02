import { z } from "zod";

// ── Annotation types ───────────────────────────────────────────────────────

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

// ── Annotation Zod schemas ─────────────────────────────────────────────────

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
