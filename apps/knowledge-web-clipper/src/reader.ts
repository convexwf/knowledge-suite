import { createKnowledgeApiClient } from "./api-client.js";
import { getSettings } from "./settings.js";
import { KnowledgeDocument, KnowledgeItem } from "./types.js";

const titleOutput = mustGet<HTMLElement>("reader-title");
const kickerOutput = mustGet<HTMLElement>("reader-kicker");
const metaOutput = mustGet<HTMLElement>("reader-meta");
const contentOutput = mustGet<HTMLElement>("reader-content");
const outlineOutput = mustGet<HTMLElement>("outline-list");
const copyButton = mustGet<HTMLButtonElement>("copy-markdown");
const reparseButton = mustGet<HTMLButtonElement>("reparse-item");
const backButton = mustGet<HTMLButtonElement>("back-to-items");

const settings = await getSettings();
const client = createKnowledgeApiClient(settings);
const query = new URLSearchParams(globalThis.location.search);
const itemId = query.get("itemId") || undefined;
const docId = query.get("docId") || undefined;
let currentMarkdown = "";
let currentDocument: KnowledgeDocument | undefined;
let currentItem: KnowledgeItem | undefined;
const objectUrls = new Set<string>();

backButton.addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("items.html") });
});

copyButton.addEventListener("click", async () => {
  if (!currentMarkdown) {
    return;
  }
  await navigator.clipboard.writeText(currentMarkdown);
  const previous = copyButton.textContent;
  copyButton.textContent = "Copied";
  globalThis.setTimeout(() => {
    copyButton.textContent = previous;
  }, 1200);
});

reparseButton.addEventListener("click", () => {
  if (itemId) {
    void reparseCurrentItem(itemId);
  }
});

globalThis.addEventListener("unload", () => {
  for (const url of objectUrls) {
    URL.revokeObjectURL(url);
  }
});

await loadReader();

async function loadReader(): Promise<void> {
  showMessage("Loading document...");
  reparseButton.disabled = !itemId;
  try {
    if (itemId) {
      const detail = await client.item(itemId);
      currentItem = detail.item;
      currentDocument = detail.document;
      reparseButton.disabled = detail.item.sourceType !== "epub";
      if (!currentDocument && detail.item.activeDocId) {
        currentDocument = await client.document(detail.item.activeDocId);
      }
      currentMarkdown = detail.item.activeDocId ? await client.documentMarkdown(detail.item.activeDocId) : "";
    } else if (docId) {
      currentDocument = await client.document(docId);
      currentMarkdown = await client.documentMarkdown(docId);
    } else {
      showMessage("Open the reader from a saved item or document link.");
      copyButton.disabled = true;
      return;
    }

    if (!currentDocument) {
      renderMetadata(currentItem, undefined);
      showMessage("This item has no parsed document yet. Reparse it from this page or the item list.");
      copyButton.disabled = true;
      return;
    }

    renderMetadata(currentItem, currentDocument);
    await renderMarkdown(currentMarkdown || documentFallbackMarkdown(currentDocument), contentOutput);
    renderOutline();
    copyButton.disabled = !currentMarkdown;
  } catch (error) {
    showMessage(error instanceof Error ? error.message : String(error));
    copyButton.disabled = true;
  }
}

async function reparseCurrentItem(value: string): Promise<void> {
  reparseButton.disabled = true;
  showMessage("Reparsing EPUB...");
  try {
    const result = await client.reparseItem(value);
    currentItem = result.knowledgeItem;
    currentDocument = result.document;
    currentMarkdown = result.markdown;
    renderMetadata(currentItem, currentDocument);
    await renderMarkdown(currentMarkdown, contentOutput);
    renderOutline();
    copyButton.disabled = false;
  } catch (error) {
    showMessage(error instanceof Error ? error.message : String(error));
  } finally {
    reparseButton.disabled = false;
  }
}

