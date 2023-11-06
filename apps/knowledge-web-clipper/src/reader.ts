import { createKnowledgeApiClient } from "./api-client.js";
import { applyCascadeSelection, normalizeHeadingSelections } from "./heading-cascade.js";
import { getSettings } from "./settings.js";
import { openKnowledgePage } from "./tabs.js";
import { Annotation, KnowledgeDocument, KnowledgeItem, SummaryAnnotation } from "./types.js";

const titleOutput = mustGet<HTMLElement>("reader-title");
const kickerOutput = mustGet<HTMLElement>("reader-kicker");
const metaOutput = mustGet<HTMLElement>("reader-meta");
const contentOutput = mustGet<HTMLElement>("reader-content");
const outlineOutput = mustGet<HTMLElement>("outline-list");
const copyButton = mustGet<HTMLButtonElement>("copy-markdown");
const reparseButton = mustGet<HTMLButtonElement>("reparse-item");
const backButton = mustGet<HTMLButtonElement>("back-to-items");
const topButton = mustGet<HTMLButtonElement>("back-to-top");
const outlineCollapseToggle = mustGet<HTMLButtonElement>("outline-collapse-toggle");
const annotationPanelToggle = mustGet<HTMLButtonElement>("annotation-panel-toggle");
const annotationBody = mustGet<HTMLElement>("annotation-body");
const annotationPanel = mustGet<HTMLElement>("annotation-panel");
const readerLayout = mustGet<HTMLElement>("reader-layout");
const aiSummarizeBtn = mustGet<HTMLButtonElement>("ai-summarize");
const aiDialog = mustGet<HTMLElement>("ai-dialog");
const aiOverlay = mustGet<HTMLElement>("ai-overlay");
const aiHeadingList = mustGet<HTMLElement>("ai-heading-list");
const aiProgress = mustGet<HTMLElement>("ai-progress");
const aiProgressText = mustGet<HTMLElement>("ai-progress-text");
const aiProgressBar = mustGet<HTMLProgressElement>("ai-progress-bar");
const aiGenerateBtn = mustGet<HTMLButtonElement>("ai-generate");
const aiCancelBtn = mustGet<HTMLButtonElement>("ai-cancel");
const aiSelectAllBtn = mustGet<HTMLButtonElement>("ai-select-all");
const aiDeselectAllBtn = mustGet<HTMLButtonElement>("ai-deselect-all");
const readerSourceOutput = mustGet<HTMLElement>("reader-source");
const readerStateOutput = mustGet<HTMLElement>("reader-state");
const readerCollectionOutput = mustGet<HTMLElement>("reader-collection");
const readerAnnotationCountOutput = mustGet<HTMLElement>("reader-annotation-count");
const prevInCollectionBtn = mustGet<HTMLButtonElement>("prev-in-collection");
const nextInCollectionBtn = mustGet<HTMLButtonElement>("next-in-collection");

const settings = await getSettings();
const client = createKnowledgeApiClient(settings);
const query = new URLSearchParams(globalThis.location.search);
const itemId = query.get("itemId") || undefined;
const docId = query.get("docId") || undefined;
let currentMarkdown = "";
let currentDocument: KnowledgeDocument | undefined;
let currentItem: KnowledgeItem | undefined;
let currentAnnotations: Annotation[] = [];
let currentDocId = "";
let collectionNavData: {
  previous: { docId: string; title?: string; normalizedUrl: string } | null;
  next: { docId: string; title?: string; normalizedUrl: string } | null;
} = { previous: null, next: null };
const objectUrls = new Set<string>();
let aiAbortController: AbortController | null = null;
let aiTaskId: string | null = null;
let aiPollCleanup: (() => void) | null = null;
let aiCascadeRows: Array<{ checkbox: HTMLInputElement; level: number }> = [];

backButton.addEventListener("click", () => {
  void openKnowledgePage("items.html");
});

topButton.addEventListener("click", () => {
  globalThis.scrollTo({ top: 0, behavior: "smooth" });
});

globalThis.addEventListener("scroll", () => {
  topButton.hidden = globalThis.scrollY < 360;
}, { passive: true });

outlineCollapseToggle.addEventListener("click", () => {
  const collapsed = outlineCollapseToggle.dataset.collapsed === "true";
  outlineCollapseToggle.dataset.collapsed = collapsed ? "false" : "true";
  outlineCollapseToggle.textContent = collapsed ? "Collapse all" : "Expand all";
  const toggles = Array.from(outlineOutput.querySelectorAll(".outline-toggle"));
  for (const toggle of toggles) {
    const btn = toggle as HTMLButtonElement;
    const childList = btn.parentElement?.querySelector(":scope > .outline-tree") as HTMLElement | null;
    if (!childList) continue;
    if (collapsed) {
      btn.dataset.expanded = "true";
      btn.textContent = "▾";
      childList.hidden = false;
    } else {
      btn.dataset.expanded = "false";
      btn.textContent = "▸";
      childList.hidden = true;
    }
  }
});

annotationPanelToggle.addEventListener("click", () => {
  const collapsed = annotationPanelToggle.dataset.collapsed === "true";
  annotationPanelToggle.dataset.collapsed = collapsed ? "false" : "true";
  annotationPanelToggle.textContent = collapsed ? "◀" : "▶";
  annotationPanelToggle.title = collapsed ? "Hide annotations" : "Show annotations";
  annotationBody.hidden = !collapsed;
  annotationPanel.classList.toggle("collapsed", !collapsed);
  readerLayout.classList.toggle("annot-visible", collapsed);
});

prevInCollectionBtn.addEventListener("click", () => navigateInCollection("prev"));
nextInCollectionBtn.addEventListener("click", () => navigateInCollection("next"));

