import { createKnowledgeApiClient } from "./api-client.js";
import { getSettings } from "./settings.js";
import { openKnowledgePage } from "./tabs.js";
import { Annotation, KnowledgeDocument, KnowledgeItem } from "./types.js";

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
const outlinePanelToggle = mustGet<HTMLButtonElement>("outline-panel-toggle");
const annotationPanelToggle = mustGet<HTMLButtonElement>("annotation-panel-toggle");
const outlineBody = mustGet<HTMLElement>("outline-body");
const annotationBody = mustGet<HTMLElement>("annotation-body");
const annotationPanel = mustGet<HTMLElement>("annotation-panel").closest(".annotation-panel") as HTMLElement;
const readerLayout = mustGet<HTMLElement>("reader-layout");

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

outlinePanelToggle.addEventListener("click", () => {
  const collapsed = outlinePanelToggle.dataset.collapsed === "true";
  outlinePanelToggle.dataset.collapsed = collapsed ? "false" : "true";
  outlinePanelToggle.textContent = collapsed ? "◀" : "▶";
  outlinePanelToggle.title = collapsed ? "Hide outline" : "Show outline";
  outlineBody.hidden = !collapsed;
  outlineCollapseToggle.hidden = !collapsed;
  readerLayout.classList.toggle("outline-hidden", !collapsed);
});

annotationPanelToggle.addEventListener("click", () => {
  const collapsed = annotationPanelToggle.dataset.collapsed === "true";
  annotationPanelToggle.dataset.collapsed = collapsed ? "false" : "true";
  annotationPanelToggle.textContent = collapsed ? "◀" : "▶";
  annotationPanelToggle.title = collapsed ? "Hide annotations" : "Show annotations";
  annotationBody.hidden = collapsed;
  annotationPanel.classList.toggle("collapsed", collapsed);
  readerLayout.classList.toggle("annot-hidden", collapsed);
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

    currentDocId = currentDocument.doc_id;
    await loadAndApplyAnnotations();
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

    currentDocId = currentDocument.doc_id;
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
    renderAnnotationSidebar();
  } catch {
    currentAnnotations = [];
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
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let textRemaining = searchText;
  const nodes: Text[] = [];
  while (walker.nextNode() && textRemaining.length > 0) {
    const node = walker.currentNode as Text;
    const nodeText = node.textContent ?? "";
    if (nodeText.includes(textRemaining.charAt(0)) || nodes.length > 0) {
      nodes.push(node);
      textRemaining = textRemaining.slice(
        Math.min(nodeText.length, textRemaining.length)
      );
    }
  }
  if (textRemaining.length > 0) return;

  const parentNode = nodes[0]?.parentNode;
  if (!parentNode) return;

  const mark = document.createElement("mark");
  mark.className = "annotation-highlight";
  mark.dataset.annotationId = annotationId;
  if (color) mark.style.backgroundColor = color;
  mark.addEventListener("click", (e) => {
    e.stopPropagation();
    showAnnotationPopup(annotationId, mark);
  });

  let targetRemaining = searchText;
  for (const node of nodes) {
    const nodeText = node.textContent ?? "";
    if (targetRemaining.length >= nodeText.length) {
      mark.append(node.cloneNode(true));
      if (node.parentNode) node.parentNode.replaceChild(document.createTextNode(""), node);
      targetRemaining = targetRemaining.slice(nodeText.length);
    } else {
      const before = node.splitText(targetRemaining.length);
      mark.append(node.cloneNode(true));
      if (node.parentNode) node.parentNode.replaceChild(before, node);
      targetRemaining = "";
      break;
    }
  }

  if (mark.childNodes.length > 0) {
    parentNode.insertBefore(mark, parentNode.firstChild);
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
  const note = anno.type === "highlight" ? anno.note : anno.type === "note" ? anno.note : "";
  const label = anno.type === "tag" ? anno.label : anno.type === "bookmark" ? anno.label : undefined;
  const colorLabel = anno.type === "highlight" ? anno.color ?? null : null;

  let content = "";
  if (note) content += escapeHtml(note);
  if (label) content += content ? ` [${escapeHtml(label)}]` : escapeHtml(label ?? "");
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

  const types = ["highlight", "note", "tag", "bookmark", "summary"] as const;
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
      const active = btn.classList.toggle("active");
      toggleAnnotationType(container, type, active);
    });
    filterBar.append(btn);
  }
  container.append(filterBar);

  const list = document.createElement("div");
  list.className = "annotation-list";
  for (const anno of currentAnnotations) {
    const item = document.createElement("div");
    item.className = "annotation-item";
    item.dataset.type = anno.type;
    item.title = "Click to scroll";
    item.addEventListener("click", () => {
      const el = contentOutput.querySelector(`[data-section-id="${anno.section_id}"]`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    });

    const typeIcon = {"highlight":"◆","note":"✎","tag":"#","bookmark":"★","summary":"◈"}[anno.type] ?? "•";
    const color = anno.type === "highlight" ? (anno as Annotation & { color?: string }).color : null;

    const textRef = anno.type === "highlight" ? anno.text_ref : (anno as Annotation & { text_ref?: string }).text_ref;
    const note = anno.type === "highlight" ? anno.note : anno.type === "note" || anno.type === "summary" ? anno.note : "";
    const label = anno.type === "tag" ? anno.label : anno.type === "bookmark" ? anno.label : "";
    const body = [textRef, note, label].filter(Boolean).join(" — ");

    item.innerHTML = `<span class="anno-icon"${color ? ` style="color:${color}"` : ""}>${typeIcon}</span><span class="anno-text">${escapeHtml(body || "(empty)")}</span>`;
    list.append(item);
  }
  container.append(list);
}

function toggleAnnotationType(container: HTMLElement, type: string, visible: boolean): void {
  const items = Array.from(container.querySelectorAll(`.annotation-item[data-type="${type}"]`));
  for (const item of items) {
    (item as HTMLElement).hidden = !visible;
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
    <button data-action="tag">Tag</button>
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
      const note = anno.type === "highlight" ? anno.note : anno.type === "note" || anno.type === "summary" ? anno.note : "";
      const label = anno.type === "tag" ? anno.label : anno.type === "bookmark" ? anno.label : "";
      const body = [textRef, note, label].filter(Boolean).join(" — ");
      parts.push(`- [${type}] ${body || "(empty)"}`);
    }
    parts.push("");
  }
  return parts.join("\n");
}
