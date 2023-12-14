import { createKnowledgeApiClient } from "./api-client.js";
import { applyCascadeSelection, normalizeHeadingSelections } from "./heading-cascade.js";
import { stripSectionAnchors } from "./markdown-utils.js";
import { renderDocument } from "./reader-renderer.js";
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
const collectionNav = mustGet<HTMLElement>("collection-nav");
const prevInCollectionBtn = mustGet<HTMLButtonElement>("prev-in-collection");
const nextInCollectionBtn = mustGet<HTMLButtonElement>("next-in-collection");

const settings = await getSettings();
const client = createKnowledgeApiClient(settings);
const query = new URLSearchParams(globalThis.location.search);
const itemId = query.get("itemId") || undefined;
let currentItemId = itemId || "";
let currentMarkdown = "";
let currentDocument: KnowledgeDocument | undefined;
let currentItem: KnowledgeItem | undefined;
let currentAnnotations: Annotation[] = [];
let currentDocId = "";
let collectionNavData: {
  previous: { itemId: string; title?: string; normalizedUrl?: string } | null;
  next: { itemId: string; title?: string; normalizedUrl?: string } | null;
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
      currentItemId = detail.item.itemId;
      currentDocument = detail.document;
      reparseButton.disabled = detail.item.sourceType !== "epub" && detail.item.sourceType !== "markdown";
      if (!currentDocument && detail.item.activeDocId) {
        currentDocument = await client.document(detail.item.activeDocId);
      }
      currentMarkdown = detail.item.activeDocId ? await client.documentMarkdown(detail.item.activeDocId) : "";
    } else {
      showMessage("Open the reader from a saved item.");
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
    await renderDocument(currentDocument, contentOutput, {
      resolveAsset: (assetId) => client.assetBlobUrl(assetId),
      registerObjectUrl: (url) => objectUrls.add(url),
      onDiagnostic: (diagnostic) => console.warn("[Reader] section diagnostic", diagnostic)
    });
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
    await renderDocument(currentDocument, contentOutput, {
      resolveAsset: (assetId) => client.assetBlobUrl(assetId),
      registerObjectUrl: (url) => objectUrls.add(url),
      onDiagnostic: (diagnostic) => console.warn("[Reader] section diagnostic", diagnostic)
    });
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
    const result = await client.itemAnnotations(currentItemId);
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
    const task = await client.createItemAITask(currentItemId, {
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
    await client.deleteItemAnnotation(currentItemId, anno.annotation_id);
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
    await client.saveItemAnnotation(currentItemId, annotation);
  } catch {
    return;
  }
  await loadAndApplyAnnotations();
}

function buildExportMarkdown(markdown: string, annotations: Annotation[]): string {
  const cleanMarkdown = stripSectionAnchors(markdown);
  if (annotations.length === 0) return cleanMarkdown;
  const grouped = new Map<string, Annotation[]>();
  for (const anno of annotations) {
    const key = anno.type;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(anno);
  }
  const parts = [cleanMarkdown, "", "---", "", "## Annotations", ""];
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
  try {
    let collectionIds: string[] = [];
    let collectionLinks: Array<{ collectionId: string; title: string }> = [];

    if (currentItem?.itemId) {
      const detail = await client.item(currentItem.itemId);
      collectionIds = detail.collectionIds ?? [];
    } else {
      readerCollectionOutput.textContent = "-";
      setCollectionNavigation(null);
      return;
    }

    if (collectionIds.length === 0) {
      readerCollectionOutput.textContent = "None";
      setCollectionNavigation(null);
      return;
    }

    if (collectionLinks.length === 0) {
      const collectionsResult = await client.listCollections();
      collectionLinks = collectionsResult.collections
        .filter((c) => collectionIds.includes(c.collectionId))
        .map((c) => ({ collectionId: c.collectionId, title: c.title }));
    }

    renderCollectionLinks(collectionLinks);

    if (currentDocId && currentItemId && collectionIds[0]) {
      collectionNavData = await client.collectionNavigation(collectionIds[0], currentItemId);
      setCollectionNavigation(collectionNavData);
      return;
    }
    setCollectionNavigation(null);
  } catch {
    if (!readerCollectionOutput.textContent || readerCollectionOutput.textContent === "-") {
      readerCollectionOutput.textContent = "-";
    }
    setCollectionNavigation(null);
  }
}

function renderCollectionLinks(collections: Array<{ collectionId: string; title: string }>): void {
  if (collections.length === 0) {
    readerCollectionOutput.textContent = "None";
    return;
  }
  readerCollectionOutput.replaceChildren();
  collections.forEach((collection, index) => {
    const link = document.createElement("a");
    link.className = "reader-collection-link";
    link.href = chrome.runtime.getURL(`items.html?structure=collections&collectionId=${encodeURIComponent(collection.collectionId)}`);
    link.textContent = collection.title;
    readerCollectionOutput.append(link);
    if (index < collections.length - 1) {
      readerCollectionOutput.append(document.createTextNode(", "));
    }
  });
}

function setCollectionNavigation(
  navigation: {
    previous: { itemId: string; title?: string; normalizedUrl?: string } | null;
    next: { itemId: string; title?: string; normalizedUrl?: string } | null;
  } | null
): void {
  collectionNav.hidden = !navigation?.previous && !navigation?.next;

  prevInCollectionBtn.hidden = !navigation?.previous;
  nextInCollectionBtn.hidden = !navigation?.next;

  prevInCollectionBtn.disabled = !navigation?.previous;
  nextInCollectionBtn.disabled = !navigation?.next;

  prevInCollectionBtn.title = navigation?.previous?.title || navigation?.previous?.normalizedUrl || "";
  nextInCollectionBtn.title = navigation?.next?.title || navigation?.next?.normalizedUrl || "";
}

async function navigateInCollection(direction: "prev" | "next"): Promise<void> {
  const target = direction === "prev" ? collectionNavData.previous : collectionNavData.next;
  if (!target) return;
  await openKnowledgePage(`reader.html?itemId=${encodeURIComponent(target.itemId)}`);
}