copyButton.addEventListener("click", async () => {
  if (!currentMarkdown) {
    return;
  }
  const text = buildExportMarkdown(currentMarkdown, currentAnnotations);
  await navigator.clipboard.writeText(text);
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

contentOutput.addEventListener("mouseup", () => {
  globalThis.setTimeout(() => {
    const selection = globalThis.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) {
      removeAnnotationToolbar();
      return;
    }
    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const element = container instanceof Element ? container : container.parentElement;
    const sectionEl = element?.closest("[data-section-id]") as HTMLElement | null;
    if (!sectionEl) {
      removeAnnotationToolbar();
      return;
    }
    showAnnotationToolbar(selection, sectionEl);
  }, 10);
});

document.addEventListener("click", (e) => {
  const toolbar = document.getElementById("annotation-toolbar");
  if (toolbar && !toolbar.contains(e.target as Node)) {
    removeAnnotationToolbar();
  }
});

aiSummarizeBtn.addEventListener("click", () => openAIDialog());
aiCancelBtn.addEventListener("click", () => { void cancelCurrentTask(); });
aiOverlay.addEventListener("click", closeAIDialog);
aiSelectAllBtn.addEventListener("click", () => setAllCheckboxes(true));
aiDeselectAllBtn.addEventListener("click", () => setAllCheckboxes(false));
aiGenerateBtn.addEventListener("click", () => { void runAISummarize(); });

globalThis.addEventListener("unload", () => {
  for (const url of objectUrls) {
    URL.revokeObjectURL(url);
  }
});

await loadReader();

async function loadReader(): Promise<void> {
  showMessage("Loading document...");
  reparseButton.disabled = !itemId;
  aiSummarizeBtn.disabled = true;
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

    currentDocId = currentDocument.doc_id;
    aiSummarizeBtn.disabled = false;
    await loadAndApplyAnnotations();
    await loadCollectionContext();
  } catch (error) {
    showMessage(error instanceof Error ? error.message : String(error));
    copyButton.disabled = true;
  }
}

async function reparseCurrentItem(value: string): Promise<void> {
  reparseButton.disabled = true;
  aiSummarizeBtn.disabled = true;
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

    currentDocId = currentDocument.doc_id;
    aiSummarizeBtn.disabled = false;
    await loadAndApplyAnnotations();
    const warnings = (result as unknown as Record<string, unknown>).annotationWarnings as
      | { orphanedCount: number; orphanedAnnotations: Array<{ annotation_id: string; type: string; section_id: string; text_ref?: string; label?: string }> }
      | undefined;
    if (warnings?.orphanedCount) {
      showAnnotationOrphanWarning(warnings);
    }
    await loadCollectionContext();
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
  readerSourceOutput.textContent = sourceSummary(item, document);
  readerStateOutput.textContent = item?.state === "parsed"
    ? "Reader Ready"
    : item?.state === "captured"
      ? "Captured"
      : document
        ? "Document Loaded"
        : "Waiting";
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
  let currentSectionId = "";
  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? "";

    const sectionAnchor = line.match(/^<!--\s*section_id:(\S+)\s*-->$/);
    if (sectionAnchor) {
      currentSectionId = sectionAnchor[1];
      index += 1;
      continue;
    }

    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      const hr = document.createElement("hr");
      if (currentSectionId) hr.dataset.sectionId = currentSectionId;
      target.append(hr);
      index += 1;
      continue;
    }

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      index += 1;
      const block = codeBlock(codeLines.join("\n"), lang);
      if (currentSectionId) block.dataset.sectionId = currentSectionId;
      target.append(block);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const block = headingNode(heading[1].length, heading[2]);
      if (currentSectionId) block.dataset.sectionId = currentSectionId;
      target.append(block);
      index += 1;
      continue;
    }

    const image = line.match(/^!\[([^\]]*)]\(([^)]+)\)$/);
    if (image) {
      const block = await imageFigure(image[2], image[1]);
      if (currentSectionId) block.dataset.sectionId = currentSectionId;
      target.append(block);
      index += 1;
      continue;
    }

    if (line.startsWith(">")) {
      const quoteLines: string[] = [];
      while (index < lines.length) {
        const cur = lines[index];
        if (cur.startsWith(">")) {
          quoteLines.push(cur.replace(/^>\s?/, ""));
          index += 1;
        } else if (!cur.trim() && index + 1 < lines.length && lines[index + 1].startsWith(">")) {
          quoteLines.push("");
          index += 1;
        } else {
          break;
        }
      }
      const quote = document.createElement("blockquote");
      quote.textContent = quoteLines.join("\n");
      if (currentSectionId) quote.dataset.sectionId = currentSectionId;
      target.append(quote);
      continue;
    }

    const listItem = matchListItem(line);
    if (listItem) {
      const items = collectListItems(lines, index);
      const block = buildNestedList(items, 0, items[0].indent);
      if (currentSectionId) block.dataset.sectionId = currentSectionId;
      target.append(block);
      index += items.length;
      continue;
    }

    if (isTableStart(lines, index)) {
      const tableLines: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        tableLines.push(lines[index]);
        index += 1;
      }
      const table = tableNode(tableLines);
      if (currentSectionId) table.dataset.sectionId = currentSectionId;
      target.append(table);
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
      !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[index]) &&
      !matchListItem(lines[index]) &&
      !isTableStart(lines, index)
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    const paragraph = document.createElement("p");
    appendInline(paragraph, paragraphLines.join(" "));
    if (currentSectionId) paragraph.dataset.sectionId = currentSectionId;
    target.append(paragraph);
  }
}

interface HeadingNode {
  level: number;
  element: HTMLHeadingElement;
  children: HeadingNode[];
}

