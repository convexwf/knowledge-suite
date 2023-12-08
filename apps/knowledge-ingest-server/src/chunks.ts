import { createHash, randomUUID } from "node:crypto";
import { KnowledgeDocument, type DocumentSection } from "@uknowledge/knowledge-schema";

export interface BuiltChunk {
  chunkId: string;
  chunkIndex: number;
  headingPath: string | null;
  sectionIds: string[];
  text: string;
  charCount: number;
  tokenEstimate: number;
  contentHash: string;
}

const TARGET_CHUNK_CHARS = 1400;
const MIN_CHUNK_CHARS = 500;

export function buildChunks(document: KnowledgeDocument): BuiltChunk[] {
  const chunks: BuiltChunk[] = [];
  const headingStack: string[] = [];
  let pendingParts: string[] = [];
  let pendingSectionIds: string[] = [];
  let pendingHeadingPath: string | null = null;

  const flushPending = () => {
    const text = normalizeText(pendingParts.join("\n\n"));
    if (!text) {
      pendingParts = [];
      pendingSectionIds = [];
      pendingHeadingPath = null;
      return;
    }

    const chunkIndex = chunks.length;
    const contentHash = sha256(text);
    chunks.push({
      chunkId: randomUUID(),
      chunkIndex,
      headingPath: pendingHeadingPath,
      sectionIds: [...pendingSectionIds],
      text,
      charCount: text.length,
      tokenEstimate: estimateTokens(text),
      contentHash
    });

    pendingParts = [];
    pendingSectionIds = [];
    pendingHeadingPath = null;
  };

  for (const section of document.sections) {
    if (section.type === "heading") {
      flushPending();
      updateHeadingStack(headingStack, section);
      continue;
    }

    const body = sectionToText(section);
    if (!body) {
      continue;
    }

    const headingPath = headingStack.length > 0 ? headingStack.join(" > ") : null;
    const contextualText = buildContextualText(document, headingPath, body);
    if (!contextualText) {
      continue;
    }

    if (pendingParts.length === 0) {
      pendingHeadingPath = headingPath;
    }

    pendingParts.push(contextualText);
    if (section.section_id) {
      pendingSectionIds.push(section.section_id);
    }

    const pendingText = normalizeText(pendingParts.join("\n\n"));
    if (pendingText.length >= TARGET_CHUNK_CHARS) {
      flushPending();
      continue;
    }

    if (
      pendingHeadingPath &&
      headingPath &&
      headingPath !== pendingHeadingPath &&
      pendingText.length >= MIN_CHUNK_CHARS
    ) {
      flushPending();
    }
  }

  flushPending();
  return chunks;
}

function buildContextualText(document: KnowledgeDocument, headingPath: string | null, body: string): string {
  const parts = [
    `Title: ${document.meta.title}`,
    document.meta.source.url ? `Source: ${hostFromUrl(document.meta.source.url)}` : "",
    headingPath ? `Section: ${headingPath}` : "",
    body
  ].filter(Boolean);

  return normalizeText(parts.join("\n"));
}

function updateHeadingStack(stack: string[], section: DocumentSection): void {
  const heading = normalizeText(section.content ?? "");
  if (!heading) {
    return;
  }

  const level = Math.max(1, Math.min(section.level ?? 1, 6));
  stack.length = level - 1;
  stack[level - 1] = heading;
}

export function sectionToText(section: DocumentSection): string {
  switch (section.type) {
    case "paragraph":
    case "blockquote":
    case "code":
      return normalizeText(section.content ?? "");
    case "list":
      return normalizeText(
        (section.items ?? [])
          .map((item) => typeof item === "string" ? item : [item.text, ...(item.items ?? [])].join(" "))
          .join("\n")
      );
    case "table":
      return normalizeText(
        (section.rows ?? [])
          .map((row) => Array.isArray(row) ? row.map((cell) => String(cell)).join(" | ") : String(row))
          .join("\n")
      );
    case "figure":
      return normalizeText(
        [
          section.content ?? "",
          ...(section.assets ?? []).flatMap((asset) => [asset.alt ?? "", asset.caption ?? ""])
        ].join("\n")
      );
    default:
      return "";
  }
}

function hostFromUrl(input: string): string {
  try {
    return new URL(input).host;
  } catch {
    return input;
  }
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function normalizeText(value: string): string {
  return sanitizeText(value)
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Remove or replace invisible/control/formatting characters that
 * JavaScript \s does not cover, including LS/PS/ZWS/Bidi controls.
 *
 * @see doc-rules/doc/architecture/knowledge-suite/parser/knowledge-text-sanitization.md
 */
function sanitizeText(value: string): string {
  return value
    // Line/Paragraph separators → space (U+2028/U+2029 not matched by \s)
    .replace(/[\u2028\u2029]/g, " ")
    // Zero-width characters → remove (ZWSP/ZWNJ/ZWJ/Word Joiner/BOM)
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    // Narrow no-break space → space
    .replace(/\u202F/g, " ")
    // Ideographic space (full-width) → space
    .replace(/\u3000/g, " ")
    // Soft hyphen → remove
    .replace(/\u00AD/g, "")
    // Bidi control characters → remove (safety-critical)
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "");
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