function renderMetadata(item: KnowledgeItem | undefined, document: KnowledgeDocument | undefined): void {
  const title = document?.meta.title || item?.title || item?.subtitle || item?.itemId || "Knowledge Reader";
  titleOutput.textContent = title;
  kickerOutput.textContent = item?.sourceType ? `${item.sourceType.toUpperCase()} reader` : "Document reader";
  metaOutput.replaceChildren();
  const metaItems = [
    item?.creators.length ? item.creators.join(", ") : document?.meta.authors?.join(", "),
    document?.meta.language || item?.language,
    item?.state,
    item?.updatedAt ? `Updated ${formatDate(item.updatedAt)}` : document?.meta.ingested_at
      ? `Ingested ${formatDate(document.meta.ingested_at)}`
      : undefined,
    item?.tags.length ? item.tags.join(", ") : document?.meta.tags?.join(", ")
  ].filter((value): value is string => Boolean(value));

  for (const value of metaItems) {
    const span = documentCreate("span", value);
    metaOutput.append(span);
  }
}

async function renderMarkdown(markdown: string, target: HTMLElement): Promise<void> {
  target.replaceChildren();
  const body = stripFrontmatter(markdown).trim();
  if (!body) {
    target.append(messageNode("No Markdown content was produced for this document."));
    return;
  }

  const lines = body.split(/\r?\n/);
  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.startsWith("```")) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      index += 1;
      target.append(codeBlock(codeLines.join("\n")));
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      target.append(headingNode(heading[1].length, heading[2]));
      index += 1;
      continue;
    }

    const image = line.match(/^!\[([^\]]*)]\(([^)]+)\)$/);
    if (image) {
      target.append(await imageFigure(image[2], image[1]));
      index += 1;
      continue;
    }

    if (line.startsWith(">")) {
      const quoteLines: string[] = [];
      while (index < lines.length && lines[index].startsWith(">")) {
        quoteLines.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      const quote = document.createElement("blockquote");
      quote.textContent = quoteLines.join("\n");
      target.append(quote);
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const list = document.createElement("ul");
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        const item = document.createElement("li");
        appendInline(item, lines[index].replace(/^\s*[-*]\s+/, ""));
        list.append(item);
        index += 1;
      }
      target.append(list);
      continue;
    }

    if (isTableStart(lines, index)) {
      const tableLines: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        tableLines.push(lines[index]);
        index += 1;
      }
      target.append(tableNode(tableLines));
      continue;
    }

    const paragraphLines = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^(#{1,6})\s+/.test(lines[index]) &&
      !lines[index].startsWith("```") &&
      !lines[index].startsWith(">") &&
      !/^\s*[-*]\s+/.test(lines[index]) &&
      !isTableStart(lines, index)
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    const paragraph = document.createElement("p");
    appendInline(paragraph, paragraphLines.join(" "));
    target.append(paragraph);
  }
}

function renderOutline(): void {
  outlineOutput.replaceChildren();
  const headings = Array.from(contentOutput.querySelectorAll("h1, h2, h3"));
  if (headings.length === 0) {
    outlineOutput.append(documentCreate("span", "No headings"));
    return;
  }

  headings.forEach((heading, index) => {
    if (!heading.id) {
      heading.id = slugify(heading.textContent || `section-${index + 1}`, index);
    }
    const link = document.createElement("a");
    link.href = `#${heading.id}`;
    link.textContent = heading.textContent || `Section ${index + 1}`;
    link.style.paddingLeft = `${(Number(heading.tagName.slice(1)) - 1) * 8}px`;
    outlineOutput.append(link);
  });
}

function headingNode(level: number, text: string): HTMLElement {
  const normalizedLevel = Math.min(Math.max(level, 1), 6);
  const heading = document.createElement(`h${normalizedLevel}`);
  appendInline(heading, text);
  heading.id = slugify(text, contentOutput.querySelectorAll("h1, h2, h3, h4, h5, h6").length);
  return heading;
}