function buildHeadingTree(headings: HTMLHeadingElement[]): HeadingNode[] {
  const root: HeadingNode[] = [];
  const stack: HeadingNode[] = [];

  for (const heading of headings) {
    const level = Number(heading.tagName.slice(1));
    const node: HeadingNode = { level, element: heading, children: [] };

    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }

    if (stack.length === 0) {
      root.push(node);
    } else {
      stack[stack.length - 1].children.push(node);
    }

    stack.push(node);
  }

  return root;
}

function renderOutlineTree(nodes: HeadingNode[], parentElement: HTMLElement, depth: number = 0): void {
  const list = document.createElement("ul");
  list.className = "outline-tree";

  for (const node of nodes) {
    const li = document.createElement("li");
    li.className = "outline-item";

    const link = document.createElement("a");
    link.href = `#${node.element.id}`;
    link.textContent = node.element.textContent || "Section";
    link.className = `outline-link depth-${Math.min(depth, 2)}`;
    li.append(link);

    if (node.children.length > 0) {
      const childList = document.createElement("ul");
      childList.className = "outline-tree";
      renderOutlineTree(node.children, childList, depth + 1);

      const toggle = document.createElement("button");
      toggle.className = "outline-toggle";
      toggle.textContent = "▾";
      toggle.dataset.expanded = "true";
      toggle.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const expanded = toggle.dataset.expanded === "true";
        toggle.dataset.expanded = expanded ? "false" : "true";
        toggle.textContent = expanded ? "▸" : "▾";
        childList.hidden = expanded;
      });

      li.prepend(toggle);
      li.append(childList);
    }

    list.append(li);
  }

  parentElement.append(list);
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
  });

  const tree = buildHeadingTree(headings as HTMLHeadingElement[]);
  renderOutlineTree(tree, outlineOutput);
  outlineCollapseToggle.dataset.collapsed = "false";
  outlineCollapseToggle.textContent = "Collapse all";
}

