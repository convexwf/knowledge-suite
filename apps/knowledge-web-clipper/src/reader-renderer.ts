import { KnowledgeDocument } from "./types.js";

export interface ReaderRenderContext {
  resolveAsset?: (assetId: string) => Promise<string>;
  registerObjectUrl?: (url: string) => void;
  onDiagnostic?: (diagnostic: ReaderRenderDiagnostic) => void;
}

export interface ReaderRenderDiagnostic {
  kind: "missing_section_id" | "empty_section";
  sectionIndex: number;
  sectionType: ReaderSection["type"];
}

type ReaderSection = KnowledgeDocument["sections"][number];

export async function renderDocument(
  documentModel: KnowledgeDocument,
  target: HTMLElement,
  context: ReaderRenderContext = {}
): Promise<void> {
  target.replaceChildren();
  target.append(headingNode(1, documentModel.meta.title, 0));

  let headingIndex = 1;
  for (const [sectionIndex, section] of documentModel.sections.entries()) {
    const blocks = await renderSection(section, context, () => headingIndex++);
    if (!section.section_id) {
      context.onDiagnostic?.({ kind: "missing_section_id", sectionIndex, sectionType: section.type });
    }
    if (blocks.length === 0) {
      context.onDiagnostic?.({ kind: "empty_section", sectionIndex, sectionType: section.type });
    }
    for (const block of blocks) {
      if (section.section_id) {
        block.dataset.sectionId = section.section_id;
      }
      target.append(block);
    }
  }
}

async function renderSection(
  section: ReaderSection,
  context: ReaderRenderContext,
  nextHeadingIndex: () => number
): Promise<HTMLElement[]> {
  switch (section.type) {
    case "heading":
      return section.content
        ? [headingNode(section.level ?? 2, section.content, nextHeadingIndex(), section.anchor_id)]
        : [];
    case "paragraph":
      return section.content ? [paragraphNode(section.content)] : [];
    case "blockquote": {
      if (!section.content) return [];
      const quote = document.createElement("blockquote");
      quote.textContent = section.content;
      return [quote];
    }
    case "list": {
      const items = section.items ?? [];
      return items.length ? [buildSectionList(items)] : [];
    }
    case "code":
      return [codeBlock(section.content ?? "", section.language)];
    case "figure": {
      const blocks: HTMLElement[] = [];
      for (const asset of section.assets ?? []) {
        const src = asset.path || asset.source_url;
        if (!src) continue;
        blocks.push(await imageFigure(src, asset.alt || asset.caption || "", context));
      }
      if (section.content) {
        blocks.push(paragraphNode(section.content));
      }
      return blocks;
    }
    case "table": {
      const rows = normalizeSectionRows(section.rows);
      if (rows.length) return [tableNode(rows)];
      return section.content ? [paragraphNode(section.content)] : [];
    }
    default:
      return section.content ? [paragraphNode(section.content)] : [];
  }
}

function paragraphNode(text: string): HTMLElement {
  const paragraph = document.createElement("p");
  appendInline(paragraph, text);
  return paragraph;
}

function buildSectionList(items: NonNullable<ReaderSection["items"]>): HTMLElement {
  const list = document.createElement("ul");
  for (const item of items) {
    const li = document.createElement("li");
    const text = typeof item === "string" ? item : item.text;
    appendInline(li, text);
    if (typeof item !== "string" && item.items?.length) {
      li.append(buildSectionList(item.items));
    }
    list.append(li);
  }
  return list;
}

function headingNode(level: number, text: string, index: number, anchorId?: string): HTMLElement {
  const normalizedLevel = Math.min(Math.max(level, 1), 6);
  const heading = document.createElement(`h${normalizedLevel}`);
  appendInline(heading, text);
  heading.id = anchorId || slugify(text, index);
  return heading;
}

function codeBlock(code: string, lang?: string): HTMLElement {
  const pre = document.createElement("pre");
  const codeNode = document.createElement("code");
  codeNode.textContent = code;
  if (lang) {
    codeNode.className = `language-${lang}`;
  }
  pre.append(codeNode);
  return pre;
}

async function imageFigure(src: string, alt: string, context: ReaderRenderContext): Promise<HTMLElement> {
  const figure = document.createElement("figure");
  const image = document.createElement("img");
  image.alt = alt;
  const assetId = assetIdFromSrc(src);
  if (assetId && context.resolveAsset) {
    try {
      const blobUrl = await context.resolveAsset(assetId);
      context.registerObjectUrl?.(blobUrl);
      image.src = blobUrl;
    } catch {
      image.alt = alt || `Missing asset ${assetId}`;
    }
  } else if (isSafeUrl(src, "image")) {
    image.src = src;
  }
  figure.append(image);
  if (alt) {
    const caption = document.createElement("figcaption");
    caption.textContent = alt;
    figure.append(caption);
  }
  return figure;
}

function normalizeSectionRows(rows: unknown[] | undefined): string[][] {
  if (!rows) {
    return [];
  }
  return rows
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => row.map((cell) => String(cell ?? "")));
}

function tableNode(rows: string[][]): HTMLElement {
  const table = document.createElement("table");
  const [headerRow, ...bodyRows] = rows;
  const thead = document.createElement("thead");
  const tbody = document.createElement("tbody");
  if (headerRow) {
    thead.append(tableRow(headerRow, "th"));
  }
  for (const row of bodyRows) {
    tbody.append(tableRow(row, "td"));
  }
  table.append(thead, tbody);
  return table;
}

