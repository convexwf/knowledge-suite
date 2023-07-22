import DefuddleDefault, { type DefuddleOptions, type DefuddleResponse } from "defuddle";
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
const DefuddleClass = DefuddleDefault as unknown as {
  new (doc: Document, options?: DefuddleOptions): { parse(): DefuddleResponse };
};

export async function parsePage(input: ResolvedInput): Promise<ParsedPage> {
  const rawdocId = makeId();
  const docId = makeId();
  const fetchTime = nowIso();
  const { document } = parseHTML(input.html);
  const defuddleResult = runDefuddle(document, input);
  const title = input.title || defuddleResult?.title || readTitle(document) || input.normalizedUrl;
  const contentHtml = defuddleResult?.content;
  const contentDocument = contentHtml ? parseHTML(contentHtml).document : document;
  const bodyRoot = contentHtml ? contentDocument.body || contentDocument.documentElement : pickReadableRoot(document);
  const sections = extractSections(bodyRoot, title);
  const parserMethod = defuddleResult && isUsefulExtraction(defuddleResult)
    ? "defuddle"
    : "dom_fallback";

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
      parserMethod,
      defuddle: defuddleResult
        ? {
            author: defuddleResult.author,
            domain: defuddleResult.domain,
            extractorType: defuddleResult.extractorType,
            image: defuddleResult.image,
            language: defuddleResult.language,
            site: defuddleResult.site,
            wordCount: defuddleResult.wordCount
          }
        : undefined,
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
      authors: readAuthors(document, input.meta, defuddleResult),
      published_at: readPublishedAt(document, input.meta, defuddleResult),
      ingested_at: fetchTime,
      language: defuddleResult?.language || document.documentElement?.getAttribute("lang") || input.meta.language,
      tags: [],
      parser_version: `${PARSER_VERSION}:${parserMethod}`
    },
    sections: sections.length > 0 ? sections : [{ type: "paragraph", content: document.body?.textContent?.trim() ?? "" }]
  };

  return { rawdoc, document: knowledgeDocument };
}

function runDefuddle(document: Document, input: ResolvedInput): DefuddleResponse | undefined {
  try {
    const root = document.documentElement || document;
    const defuddle = new DefuddleClass(root as unknown as Document, {
      url: input.url,
      language: input.meta.language,
      useAsync: false
    });
    const result = defuddle.parse();
    return isUsefulExtraction(result) ? result : undefined;
  } catch {
    return undefined;
  }
}

function isUsefulExtraction(result: DefuddleResponse): boolean {
  return normalizeText(result.content).length >= 80 || (result.wordCount ?? 0) >= 20;
}

function readTitle(document: Document): string | undefined {
  const title = document.querySelector("title")?.textContent?.trim();
  const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim();
  return ogTitle || title || undefined;
}

function readAuthors(document: Document, meta: Record<string, string>, defuddleResult?: DefuddleResponse): string[] {
  const author =
    defuddleResult?.author ||
    meta.author ||
    document.querySelector('meta[name="author"]')?.getAttribute("content")?.trim() ||
    document.querySelector('[rel="author"]')?.textContent?.trim();
  return author ? [author] : [];
}

function readPublishedAt(document: Document, meta: Record<string, string>, defuddleResult?: DefuddleResponse): string | null {
  const value =
    defuddleResult?.published ||
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