function headingNode(level: number, text: string): HTMLElement {
  const normalizedLevel = Math.min(Math.max(level, 1), 6);
  const heading = document.createElement(`h${normalizedLevel}`);
  appendInline(heading, text);
  heading.id = slugify(text, contentOutput.querySelectorAll("h1, h2, h3, h4, h5, h6").length);
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
      appendFormattedText(segment.element, segment.content);
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
  }, (_el, content) => {
    const em = document.createElement("em");
    appendFormattedText(em, content);
    (_el as HTMLElement).replaceChildren(em);
  });

  applyPattern(/___(.+?)___/g, () => {
    const strong = document.createElement("strong");
    const em = document.createElement("em");
    strong.append(em);
    return strong;
  }, (_el, content) => {
    const em = document.createElement("em");
    appendFormattedText(em, content);
    (_el as HTMLElement).replaceChildren(em);
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

function isTableStart(lines: string[], index: number): boolean {
  return Boolean(
    lines[index]?.trim().startsWith("|") &&
      lines[index + 1]?.trim().startsWith("|") &&
      /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(lines[index + 1].trim())
  );
}

interface ListItemInfo {
  type: "ul" | "ol";
  content: string;
  indent: number;
}

function matchListItem(line: string): ListItemInfo | null {
  const match = line.match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/);
  if (!match) return null;
  return {
    indent: match[1].length,
    type: /^\d+\.$/.test(match[2]) ? "ol" : "ul",
    content: match[3]
  };
}

function collectListItems(lines: string[], startIndex: number): ListItemInfo[] {
  const items: ListItemInfo[] = [];
  let index = startIndex;
  while (index < lines.length) {
    const item = matchListItem(lines[index]);
    if (!item) break;
    items.push(item);
    index += 1;
  }
  return items;
}

function buildNestedList(items: ListItemInfo[], startIdx: number, baseIndent: number): HTMLElement {
  const listType = items[startIdx].type;
  const list = document.createElement(listType);
  let i = startIdx;

  while (i < items.length) {
    const item = items[i];
    if (item.indent < baseIndent) break;

    if (item.indent === baseIndent) {
      const li = document.createElement("li");
      appendInline(li, item.content);
      i += 1;

      if (i < items.length && items[i].indent > baseIndent) {
        const sub = buildNestedList(items, i, items[i].indent);
        li.append(sub);
        i = items.findIndex((it, idx) => idx >= i && it.indent <= baseIndent);
        if (i === -1) i = items.length;
      }

      list.append(li);
    } else {
      break;
    }
  }

  return list;
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

function documentCreate(tagName: "span" | "div", text: string): HTMLElement {
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

async function loadAndApplyAnnotations(): Promise<void> {
  if (!currentDocId) return;
  try {
    const result = await client.annotations(currentDocId);
    currentAnnotations = result.annotations.filter((a) => !a.orphaned);
    readerAnnotationCountOutput.textContent = String(currentAnnotations.length);
    applyHighlightOverlays(contentOutput, currentAnnotations);
    applySummaryIndicators();
    renderAnnotationSidebar();
  } catch {
    currentAnnotations = [];
    readerAnnotationCountOutput.textContent = "0";
  }
}

function openAIDialog(): void {
  aiDialog.hidden = false;
  aiOverlay.hidden = false;
  aiCancelBtn.disabled = true;

  if (aiTaskId) {
    aiProgress.hidden = false;
    aiCancelBtn.disabled = false;
    aiGenerateBtn.disabled = true;
    resumeTaskPolling(aiTaskId);
    return;
  }

  aiGenerateBtn.disabled = false;
  aiProgress.hidden = true;
  populateHeadingList();
}

function closeAIDialog(): void {
  if (aiPollCleanup) {
    aiPollCleanup();
    aiPollCleanup = null;
  }
  aiAbortController = null;
  aiDialog.hidden = true;
  aiOverlay.hidden = true;
}

function setAllCheckboxes(checked: boolean): void {
  if (aiCascadeRows.length === 0) return;
  if (!checked) {
    for (const row of aiCascadeRows) {
      row.checkbox.checked = false;
    }
    return;
  }

  const rootLevel = aiCascadeRows.some((r) => r.level === 1)
    ? 1
    : Math.min(...aiCascadeRows.map((r) => r.level));
  for (const row of aiCascadeRows) {
    row.checkbox.checked = row.level === rootLevel;
  }
  for (const row of aiCascadeRows) {
    if (row.level === rootLevel) {
      cascadeCheck(row.checkbox, aiCascadeRows);
    }
  }
}

function populateHeadingList(): void {
  aiHeadingList.replaceChildren();
  const headings = Array.from(contentOutput.querySelectorAll<HTMLHeadingElement>("h1, h2, h3"));
  if (headings.length === 0) {
    aiHeadingList.append(documentCreate("span", "No headings found in this document."));
    aiGenerateBtn.disabled = true;
    return;
  }
  aiGenerateBtn.disabled = false;
  const existingSummaryIds = new Set(
    currentAnnotations.filter((a) => a.type === "summary").map((a) => a.section_id)
  );

  const skipLabels = /^(序|序言|前言|目录|参考文献|致谢|后记|附录|版权|书评|本书所获赞誉)$/;

  const rows: Array<{ checkbox: HTMLInputElement; level: number }> = [];
  for (const h of headings) {
    const sectionId = h.dataset.sectionId;
    if (!sectionId) continue;
    const level = parseInt(h.tagName[1], 10);
    const label = h.textContent?.trim() ?? "";
    const isGeneric = skipLabels.test(label);
    const row = document.createElement("label");
    row.className = `ai-heading-item level-${level}`;
    if (existingSummaryIds.has(sectionId)) {
      row.classList.add("has-summary");
    }
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = sectionId;
    checkbox.dataset.level = String(level);
    checkbox.checked = level <= 2 && !existingSummaryIds.has(sectionId) && !isGeneric;
    checkbox.addEventListener("change", () => cascadeCheck(checkbox, aiCascadeRows));
    row.append(checkbox, label.slice(0, 60));
    aiHeadingList.append(row);
    rows.push({ checkbox, level });
  }
  aiCascadeRows = rows;
  const normalized = normalizeHeadingSelections(rows.map((row) => ({
    level: row.level,
    checked: row.checkbox.checked
  })));
  for (let i = 0; i < aiCascadeRows.length; i++) {
    aiCascadeRows[i].checkbox.checked = normalized[i].checked;
  }
}

function cascadeCheck(changed: HTMLInputElement, rows: Array<{ checkbox: HTMLInputElement; level: number }>): void {
  const changedIdx = rows.findIndex((r) => r.checkbox === changed);
  if (changedIdx === -1) return;
  const next = applyCascadeSelection(
    rows.map((row) => ({
      level: row.level,
      checked: row.checkbox.checked
    })),
    changedIdx
  );
  for (let i = 0; i < rows.length; i++) {
    rows[i].checkbox.checked = next[i].checked;
  }
}

async function runAISummarize(): Promise<void> {
  const checked = Array.from(
    aiHeadingList.querySelectorAll<HTMLInputElement>("input[type=checkbox]:checked")
  );
  if (checked.length === 0) return;
  const sectionIds = checked.map((c) => c.value);

  aiGenerateBtn.disabled = true;
  startTaskPolling(sectionIds);
}

async function startTaskPolling(sectionIds: string[]): Promise<void> {
  aiProgress.hidden = false;
  aiProgressBar.value = 0;
  aiProgressText.textContent = "Creating task...";
  aiCancelBtn.disabled = false;

  try {
    const task = await client.createAITask(currentDocId, {
      types: ["summary"],
      section_ids: sectionIds,
      force: false,
    });

    aiTaskId = task.task_id;
    beginPolling(task.task_id);
  } catch (error) {
    aiProgressText.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
    aiGenerateBtn.disabled = false;
    aiCancelBtn.disabled = true;
  }
}

async function resumeTaskPolling(taskId: string): Promise<void> {
  aiProgress.hidden = false;
  aiProgressText.textContent = "Resuming...";
  aiGenerateBtn.disabled = true;
  try {
    const state = await client.getTask(taskId);
    if (state.status === "done" || state.status === "cancelled") {
      aiTaskId = null;
      aiProgress.hidden = true;
      aiGenerateBtn.disabled = false;
      aiCancelBtn.disabled = true;
      await loadAndApplyAnnotations();
      populateHeadingList();
      return;
    }
    aiCancelBtn.disabled = false;
    beginPolling(taskId);
  } catch {
    aiTaskId = null;
    aiProgress.hidden = true;
    aiGenerateBtn.disabled = false;
    aiCancelBtn.disabled = true;
  }
}

function beginPolling(taskId: string): void {
  // Fetch initial state immediately
  void client.getTask(taskId).then((state) => {
    updateProgressFromState(state);
    updateHeadingStatus(state);
  });

  const pollInterval = globalThis.setInterval(async () => {
    try {
      const state = await client.getTask(taskId);
      updateProgressFromState(state);
      updateHeadingStatus(state);

      if (state.status === "done" || state.status === "cancelled") {
        globalThis.clearInterval(pollInterval);
        aiTaskId = null;
        aiPollCleanup = null;
        aiGenerateBtn.disabled = false;
        aiCancelBtn.disabled = true;
        await loadAndApplyAnnotations();
        populateHeadingList();
      }
    } catch {
      // polling error, ignore
    }
  }, 3000);

  const cleanup = () => { globalThis.clearInterval(pollInterval); };
  aiPollCleanup = cleanup;
}

function updateProgressFromState(state: import("./types.js").TaskState): void {
  aiProgressBar.max = state.total;
  aiProgressBar.value = state.completed + state.skipped + state.failed;
  aiProgressText.textContent = state.status === "running" && state.current_heading_text
    ? `${state.current_heading_text.slice(0, 30)}... (${state.completed + state.skipped} / ${state.total})`
    : `${state.status}: ${state.completed + state.skipped} / ${state.total}`;
}

async function cancelCurrentTask(): Promise<void> {
  const taskId = aiTaskId;
  if (!taskId) return;
  aiCancelBtn.disabled = true;
  aiProgressText.textContent = "Cancelling...";
  try {
    await client.cancelTask(taskId);
  } catch { /* ignore */ }
  aiTaskId = null;
  aiPollCleanup = null;
  aiProgress.hidden = true;
  aiGenerateBtn.disabled = false;
}

function updateHeadingStatus(state: import("./types.js").TaskState): void {
  const boxes = Array.from(aiHeadingList.querySelectorAll<HTMLInputElement>("input[type=checkbox]"));
  for (const box of boxes) {
    const sid = box.value;
    const label = box.parentElement;
    if (!label) continue;
    // Remove old status
    const oldStatus = label.querySelector(".heading-status");
    if (oldStatus) oldStatus.remove();

    let statusText = "";
    if (state.completed_section_ids.includes(sid)) statusText = " ✅";
    else if (state.failed_section_ids.includes(sid)) statusText = " ⚠️";
    else if (sid === state.current_section_id) statusText = " 🔄";

    if (statusText) {
      const span = document.createElement("span");
      span.className = "heading-status";
      span.textContent = statusText;
      label.append(span);
    }
  }
}

function applyHighlightOverlays(container: HTMLElement, annotations: Annotation[]): void {
  for (const anno of annotations) {
    if (anno.type !== "highlight" && anno.type !== "note") continue;
    const textRef = anno.type === "highlight" ? anno.text_ref : (anno as Annotation & { text_ref?: string }).text_ref;
    if (!textRef) continue;
    const elements = Array.from(container.querySelectorAll(`[data-section-id="${anno.section_id}"]`));
    for (const element of elements) {
      const text = element.textContent ?? "";
      const offset = text.indexOf(textRef);
      if (offset === -1) continue;
      wrapTextInElement(
        element as HTMLElement, textRef, anno.annotation_id,
        anno.type === "highlight" ? (anno as Annotation & { color?: string }).color ?? null : null
      );
      break;
    }
  }
}

function wrapTextInElement(
  element: HTMLElement,
  searchText: string,
  annotationId: string,
  color: string | null
): void {
  const fullText = element.textContent ?? "";
  const offset = fullText.indexOf(searchText);
  if (offset === -1) return;

  const range = document.createRange();
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let walkOffset = 0;
  let startNode: Text | null = null;
  let startNodeOffset = 0;
  let endNode: Text | null = null;
  let endNodeOffset = 0;

  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const len = node.textContent?.length ?? 0;
    if (!startNode && walkOffset + len > offset) {
      startNode = node;
      startNodeOffset = offset - walkOffset;
    }
    if (!endNode && walkOffset + len >= offset + searchText.length) {
      endNode = node;
      endNodeOffset = offset + searchText.length - walkOffset;
      break;
    }
    walkOffset += len;
  }

  if (!startNode || !endNode) return;

  try {
    range.setStart(startNode, startNodeOffset);
    range.setEnd(endNode, endNodeOffset);
  } catch {
    return;
  }

  const mark = document.createElement("mark");
  mark.className = "annotation-highlight";
  mark.dataset.annotationId = annotationId;
  if (color) mark.style.backgroundColor = color;
  mark.addEventListener("click", (e) => {
    e.stopPropagation();
    showAnnotationPopup(annotationId, mark);
  });

  try {
    range.surroundContents(mark);
  } catch {
    const fragment = range.extractContents();
    mark.append(fragment);
    range.insertNode(mark);
  }
}

function showAnnotationPopup(annotationId: string, anchor: HTMLElement): void {
  const previous = document.querySelector(".annotation-popup");
  if (previous) {
    const prevId = (previous as HTMLElement).dataset.annotationId;
    previous.remove();
    if (prevId === annotationId) return;
  }
  const anno = currentAnnotations.find((a) => a.annotation_id === annotationId);
  if (!anno) return;

  const popup = document.createElement("div");
  popup.className = "annotation-popup";
  popup.dataset.annotationId = annotationId;
  const noteText = anno.type === "highlight" ? anno.note : anno.type === "note" || anno.type === "summary" ? anno.note : "";
  const colorLabel = anno.type === "highlight" ? anno.color ?? null : null;
  const typeLabel = capitalizeLabel(anno.type);
  const textRef = anno.type === "highlight" ? anno.text_ref : (anno as Annotation & { text_ref?: string }).text_ref;
  const sectionLabel = formatSectionLabel(anno.section_id);
  const updatedAt = formatShortTimestamp(anno.updated_at);
  const mainBody = noteText || textRef || "(empty)";

  popup.innerHTML = `
    <div class="annotation-popup-header">
      <div class="annotation-popup-title-stack">
        <span class="annotation-popup-type"${colorLabel ? ` style="--anno-accent:${colorLabel}"` : ""}>
          ${colorLabel ? `<span class="annotation-popup-swatch" style="background:${colorLabel}"></span>` : ""}
          ${escapeHtml(typeLabel)}
        </span>
        <span class="annotation-popup-section">${escapeHtml(sectionLabel)} · ${escapeHtml(updatedAt)}</span>
      </div>
      <button class="annotation-popup-close" aria-label="Close annotation">&times;</button>
    </div>
    ${textRef ? `<div class="annotation-popup-ref">${escapeHtml(textRef)}</div>` : ""}
    <div class="annotation-popup-body">${escapeHtml(mainBody)}</div>
    <div class="annotation-popup-actions">
      ${anno.orphaned ? '<span class="annotation-popup-badge">Orphaned</span>' : ""}
      <button class="annotation-popup-delete" data-id="${anno.annotation_id}">Delete</button>
    </div>
  `;

  const closePopup = () => popup.remove();
  popup.querySelector(".annotation-popup-close")?.addEventListener("click", closePopup);

  popup.querySelector(".annotation-popup-delete")?.addEventListener("click", async () => {
    await client.deleteAnnotation(currentDocId, anno.annotation_id);
    currentAnnotations = currentAnnotations.filter((a) => a.annotation_id !== anno.annotation_id);
    popup.remove();
    const marks = Array.from(document.querySelectorAll(`mark[data-annotation-id="${anno.annotation_id}"]`));
    for (const mark of marks) {
      const parent = mark.parentNode;
      if (!parent) continue;
      while (mark.firstChild) {
        parent.insertBefore(mark.firstChild, mark);
      }
      parent.removeChild(mark);
    }
    renderAnnotationSidebar();
  });

  const outsideClick = (e: MouseEvent) => {
    if (!popup.contains(e.target as Node) && e.target !== anchor) {
      popup.remove();
      document.removeEventListener("click", outsideClick);
    }
  };
  globalThis.setTimeout(() => document.addEventListener("click", outsideClick), 0);

  anchor.insertAdjacentElement("afterend", popup);
}

function applySummaryIndicators(): void {
  // Remove old indicators
  for (const old of Array.from(contentOutput.querySelectorAll(".summary-indicator"))) {
    old.remove();
  }

  const summaries = currentAnnotations.filter((a) => a.type === "summary");
  for (const anno of summaries) {
    const el = contentOutput.querySelector(`[data-section-id="${anno.section_id}"]`);
    if (!el || el.querySelector(".summary-indicator")) continue;

    const icon = document.createElement("span");
    icon.className = "summary-indicator";
    icon.textContent = "◈";
    icon.title = "AI Summary";
    icon.addEventListener("click", (e) => {
      e.stopPropagation();
      showSummaryInlinePopup(anno.section_id, icon);
    });
    el.insertBefore(icon, el.firstChild);
  }
}

function showSummaryInlinePopup(sectionId: string, anchor: HTMLElement): void {
  // Close any existing summary popup
  const existing = document.querySelector(".summary-inline-popup");
  if (existing?.parentNode) existing.remove();

  const anno = currentAnnotations.find(
    (a): a is SummaryAnnotation => a.type === "summary" && a.section_id === sectionId
  );
  if (!anno) return;

  const popup = document.createElement("div");
  popup.className = "summary-inline-popup";
  popup.innerHTML = `
    <div class="summary-inline-header">
      <span>AI Summary</span>
      <span style="font-size:10px;opacity:0.6">${escapeHtml(anno.ai_model ?? "")}</span>
    </div>
    <div class="summary-inline-body">${escapeHtml(anno.note ?? "")}</div>
  `;

  const closePopup = () => popup.remove();
  const outsideClick = (e: MouseEvent) => {
    if (!popup.contains(e.target as Node) && e.target !== anchor) {
      popup.remove();
      document.removeEventListener("click", outsideClick);
    }
  };
  globalThis.setTimeout(() => document.addEventListener("click", outsideClick), 0);

  anchor.insertAdjacentElement("afterend", popup);
}

function showAnnotationOrphanWarning(
  warnings: { orphanedCount: number; orphanedAnnotations: Array<{ annotation_id: string; type: string; section_id: string; text_ref?: string; label?: string }> }
): void {
  const banner = document.createElement("div");
  banner.className = "annotation-orphan-warning";
  banner.textContent = `${warnings.orphanedCount} annotation(s) could not be matched to new sections. They have been preserved but may need review. `;
  const details = document.createElement("span");
  details.style.cursor = "pointer";
  details.style.textDecoration = "underline";
  details.textContent = "View details";
  details.addEventListener("click", () => {
    const list = warnings.orphanedAnnotations.map(
      (a) => `  - [${a.type}] ${a.text_ref ?? a.label ?? a.section_id}`
    ).join("\n");
    alert(`Orphaned annotations:\n${list}`);
  });
  banner.append(details);
  contentOutput.insertBefore(banner, contentOutput.firstChild);
}

function renderAnnotationSidebar(): void {
  const container = document.getElementById("annotation-sidebar");
  if (!container) return;
  container.replaceChildren();

  const total = currentAnnotations.length;
  const summary = document.createElement("div");
  summary.className = "annotation-summary";
  const annotLabel = documentCreate("div", "Document Notes");
  annotLabel.className = "annotation-count-label";
  const summaryCount = countByType(currentAnnotations);
  const summaryLine = total === 0
    ? "No highlights, notes, or summaries yet."
    : `${total} annotation${total === 1 ? "" : "s"} in this document`;
  const detailLine = total === 0
    ? "Start by selecting text in the reader."
    : `${summaryCount.highlight} highlight${summaryCount.highlight === 1 ? "" : "s"} · ${summaryCount.note} note${summaryCount.note === 1 ? "" : "s"} · ${summaryCount.summary} summar${summaryCount.summary === 1 ? "y" : "ies"}`;
  const annotMeta = documentCreate("div", summaryLine);
  annotMeta.className = "annotation-summary-meta";
  const annotDetail = documentCreate("div", detailLine);
  annotDetail.className = "annotation-summary-detail";
  summary.append(annotLabel, annotMeta, annotDetail);

  if (total === 0) {
    const empty = documentCreate("div", "Select text to create your first highlight or note.");
    empty.className = "annotation-empty-state";
    container.append(summary, empty);
    return;
  }

  const types = ["highlight", "note", "summary"] as const;
  const filterBar = document.createElement("div");
  filterBar.className = "annotation-filter";
  for (const type of types) {
    const count = currentAnnotations.filter((a) => a.type === type).length;
    if (count === 0) continue;
    const btn = document.createElement("button");
    btn.textContent = `${type[0].toUpperCase()}${type.slice(1)} ${count}`;
    btn.className = "annotation-filter-btn active";
    btn.title = `${count} ${type}(s)`;
    btn.addEventListener("click", () => {
      const visible = !btn.classList.contains("active");
      btn.classList.toggle("active", visible);
      toggleAnnotationType(container, type, visible);
    });
    filterBar.append(btn);
  }
  container.append(summary, filterBar);

  const list = document.createElement("div");
  list.className = "annotation-list";

  const currentSectionId = currentVisibleSectionId();
  const orderedAnnotations = [...currentAnnotations].sort((left, right) => {
    const leftCurrent = left.section_id === currentSectionId ? 0 : 1;
    const rightCurrent = right.section_id === currentSectionId ? 0 : 1;
    if (leftCurrent !== rightCurrent) return leftCurrent - rightCurrent;
    return Date.parse(right.updated_at) - Date.parse(left.updated_at);
  });

  const sectionLevels = new Map<string, number>();
  const sectionLabels = new Map<string, string>();
  if (currentDocument) {
    for (const s of currentDocument.sections) {
      if (s.type === "heading") {
        const sid = s.section_id as string | undefined;
        const lv = s.level as number | undefined;
        const headingText = typeof s.text === "string" ? s.text.trim() : "";
        if (sid && typeof lv === "number") {
          sectionLevels.set(sid, lv);
        }
        if (sid && headingText) {
          sectionLabels.set(sid, headingText);
        }
      }
    }
  }

  for (const anno of orderedAnnotations) {
    const item = document.createElement("div");
    item.className = "annotation-item";
    item.dataset.type = anno.type;
    item.dataset.sectionId = anno.section_id;

    if (anno.type === "summary") {
      const level = sectionLevels.get(anno.section_id);
      if (level) item.classList.add(`summary-level-${level}`);
    }

    const typeIcons: Record<string, string> = {"highlight":"◆","note":"✎","summary":"◈","tag":"#","bookmark":"★"};
    const typeIcon = typeIcons[anno.type] ?? "•";
    const color = anno.type === "highlight" ? (anno as Annotation & { color?: string }).color : null;

    const textRef = anno.type === "highlight" ? anno.text_ref : (anno as Annotation & { text_ref?: string }).text_ref;
    const note = anno.type === "highlight" ? anno.note : anno.type === "note" || anno.type === "summary" ? anno.note : "";
    const body = note || textRef || "(empty)";
    const ref = textRef && note ? textRef : "";
    const sectionLabel = sectionLabels.get(anno.section_id) ?? formatSectionLabel(anno.section_id);
    const timeLabel = formatShortTimestamp(anno.updated_at);

    item.title = body || "Click to scroll";
    item.addEventListener("click", () => {
      const el = contentOutput.querySelector(`[data-section-id="${anno.section_id}"]`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    });

    item.innerHTML = `
      <div class="anno-item-top">
        <span class="anno-item-type"${color ? ` style="--anno-accent:${color}"` : ""}>
          <span class="anno-icon"${color ? ` style="color:${color}"` : ""}>${typeIcon}</span>
          <strong>${escapeHtml(capitalizeLabel(anno.type))}</strong>
        </span>
        <span class="anno-item-section">${escapeHtml(sectionLabel)}</span>
      </div>
      ${ref ? `<div class="anno-item-ref">${escapeHtml(ref)}</div>` : ""}
      <div class="anno-item-body">${escapeHtml(body)}</div>
      <div class="anno-item-meta">
        <span>${escapeHtml(timeLabel)}</span>
        ${anno.orphaned ? '<span>Orphaned</span>' : ""}
      </div>
    `;
    list.append(item);
  }
  container.append(list);
}

function toggleAnnotationType(container: HTMLElement, type: string, visible: boolean): void {
  const items = Array.from(container.querySelectorAll(`.annotation-item[data-type="${type}"]`));
  for (const item of items) {
    (item as HTMLElement).style.display = visible ? "" : "none";
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function countByType(annotations: Annotation[]): { highlight: number; note: number; summary: number } {
  return annotations.reduce(
    (acc, annotation) => {
      if (annotation.type === "highlight") acc.highlight += 1;
      if (annotation.type === "note") acc.note += 1;
      if (annotation.type === "summary") acc.summary += 1;
      return acc;
    },
    { highlight: 0, note: 0, summary: 0 }
  );
}

function capitalizeLabel(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatSectionLabel(sectionId: string): string {
  return sectionId.replace(/^sec-/, "Section ");
}

function formatShortTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function currentVisibleSectionId(): string | null {
  const sections = Array.from(contentOutput.querySelectorAll<HTMLElement>("[data-section-id]"));
  let bestSection: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const section of sections) {
    const rect = section.getBoundingClientRect();
    if (rect.bottom <= 0) {
      continue;
    }
    const distance = Math.abs(rect.top - 140);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestSection = section.dataset.sectionId ?? null;
    }
    if (rect.top >= 0 && rect.top < 220) {
      return section.dataset.sectionId ?? bestSection;
    }
  }

  return bestSection;
}

function sourceSummary(item: KnowledgeItem | undefined, document: KnowledgeDocument | undefined): string {
  const sourceType = item?.sourceType ?? document?.meta.source?.type;
  const sourceUrl = document?.meta.source?.url ?? undefined;
  const typeLabel = sourceType ? sourceType.toUpperCase() : "DOC";
  if (!sourceUrl) {
    return typeLabel;
  }
  try {
    const parsed = new URL(sourceUrl);
    return `${typeLabel} · ${parsed.hostname.replace(/^www\./, "")}`;
  } catch {
    return typeLabel;
  }
}

function showAnnotationToolbar(selection: Selection, sectionEl: HTMLElement): void {
  removeAnnotationToolbar();
  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  const toolbar = document.createElement("div");
  toolbar.id = "annotation-toolbar";
  toolbar.style.cssText = `position:fixed;left:${rect.left + rect.width / 2 - 60}px;top:${rect.bottom + 6}px;z-index:200;`;
  toolbar.innerHTML = `
    <button data-action="highlight">Highlight</button>
    <button data-action="note">Note</button>
  `;
  for (const btn of Array.from(toolbar.querySelectorAll("button"))) {
    btn.addEventListener("click", async () => {
      const action = btn.dataset.action ?? "highlight";
      const text = selection.toString().trim();
      const sectionId = sectionEl.dataset.sectionId;
      if (!text || !sectionId || !currentDocId) return;
      await createAnnotationFromSelection(action, text, sectionId);
      removeAnnotationToolbar();
      selection.removeAllRanges();
    });
  }
  document.body.append(toolbar);
}

function removeAnnotationToolbar(): void {
  document.getElementById("annotation-toolbar")?.remove();
}

async function createAnnotationFromSelection(
  action: string,
  text: string,
  sectionId: string
): Promise<void> {
  const annotationId = crypto.randomUUID();
  const now = new Date().toISOString();
  let annotation: Annotation;
  if (action === "tag") {
    const label = globalThis.prompt("Tag label:", text.slice(0, 50));
    if (!label?.trim()) return;
    annotation = {
      type: "tag",
      annotation_id: annotationId,
      doc_id: currentDocId,
      section_id: sectionId,
      label: label.trim().slice(0, 50),
      created_at: now,
      updated_at: now
    };
  } else if (action === "note") {
    const note = globalThis.prompt("Note text:", "");
    if (!note?.trim()) return;
    annotation = {
      type: "note",
      annotation_id: annotationId,
      doc_id: currentDocId,
      section_id: sectionId,
      note: note.trim(),
      text_ref: text.slice(0, 200),
      created_at: now,
      updated_at: now
    };
  } else {
    annotation = {
      type: "highlight",
      annotation_id: annotationId,
      doc_id: currentDocId,
      section_id: sectionId,
      text_ref: text.slice(0, 500),
      created_at: now,
      updated_at: now
    };
  }
  try {
    await client.saveAnnotation(currentDocId, annotation);
  } catch {
    return;
  }
  await loadAndApplyAnnotations();
}

function buildExportMarkdown(markdown: string, annotations: Annotation[]): string {
  if (annotations.length === 0) return markdown;
  const grouped = new Map<string, Annotation[]>();
  for (const anno of annotations) {
    const key = anno.type;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(anno);
  }
  const parts = [markdown, "", "---", "", "## Annotations", ""];
  for (const [type, annos] of grouped) {
    parts.push(`### ${type.charAt(0).toUpperCase() + type.slice(1)}s`, "");
    for (const anno of annos) {
      const textRef = anno.type === "highlight" ? anno.text_ref : (anno as Annotation & { text_ref?: string }).text_ref;
      const noteText2 = anno.type === "highlight" ? anno.note : anno.type === "note" || anno.type === "summary" ? anno.note : "";
      const body = [textRef, noteText2].filter(Boolean).join(" — ");
      parts.push(`- [${type}] ${body || "(empty)"}`);
    }
    parts.push("");
  }
  return parts.join("\n");
}

async function loadCollectionContext(): Promise<void> {
  if (!currentItem || !currentItem.itemId) {
    readerCollectionOutput.textContent = "-";
    return;
  }
  try {
    const detail = await client.item(currentItem.itemId);
    const collectionIds = detail.collectionIds ?? [];
    if (collectionIds.length === 0) {
      readerCollectionOutput.textContent = "None";
      prevInCollectionBtn.disabled = true;
      nextInCollectionBtn.disabled = true;
      return;
    }

    // Show collection names
    const collectionsResult = await client.listCollections();
    const matching = collectionsResult.collections.filter((c) => collectionIds.includes(c.collectionId));
    readerCollectionOutput.textContent = matching.map((c) => c.title).join(", ") || "Unknown";

    // Fetch navigation for the first collection
    if (currentDocId && collectionIds[0]) {
      collectionNavData = await client.collectionNavigation(collectionIds[0], currentDocId);
      prevInCollectionBtn.disabled = !collectionNavData.previous;
      nextInCollectionBtn.disabled = !collectionNavData.next;
    }
  } catch {
    readerCollectionOutput.textContent = "-";
  }
}

async function navigateInCollection(direction: "prev" | "next"): Promise<void> {
  const target = direction === "prev" ? collectionNavData.previous : collectionNavData.next;
  if (!target) return;
  await openKnowledgePage(`reader.html?docId=${encodeURIComponent(target.docId)}`);
}
