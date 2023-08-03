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
  cleanDocumentForExtraction(document);
  const defuddleResult = runDefuddle(document, input);
  const title = input.title || defuddleResult?.title || readTitle(document) || input.normalizedUrl;
  const fallbackSections = extractSections(pickReadableRoot(document), title);
  const defuddleSections = defuddleResult ? extractDefuddleSections(defuddleResult.content, title) : [];
  const useDefuddleSections = shouldUseDefuddleSections(defuddleResult, defuddleSections, fallbackSections);
  const sections = useDefuddleSections ? defuddleSections : fallbackSections;
  const parserMethod = useDefuddleSections ? "defuddle" : "dom_fallback";

  const rawdoc: RawDoc = {
    rawdoc_id: rawdocId,
    source_type: input.inputMode === "browser_html" && input.url.startsWith("file://") ? "singlefile_html" : "url",
    source_uri: input.url,
    fetch_time: fetchTime,
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
    const defuddle = new DefuddleClass(document, {
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

function extractDefuddleSections(contentHtml: string, title: string): KnowledgeDocument["sections"] {
  const contentDocument = parseHTML(contentHtml).document;
  cleanDocumentForExtraction(contentDocument);
  const bodyRoot = pickParsedContentRoot(contentDocument);
  return bodyRoot ? extractSections(bodyRoot, title) : [];
}

function pickParsedContentRoot(document: Document): Element | undefined {
  if (document.body && normalizeText(document.body.textContent ?? "")) {
    return document.body;
  }
  return document.documentElement || document.body || undefined;
}

function shouldUseDefuddleSections(
  defuddleResult: DefuddleResponse | undefined,
  defuddleSections: KnowledgeDocument["sections"],
  fallbackSections: KnowledgeDocument["sections"]
): boolean {
  if (!defuddleResult || !isUsefulExtraction(defuddleResult) || defuddleSections.length === 0) {
    return false;
  }

  if (defuddleSections.length <= 1 && fallbackSections.length > defuddleSections.length) {
    return false;
  }

  return true;
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

function cleanDocumentForExtraction(document: Document): void {
  const selectors = [
    "script",
    "style",
    "noscript",
    "template",
    "iframe",
    "svg",
    "canvas",
    "form",
    "input",
    "button",
    "select",
    "textarea",
    "nav",
    "header",
    "footer",
    "aside",
    "dialog",
    "[role='navigation']",
    "[role='banner']",
    "[role='complementary']",
    "[role='contentinfo']",
    "[role='dialog']",
    "[role='alertdialog']",
    "[role='menu']",
    "[aria-hidden='true']",
    "[hidden]",
    "[popover]",
    ".modal",
    ".overlay",
    ".popup",
    ".popover",
    ".tooltip",
    ".toast",
    ".drawer",
    ".sidebar",
    ".navbar",
    ".navigation",
    ".menu",
    ".cookie",
    ".cookies",
    ".consent",
    ".banner",
    ".ad",
    ".ads",
    ".advertisement",
    ".share",
    ".social",
    ".subscribe",
    ".newsletter",
    "#modal",
    "#overlay",
    "#popup",
    "#cookie",
    "#cookies",
    "#consent",
    "#banner"
  ];

  document.querySelectorAll(selectors.join(",")).forEach((node) => node.remove());
  document.querySelectorAll("*").forEach((node) => {
    node.removeAttribute("style");
    const className = node.getAttribute("class") ?? "";
    const id = node.getAttribute("id") ?? "";
    if (isLikelyNoise(`${className} ${id}`)) {
      node.remove();
    }
  });
}

function isLikelyNoise(value: string): boolean {
  return /\b(nav|navbar|navigation|menu|sidebar|modal|overlay|popup|popover|tooltip|toast|drawer|cookie|cookies|consent|banner|advert|advertisement|ads?|share|social|subscribe|newsletter|promo|recommend|related|breadcrumb|footer|header|floating|sticky|fixed)\b/i.test(value);
}

function extractSections(root: Element, title: string): KnowledgeDocument["sections"] {
  const sections: KnowledgeDocument["sections"] = [];
  const nodes = root.querySelectorAll("h1,h2,h3,h4,h5,h6,p,pre,blockquote,ul,ol,figure,table");

  for (const node of nodes) {
    const tagName = node.tagName.toLowerCase();
    const text = normalizeText(node.textContent ?? "");
    const hasMedia = Boolean(node.querySelector("img"));
    if ((!text && !hasMedia && tagName !== "table") || (text === title && !hasMedia)) {
      continue;
    }

    if (/^h[1-6]$/.test(tagName)) {
      sections.push({
        section_id: makeId(),
        type: "heading",
        level: Number(tagName.slice(1)),
        content: inlineToMarkdown(node)
      });
      continue;
    }

    if (tagName === "ul" || tagName === "ol") {
      const items = [...node.querySelectorAll(":scope > li")]
        .map((li) => inlineToMarkdown(li))
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

    if (tagName === "figure") {
      const assets = [...node.querySelectorAll("img")]
        .map((img) => ({
          asset_id: makeId(),
          source_url: img.getAttribute("src") || undefined,
          alt: normalizeText(img.getAttribute("alt") ?? "") || undefined,
          caption: normalizeText(
            node.querySelector("figcaption")?.textContent ??
            img.getAttribute("alt") ??
            ""
          ) || null
        }))
        .filter((asset) => asset.source_url);
      const caption = normalizeText(node.querySelector("figcaption")?.textContent ?? "");
      sections.push({
        section_id: makeId(),
        type: "figure",
        content: caption,
        assets
      });
      continue;
    }

    if (tagName === "table") {
      const rows = [...node.querySelectorAll("tr")]
        .map((row) => [...row.querySelectorAll("th,td")].map((cell) => inlineToMarkdown(cell)))
        .filter((row) => row.length > 0);
      if (rows.length > 0) {
        sections.push({ section_id: makeId(), type: "table", rows });
      }
      continue;
    }

    sections.push({
      section_id: makeId(),
      type: "paragraph",
      content: inlineToMarkdown(node)
    });
  }

  return dedupeAdjacent(sections);
}

function inlineToMarkdown(node: Element): string {
  return normalizeMarkdown(renderInlineChildren(node));
}

function renderInlineChildren(node: Element): string {
  return [...node.childNodes].map(renderInlineNode).join("");
}

function renderInlineNode(node: ChildNode): string {
  if (node.nodeType === 3) {
    return node.textContent ?? "";
  }

  if (node.nodeType !== 1) {
    return "";
  }

  const element = node as Element;
  const tagName = element.tagName.toLowerCase();
  const content = renderInlineChildren(element);

  if (tagName === "a") {
    const href = element.getAttribute("href");
    const label = normalizeMarkdown(content || href || "");
    return href && label ? `[${escapeMarkdownLinkText(label)}](${href})` : label;
  }

  if (tagName === "img") {
    const src = element.getAttribute("src");
    const alt = normalizeMarkdown(element.getAttribute("alt") ?? "");
    return src ? `![${escapeMarkdownLinkText(alt)}](${src})` : alt;
  }

  if (tagName === "code") {
    return `\`${content.replace(/`/g, "\\`")}\``;
  }

  if (tagName === "strong" || tagName === "b") {
    return content ? `**${content}**` : "";
  }

  if (tagName === "em" || tagName === "i") {
    return content ? `_${content}_` : "";
  }

  if (tagName === "br") {
    return "\n";
  }

  return content;
}

function normalizeMarkdown(value: string): string {
  return value
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function escapeMarkdownLinkText(value: string): string {
  return value.replace(/[[\]]/g, "\\$&");
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
