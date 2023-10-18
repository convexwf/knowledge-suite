import { createKnowledgeApiClient } from "./api-client.js";
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
const objectUrls = new Set<string>();
let aiAbortController: AbortController | null = null;
let aiTaskId: string | null = null;
let aiPollCleanup: (() => void) | null = null;

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

    if (line.startsWith("```")) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      index += 1;
      const block = codeBlock(codeLines.join("\n"));
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
      while (index < lines.length && lines[index].startsWith(">")) {
        quoteLines.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      const quote = document.createElement("blockquote");
      quote.textContent = quoteLines.join("\n");
      if (currentSectionId) quote.dataset.sectionId = currentSectionId;
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
      if (currentSectionId) list.dataset.sectionId = currentSectionId;
      target.append(list);
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
      !/^\s*[-*]\s+/.test(lines[index]) &&
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
    applyHighlightOverlays(contentOutput, currentAnnotations);
    applySummaryIndicators();
    renderAnnotationSidebar();
  } catch {
    currentAnnotations = [];
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
  const boxes = Array.from(aiHeadingList.querySelectorAll<HTMLInputElement>("input[type=checkbox]"));
  const isTopLevel = (cb: HTMLInputElement) => cb.dataset.level === "1";
  const topBoxes = boxes.filter(isTopLevel);
  const targets = topBoxes.length > 0 ? topBoxes : boxes;
  for (const box of targets) {
    box.checked = checked;
    box.dispatchEvent(new Event("change"));
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
    checkbox.addEventListener("change", () => cascadeCheck(checkbox, rows));
    row.append(checkbox, label.slice(0, 60));
    aiHeadingList.append(row);
    rows.push({ checkbox, level });
  }
}

function cascadeCheck(changed: HTMLInputElement, rows: Array<{ checkbox: HTMLInputElement; level: number }>): void {
  const changedIdx = rows.findIndex((r) => r.checkbox === changed);
  if (changedIdx === -1) return;
  const targetLevel = rows[changedIdx].level;
  const checked = changed.checked;

  // Forward: set all deeper-level checkboxes until we hit same or higher level
  for (let i = changedIdx + 1; i < rows.length; i++) {
    if (rows[i].level <= targetLevel) break;
    rows[i].checkbox.checked = checked;
    rows[i].checkbox.dispatchEvent(new Event("change"));
  }

  // Backward: if this was unchecked, also uncheck any parent that now has no checked children
  if (!checked) {
    let parentLevel = targetLevel - 1;
    for (let i = changedIdx - 1; i >= 0; i--) {
      if (rows[i].level < parentLevel && rows[i].checkbox.checked) {
        let hasCheckedChild = false;
        for (let j = i + 1; j < rows.length; j++) {
          if (rows[j].level <= rows[i].level) break;
          if (rows[j].checkbox.checked) { hasCheckedChild = true; break; }
        }
        if (!hasCheckedChild) {
          rows[i].checkbox.checked = false;
          rows[i].checkbox.dispatchEvent(new Event("change"));
          parentLevel = rows[i].level - 1;
        } else {
          break;
        }
      }
    }
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

  let content = "";
  if (noteText) content += escapeHtml(noteText);
  if (!content) content = "(empty)";

  const typeLabel = anno.type.charAt(0).toUpperCase() + anno.type.slice(1);
  popup.innerHTML = `<div class="annotation-popup-header">
    <span class="annotation-popup-type">${typeLabel}${colorLabel ? ` <span style="display:inline-block;width:12px;height:12px;background:${colorLabel};border-radius:2px;"></span>` : ""}</span>
    <button class="annotation-popup-close">&times;</button>
  </div><div class="annotation-popup-body">${content}</div><button class="annotation-popup-delete" data-id="${anno.annotation_id}">Delete</button>`;

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
  const annotLabel = documentCreate("div", "Annotations");
  annotLabel.className = "annotation-count-label";

  if (total === 0) {
    container.append(annotLabel, documentCreate("span", "None"));
    return;
  }

  const types = ["highlight", "note", "summary"] as const;
  const filterBar = document.createElement("div");
  filterBar.className = "annotation-filter";
  for (const type of types) {
    const count = currentAnnotations.filter((a) => a.type === type).length;
    if (count === 0) continue;
    const btn = document.createElement("button");
    btn.textContent = `${type[0].toUpperCase()}${type.slice(1)}`;
    btn.className = "annotation-filter-btn active";
    btn.title = `${count} ${type}(s)`;
    btn.addEventListener("click", () => {
      const visible = !btn.classList.contains("active");
      btn.classList.toggle("active", visible);
      toggleAnnotationType(container, type, visible);
    });
    filterBar.append(btn);
  }
  container.append(filterBar);

  const list = document.createElement("div");
  list.className = "annotation-list";

  const sectionLevels = new Map<string, number>();
  if (currentDocument) {
    for (const s of currentDocument.sections) {
      if (s.type === "heading") {
        const sid = s.section_id as string | undefined;
        const lv = s.level as number | undefined;
        if (sid && typeof lv === "number") {
          sectionLevels.set(sid, lv);
        }
      }
    }
  }

  for (const anno of currentAnnotations) {
    const item = document.createElement("div");
    item.className = "annotation-item";
    item.dataset.type = anno.type;

    if (anno.type === "summary") {
      const level = sectionLevels.get(anno.section_id);
      if (level) item.classList.add(`summary-level-${level}`);
    }

    const typeIcons: Record<string, string> = {"highlight":"◆","note":"✎","summary":"◈","tag":"#","bookmark":"★"};
    const typeIcon = typeIcons[anno.type] ?? "•";
    const color = anno.type === "highlight" ? (anno as Annotation & { color?: string }).color : null;

    const textRef = anno.type === "highlight" ? anno.text_ref : (anno as Annotation & { text_ref?: string }).text_ref;
    const note = anno.type === "highlight" ? anno.note : anno.type === "note" || anno.type === "summary" ? anno.note : "";
    const body = [textRef, note].filter(Boolean).join(" — ");

    item.title = body || "Click to scroll";
    item.addEventListener("click", () => {
      const el = contentOutput.querySelector(`[data-section-id="${anno.section_id}"]`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    });

    item.innerHTML = `<span class="anno-icon"${color ? ` style="color:${color}"` : ""}>${typeIcon}</span><span class="anno-text">${escapeHtml(body || "(empty)")}</span>`;
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
