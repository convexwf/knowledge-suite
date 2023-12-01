import { createKnowledgeApiClient } from "./api-client.js";
import { getSettings } from "./settings.js";
import { openKnowledgePage } from "./tabs.js";
import type { Annotation, AnnotationItemSummary, AnnotationType } from "./types.js";

const settings = await getSettings();
const client = createKnowledgeApiClient(settings);
const query = new URLSearchParams(globalThis.location.search);
const initialItemId = query.get("itemId") || undefined;

const backBtn = mustGet<HTMLButtonElement>("back-to-items");
const navList = mustGet<HTMLElement>("anno-nav-list");
const detailEl = mustGet<HTMLElement>("anno-detail");
const docCountEl = mustGet<HTMLElement>("anno-doc-count");
const totalCountEl = mustGet<HTMLElement>("anno-total-count");

let items: AnnotationItemSummary[] = [];
let currentItemId: string | null = null;
let currentAnnotations: Annotation[] = [];
let currentFilter: AnnotationType | "all" = "all";

backBtn.addEventListener("click", () => {
  void openKnowledgePage("items.html");
});

await loadDocs();

async function loadDocs(): Promise<void> {
  try {
    const result = await client.listAnnotationItems();
    items = result.items;
    renderNavStats();
    renderNav();

    if (initialItemId && items.some((item) => item.itemId === initialItemId)) {
      void selectItem(initialItemId);
    } else if (items.length > 0) {
      void selectItem(items[0].itemId);
    }
  } catch (error) {
    navList.textContent = error instanceof Error ? error.message : "Failed to load";
  }
}

function renderNav(): void {
  navList.replaceChildren();
  for (const entry of items) {
    const node = document.createElement("div");
    node.className = "anno-nav-item" + (entry.itemId === currentItemId ? " active" : "");
    node.dataset.itemId = entry.itemId;
    const typeSummary = summarizeTypes(entry.types);
    node.innerHTML = `
      <div class="anno-nav-item-copy">
        <span class="anno-nav-item-title">${escapeHtml(entry.displayTitle ?? entry.title ?? entry.itemId.slice(0, 8) + "...")}</span>
        <span class="anno-nav-item-subtitle">${escapeHtml(typeSummary || "No typed annotations yet")}</span>
      </div>
      <span class="anno-nav-item-count">${entry.count}</span>
    `;
    node.addEventListener("click", () => void selectItem(entry.itemId));
    navList.append(node);
  }
}

async function selectItem(itemId: string): Promise<void> {
  currentItemId = itemId;
  renderNav();
  try {
    currentAnnotations = (await client.itemAnnotations(itemId)).annotations;
  } catch {
    currentAnnotations = [];
  }
  currentFilter = "all";
  renderDetail();
}

function renderDetail(): void {
  const item = items.find((entry) => entry.itemId === currentItemId);
  if (!item || !currentItemId) {
    detailEl.innerHTML = `<div class="anno-detail-empty">Select a document to view annotations.</div>`;
    return;
  }

  const title = item.displayTitle ?? item.title ?? currentItemId.slice(0, 8) + "...";
  const docLabel = item.docId.slice(0, 8);

  detailEl.innerHTML = `
    <div class="anno-detail-header">
      <div class="anno-detail-kicker">Annotation Index</div>
      <div class="anno-detail-title">${escapeHtml(title)}</div>
      <div class="anno-detail-subtitle"><code>${docLabel}...</code> · ${currentAnnotations.length} annotations</div>
    </div>
    <div class="anno-detail-overview">
      ${detailStats(item)}
    </div>
    <div class="anno-toolbar">
      <div class="anno-filter" id="anno-filter"></div>
      <div class="anno-toolbar-actions">
        <button class="anno-open-reader" id="anno-open-reader">Open in Reader</button>
        <button class="anno-delete-all" id="anno-delete-all"${currentAnnotations.length === 0 ? " hidden" : ""}>Delete All ${currentAnnotations.length}</button>
      </div>
    </div>
    <div class="anno-list" id="anno-list"></div>
    <div class="anno-detail-empty" id="anno-empty"${currentAnnotations.length > 0 ? " hidden" : ""}>No annotations for this document.</div>
  `;

  setupDetailHandlers();
  renderFilter();
  renderList();
}

