import { parseHTML } from "linkedom";
import {
  KnowledgeDocument,
  makeId,
  nowIso,
  RawDoc
} from "@uknowledge/knowledge-schema";
import { ResolvedInput } from "./input.js";

export interface ParsedPage {
  rawdoc: RawDoc;
  document: KnowledgeDocument;
}

const PARSER_VERSION = "knowledge-ingest-server/0.1";

export async function parsePage(input: ResolvedInput): Promise<ParsedPage> {
  const rawdocId = makeId();
  const docId = makeId();
  const fetchTime = nowIso();
  const { document } = parseHTML(input.html);
  const title = input.title || readTitle(document) || input.normalizedUrl;
  const bodyRoot = pickReadableRoot(document);
  const sections = extractSections(bodyRoot, title);

  const rawdoc: RawDoc = {
    rawdoc_id: rawdocId,
    source_type: input.inputMode === "browser_html" && input.url.startsWith("file://") ? "singlefile_html" : "url",
    source_uri: input.url,
    fetch_time: fetchTime,
    storage_path: `rawdocs/${rawdocId}.html`,
    content_type: "text/html",
    content_length: Buffer.byteLength(input.html),
    metadata: {
      inputMode: input.inputMode,
      normalizedUrl: input.normalizedUrl,
      title,
      meta: input.meta
    }
  };

  const knowledgeDocument: KnowledgeDocument = {
    doc_id: docId,
    meta: {
      title,
      source: {
        type: "html",
        path: rawdoc.storage_path,
        url: input.url,
        rawdoc_id: rawdocId
      },
      authors: readAuthors(document, input.meta),
      published_at: readPublishedAt(document, input.meta),
      ingested_at: fetchTime,
      language: document.documentElement?.getAttribute("lang") || input.meta.language,
      tags: [],
      parser_version: PARSER_VERSION
    },
    sections: sections.length > 0 ? sections : [{ type: "paragraph", content: document.body?.textContent?.trim() ?? "" }]
  };

  return { rawdoc, document: knowledgeDocument };
}

function readTitle(document: Document): string | undefined {
  const title = document.querySelector("title")?.textContent?.trim();
  const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim();
  return ogTitle || title || undefined;
}

function readAuthors(document: Document, meta: Record<string, string>): string[] {
  const author =
    meta.author ||
    document.querySelector('meta[name="author"]')?.getAttribute("content")?.trim() ||
    document.querySelector('[rel="author"]')?.textContent?.trim();
  return author ? [author] : [];
}

function readPublishedAt(document: Document, meta: Record<string, string>): string | null {
  const value =
    meta["article:published_time"] ||
    meta.published ||
    document.querySelector('meta[property="article:published_time"]')?.getAttribute("content") ||
    document.querySelector("time[datetime]")?.getAttribute("datetime");

  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function pickReadableRoot(document: Document): Element {
  return (
    document.querySelector("article") ||
    document.querySelector("main") ||
    document.querySelector('[role="main"]') ||
    document.body ||
    document.documentElement
  );
}

function extractSections(root: Element, title: string): KnowledgeDocument["sections"] {
  const sections: KnowledgeDocument["sections"] = [];
  const nodes = root.querySelectorAll("h1,h2,h3,h4,h5,h6,p,pre,blockquote,ul,ol,figure,table");

  for (const node of nodes) {
    const tagName = node.tagName.toLowerCase();
    const text = normalizeText(node.textContent ?? "");
    if (!text || text === title) {
      continue;
    }

    if (/^h[1-6]$/.test(tagName)) {
      sections.push({
        section_id: makeId(),
        type: "heading",
        level: Number(tagName.slice(1)),
        content: text
      });
      continue;
    }

    if (tagName === "ul" || tagName === "ol") {
      const items = [...node.querySelectorAll(":scope > li")]
        .map((li) => normalizeText(li.textContent ?? ""))
        .filter(Boolean);
      if (items.length > 0) {
        sections.push({ section_id: makeId(), type: "list", items });
      }
      continue;
    }

    if (tagName === "pre") {
      sections.push({ section_id: makeId(), type: "code", content: node.textContent ?? "" });
      continue;
    }

    sections.push({
      section_id: makeId(),
      type: tagName === "figure" ? "figure" : tagName === "table" ? "table" : "paragraph",
      content: text
    });
  }

  return dedupeAdjacent(sections);
}

function dedupeAdjacent(sections: KnowledgeDocument["sections"]): KnowledgeDocument["sections"] {
  const result: KnowledgeDocument["sections"] = [];
  for (const section of sections) {
    const previous = result[result.length - 1];
    if (
      previous &&
      previous.type === section.type &&
      previous.content &&
      section.content &&
      previous.content === section.content
    ) {
      continue;
    }
    result.push(section);
  }
  return result;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
