import type { DocumentSection } from "@uknowledge/knowledge-schema";
import { serializeSection } from "./serialize.js";

const CHUNK_SIZE = 6000;
const CHUNK_OVERLAP = 500;
const TWO_PASS_THRESHOLD = 8000;

export function buildScopeText(
  sections: DocumentSection[],
  headingIndex: number
): string {
  const heading = sections[headingIndex];
  const targetLevel = heading.level ?? 0;
  const parts: string[] = [serializeSection(heading)];

  for (let i = headingIndex + 1; i < sections.length; i++) {
    const s = sections[i];
    if (s.type === "heading" && (s.level ?? 0) <= targetLevel) break;
    const serialized = serializeSection(s);
    if (serialized) parts.push(serialized);
  }

  return parts.join("\n\n");
}

export function buildSingleSectionText(section: DocumentSection): string {
  return serializeSection(section);
}

export function needsTwoPass(scopeText: string): boolean {
  return scopeText.length > TWO_PASS_THRESHOLD;
}

export function splitIntoChunks(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    chunks.push(text.slice(start, end));
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return chunks;
}