function setupDetailHandlers(): void {
  const openReaderBtn = detailEl.querySelector("#anno-open-reader") as HTMLButtonElement | null;
  if (openReaderBtn && currentItemId) {
    const targetItemId = currentItemId;
    openReaderBtn.addEventListener("click", () => {
      void openKnowledgePage(`reader.html?itemId=${encodeURIComponent(targetItemId)}`);
    });
  }
  const deleteAllBtn = detailEl.querySelector("#anno-delete-all") as HTMLButtonElement | null;
  if (deleteAllBtn) {
    deleteAllBtn.addEventListener("click", async () => {
      if (!currentItemId) return;
      if (!confirm(`Delete all ${currentAnnotations.length} annotations for this document?`)) return;
      try {
        await client.deleteAnnotationsForItem(currentItemId);
        currentAnnotations = [];
        const item = items.find((entry) => entry.itemId === currentItemId);
        if (item) { item.count = 0; item.types = {}; }
        renderNavStats();
        renderNav();
        renderDetail();
      } catch (error) {
        alert(`Delete failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }
}

function renderFilter(): void {
  const filterBar = detailEl.querySelector("#anno-filter");
  if (!filterBar) return;
  filterBar.innerHTML = "";

  const counts = new Map<string, number>();
  counts.set("all", currentAnnotations.length);
  for (const a of currentAnnotations) {
    counts.set(a.type, (counts.get(a.type) ?? 0) + 1);
  }

  const types: Array<AnnotationType | "all"> = ["all", "summary", "highlight", "note", "tag"];
  for (const type of types) {
    const count = counts.get(type) ?? 0;
    if (count === 0 && type !== "all") continue;
    const btn = document.createElement("button");
    btn.className = "anno-filter-btn" + (currentFilter === type ? " active" : "");
    btn.textContent = `${type === "all" ? "All" : type[0].toUpperCase() + type.slice(1)} ${count}`;
    btn.addEventListener("click", () => {
      currentFilter = type;
      renderFilter();
      renderList();
    });
    filterBar.append(btn);
  }
}

function renderList(): void {
  const listEl = detailEl.querySelector("#anno-list");
  const emptyEl = detailEl.querySelector("#anno-empty");
  if (!listEl || !emptyEl) return;

  listEl.innerHTML = "";
  const filtered = currentFilter === "all"
    ? currentAnnotations
    : currentAnnotations.filter((a) => a.type === currentFilter);

  if (filtered.length === 0) {
    emptyEl.removeAttribute("hidden");
    return;
  }
  emptyEl.setAttribute("hidden", "");

  for (const anno of filtered) {
    listEl.append(renderCard(anno));
  }

  // Update delete all count
  const deleteAllBtn = detailEl.querySelector("#anno-delete-all") as HTMLButtonElement | null;
  if (deleteAllBtn) {
    deleteAllBtn.textContent = `Delete All ${currentAnnotations.length}`;
    deleteAllBtn.hidden = currentAnnotations.length === 0;
  }
}

function renderCard(anno: Annotation): HTMLElement {
  const card = document.createElement("div");
  card.className = "anno-card" + (anno.orphaned ? " orphaned" : "");

  const typeIcons: Record<string, string> = { highlight: "◆", note: "✎", summary: "◈", tag: "#", bookmark: "★" };
  const icon = typeIcons[anno.type] ?? "•";

  let body = "";
  if (anno.type === "highlight") {
    body = `<span class="text-ref">${escapeHtml(anno.text_ref)}</span>`;
    if (anno.note) body += ` — ${escapeHtml(anno.note)}`;
  } else if (anno.type === "note" || anno.type === "summary") {
    body = escapeHtml(anno.note);
  } else if (anno.type === "tag") {
    body = `#${escapeHtml(anno.label)}`;
  }

  let meta = `section: ${anno.section_id}`;
  if (anno.type === "summary" && "ai_model" in anno) {
    meta += `<span>model: ${escapeHtml((anno as { ai_model: string }).ai_model)}</span>`;
  }

  card.innerHTML = `
    <div class="anno-card-header">
      <span class="anno-card-type">
        ${icon} ${anno.type}${anno.orphaned ? `<span class="orphaned-badge">⚠ orphaned</span>` : ""}
      </span>
      <button class="anno-card-delete" data-id="${anno.annotation_id}">Delete</button>
    </div>
    <div class="anno-card-body">${body}</div>
    <div class="anno-card-meta">${meta}${anno.orphaned_at ? `<span>orphaned at ${anno.orphaned_at.slice(0, 10)}</span>` : ""}</div>
  `;

  const deleteBtn = card.querySelector(".anno-card-delete") as HTMLButtonElement;
  deleteBtn.addEventListener("click", async () => {
    if (!currentItemId) return;
    if (!confirm(`Delete this ${anno.type} annotation?`)) return;
    try {
      await client.deleteItemAnnotation(currentItemId, anno.annotation_id);
      currentAnnotations = currentAnnotations.filter((a) => a.annotation_id !== anno.annotation_id);
      const item = items.find((entry) => entry.itemId === currentItemId);
      if (item) {
        item.count = Math.max(0, item.count - 1);
        item.types[anno.type] = Math.max(0, (item.types[anno.type] ?? 1) - 1);
      }
      renderNavStats();
      renderNav();
      renderFilter();
      renderList();
    } catch (error) {
      alert(`Delete failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  return card;
}

function mustGet<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

function renderNavStats(): void {
  docCountEl.textContent = String(items.length);
  totalCountEl.textContent = String(items.reduce((sum, item) => sum + item.count, 0));
}

function summarizeTypes(types: Record<string, number>): string {
  return Object.entries(types)
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 2)
    .map(([type, count]) => `${type} ${count}`)
    .join(" · ");
}

function detailStats(item: AnnotationItemSummary): string {
  const entries = Object.entries(item.types)
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1]);
  const orphaned = currentAnnotations.filter((annotation) => annotation.orphaned).length;
  const topType = entries[0];
  const topTypeLabel = topType ? escapeHtml(topType[0]) : "No active type";
  const topTypeValue = topType ? String(topType[1]) : "0";

  return [
    `<div class="anno-detail-stat"><span class="anno-detail-stat-label">Total</span><strong class="anno-detail-stat-value">${currentAnnotations.length}</strong><span class="anno-detail-stat-note">All annotations in this document</span></div>`,
    `<div class="anno-detail-stat"><span class="anno-detail-stat-label">Leading Type</span><strong class="anno-detail-stat-value">${topTypeLabel}</strong><span class="anno-detail-stat-note">${topTypeValue} item(s)</span></div>`,
    `<div class="anno-detail-stat"><span class="anno-detail-stat-label">Orphaned</span><strong class="anno-detail-stat-value">${orphaned}</strong><span class="anno-detail-stat-note">${orphaned > 0 ? "Needs review" : "Nothing pending"}</span></div>`
  ].join("");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
