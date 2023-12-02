import { createHash, randomUUID } from "node:crypto";
import { KnowledgeCaptureInputSchema } from "./api.js";
import type { KnowledgeCaptureInput } from "./api.js";
import type { DocumentSection } from "./document.js";

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