function codeBlock(code: string): HTMLElement {
  const pre = document.createElement("pre");
  const codeNode = document.createElement("code");
  codeNode.textContent = code;
  pre.append(codeNode);
  return pre;
}

async function imageFigure(src: string, alt: string): Promise<HTMLElement> {
  const figure = document.createElement("figure");
  const image = document.createElement("img");
  image.alt = alt;
  const assetId = assetIdFromSrc(src);
  if (assetId) {
    try {
      const blobUrl = await client.assetBlobUrl(assetId);
      objectUrls.add(blobUrl);
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

function tableNode(lines: string[]): HTMLElement {
  const table = document.createElement("table");
  const [headerLine, _separator, ...bodyLines] = lines;
  const thead = document.createElement("thead");
  const tbody = document.createElement("tbody");
  thead.append(tableRow(headerLine, "th"));
  for (const line of bodyLines) {
    tbody.append(tableRow(line, "td"));
  }
  table.append(thead, tbody);
  return table;
}

function tableRow(line: string, cellName: "td" | "th"): HTMLTableRowElement {
  const row = document.createElement("tr");
  for (const value of line.split("|").slice(1, -1)) {
    const cell = document.createElement(cellName);
    appendInline(cell, value.trim());
    row.append(cell);
  }
  return row;
}

function appendInline(parent: HTMLElement, text: string): void {
  const pattern = /(`([^`]+)`|\[([^\]]+)]\(([^)]+)\))/g;
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > lastIndex) {
      parent.append(document.createTextNode(text.slice(lastIndex, match.index)));
    }
    if (match[2]) {
      const code = document.createElement("code");
      code.textContent = match[2];
      parent.append(code);
    } else if (match[3] && match[4]) {
      if (isSafeUrl(match[4], "link")) {
        const link = document.createElement("a");
        link.href = match[4];
        link.textContent = match[3];
        link.rel = "noreferrer";
        link.target = "_blank";
        parent.append(link);
      } else {
        parent.append(document.createTextNode(match[3]));
      }
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parent.append(document.createTextNode(text.slice(lastIndex)));
  }
}

function isTableStart(lines: string[], index: number): boolean {
  return Boolean(
    lines[index]?.trim().startsWith("|") &&
      lines[index + 1]?.trim().startsWith("|") &&
      /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(lines[index + 1].trim())
  );
}

function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith("---")) {
    return markdown;
  }
  const end = markdown.indexOf("\n---", 3);
  return end >= 0 ? markdown.slice(end + 4) : markdown;
}

function assetIdFromSrc(src: string): string | undefined {
  const match = src.match(/^assets\/([^/?#]+)$/);
  return match?.[1];
}

function isSafeUrl(value: string, kind: "image" | "link"): boolean {
  try {
    const url = new URL(value, globalThis.location.href);
    if (kind === "image") {
      return url.protocol === "http:" || url.protocol === "https:";
    }
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:";
  } catch {
    return false;
  }
}

function documentFallbackMarkdown(document: KnowledgeDocument): string {
  return [
    `# ${document.meta.title}`,
    "",
    ...document.sections.map((section) => section.content || "").filter(Boolean)
  ].join("\n\n");
}

function showMessage(message: string): void {
  contentOutput.replaceChildren(messageNode(message));
  outlineOutput.replaceChildren();
}

function messageNode(message: string): HTMLElement {
  const node = document.createElement("div");
  node.className = "message-state";
  node.textContent = message;
  return node;
}

function documentCreate(tagName: "span", text: string): HTMLElement {
  const node = document.createElement(tagName);
  node.textContent = text;
  return node;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function slugify(text: string, index: number): string {
  const slug = text.toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug ? `${slug}-${index + 1}` : `section-${index + 1}`;
}

function mustGet<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }
  return element as T;
}