function tableRow(values: string[], cellName: "td" | "th"): HTMLTableRowElement {
  const row = document.createElement("tr");
  for (const value of values) {
    const cell = document.createElement(cellName);
    appendInline(cell, value);
    row.append(cell);
  }
  return row;
}

function appendInline(parent: HTMLElement, text: string): void {
  const pattern = /(`([^`]+)`|\[([^\]]+)]\(([^)]+)\)|\$([^$\n]+)\$)/g;
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > lastIndex) {
      appendFormattedText(parent, text.slice(lastIndex, match.index));
    }
    if (match[2] !== undefined) {
      const code = document.createElement("code");
      code.textContent = match[2];
      parent.append(code);
    } else if (match[3] !== undefined && match[4] !== undefined) {
      if (isSafeUrl(match[4], "link")) {
        const link = document.createElement("a");
        link.href = match[4];
        link.rel = "noreferrer";
        appendFormattedText(link, match[3]);
        parent.append(link);
      } else {
        parent.append(document.createTextNode(match[3]));
      }
    } else if (match[5] !== undefined) {
      const span = document.createElement("span");
      span.className = "math-inline";
      span.textContent = match[5];
      parent.append(span);
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    appendFormattedText(parent, text.slice(lastIndex));
  }
}

function appendFormattedText(parent: HTMLElement, text: string): void {
  if (!text) return;
  const unescaped = unescapeBackslashes(text);
  const segments = parseInlineFormatting(unescaped);
  if (!segments) {
    appendAutolinks(parent, text);
    return;
  }
  for (const segment of segments) {
    if (typeof segment === "string") {
      appendAutolinks(parent, segment);
    } else {
      parent.append(segment.element);
    }
  }
}

type FormatSegment = string | { element: HTMLElement; content: string };

function parseInlineFormatting(text: string): FormatSegment[] | null {
  let changed = false;
  let result: FormatSegment[] = [text];

  const applyPattern = (
    regex: RegExp,
    createElement: () => HTMLElement,
    innerProcess?: (el: HTMLElement, content: string) => void
  ): void => {
    const next: FormatSegment[] = [];
    for (const segment of result) {
      if (typeof segment !== "string") {
        next.push(segment);
        continue;
      }
      const str = segment;
      let lastIndex = 0;
      let matched = false;
      for (const m of str.matchAll(regex)) {
        changed = true;
        matched = true;
        if (m.index! > lastIndex) {
          next.push(str.slice(lastIndex, m.index!));
        }
        const el = createElement();
        const inner = m[1] ?? "";
        if (innerProcess) {
          innerProcess(el, inner);
        } else {
          appendFormattedText(el, inner);
        }
        next.push({ element: el, content: inner });
        lastIndex = m.index! + m[0].length;
      }
      if (matched && lastIndex < str.length) {
        next.push(str.slice(lastIndex));
      } else if (!matched) {
        next.push(segment);
      }
    }
    result = next;
  };

  applyPattern(/\*\*\*(.+?)\*\*\*/g, () => {
    const strong = document.createElement("strong");
    const em = document.createElement("em");
    strong.append(em);
    return strong;
  }, (element, content) => {
    const em = document.createElement("em");
    appendFormattedText(em, content);
    element.replaceChildren(em);
  });

  applyPattern(/___(.+?)___/g, () => {
    const strong = document.createElement("strong");
    const em = document.createElement("em");
    strong.append(em);
    return strong;
  }, (element, content) => {
    const em = document.createElement("em");
    appendFormattedText(em, content);
    element.replaceChildren(em);
  });

  applyPattern(/\*\*(.+?)\*\*/g, () => document.createElement("strong"));
  applyPattern(/__(.+?)__/g, () => document.createElement("strong"));
  applyPattern(/\*(.+?)\*/g, () => document.createElement("em"));
  applyPattern(/_(.+?)_/g, () => document.createElement("em"));
  applyPattern(/~~(.+?)~~/g, () => document.createElement("del"));

  return changed ? result : null;
}

function unescapeBackslashes(text: string): string {
  return text.replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, "$1");
}

function appendAutolinks(parent: HTMLElement, text: string): void {
  const pattern = /(https?:\/\/[^\s<>"']+)/g;
  let lastIndex = 0;
  let matched = false;
  for (const match of text.matchAll(pattern)) {
    matched = true;
    if (match.index > lastIndex) {
      parent.append(document.createTextNode(text.slice(lastIndex, match.index)));
    }
    const url = match[1];
    const stripped = url.replace(/[.,;:!?)]+$/, "");
    if (isSafeUrl(stripped, "link")) {
      const link = document.createElement("a");
      link.href = stripped;
      link.textContent = stripped;
      link.rel = "noreferrer";
      parent.append(link);
    } else {
      parent.append(document.createTextNode(url));
    }
    lastIndex = match.index + match[0].length;
  }
  if (matched) {
    if (lastIndex < text.length) {
      parent.append(document.createTextNode(text.slice(lastIndex)));
    }
  } else {
    parent.append(document.createTextNode(text));
  }
}

function assetIdFromSrc(src: string): string | undefined {
  const match = src.match(/^assets\/([^/?#]+)$/);
  return match?.[1];
}

function isSafeUrl(value: string, kind: "image" | "link"): boolean {
  if (kind === "link" && value.startsWith("#")) {
    return true;
  }
  try {
    const baseUrl = globalThis.location?.href || "https://reader.invalid/";
    const url = new URL(value, baseUrl);
    if (kind === "image") {
      return url.protocol === "http:" || url.protocol === "https:";
    }
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:";
  } catch {
    return false;
  }
}

function slugify(text: string, index: number): string {
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
  return normalized ? `${normalized}-${index}` : `section-${index}`;
}
