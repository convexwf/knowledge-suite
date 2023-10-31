import { createKnowledgeApiClient } from "./api-client.js";
import { getSettings } from "./settings.js";
import { openKnowledgePage } from "./tabs.js";
import type { Annotation, AnnotationType, AnnotationDocSummary } from "./types.js";

const settings = await getSettings();
const client = createKnowledgeApiClient(settings);
const query = new URLSearchParams(globalThis.location.search);
const initialDocId = query.get("docId") || undefined;

const backBtn = mustGet<HTMLButtonElement>("back-to-items");
const navList = mustGet<HTMLElement>("anno-nav-list");
const detailEl = mustGet<HTMLElement>("anno-detail");
const docCountEl = mustGet<HTMLElement>("anno-doc-count");
const totalCountEl = mustGet<HTMLElement>("anno-total-count");

let docs: AnnotationDocSummary[] = [];
let currentDocId: string | null = null;
let currentAnnotations: Annotation[] = [];
let currentFilter: AnnotationType | "all" = "all";

backBtn.addEventListener("click", () => {
  void openKnowledgePage("items.html");
});

await loadDocs();

async function loadDocs(): Promise<void> {
  try {
    const result = await client.listAnnotationDocs();
    docs = result.docs;
    renderNavStats();
    renderNav();

    if (initialDocId && docs.some((d) => d.doc_id === initialDocId)) {
      selectDoc(initialDocId);
    } else if (docs.length > 0) {
      selectDoc(docs[0].doc_id);
    }
  } catch (error) {
    navList.textContent = error instanceof Error ? error.message : "Failed to load";
  }
}

function renderNav(): void {
  navList.replaceChildren();
  for (const doc of docs) {
    const item = document.createElement("div");
    item.className = "anno-nav-item" + (doc.doc_id === currentDocId ? " active" : "");
    item.dataset.docId = doc.doc_id;
    const typeSummary = summarizeTypes(doc.types);
    item.innerHTML = `
      <div class="anno-nav-item-copy">
        <span class="anno-nav-item-title">${escapeHtml(doc.title ?? doc.doc_id.slice(0, 8) + "...")}</span>
        <span class="anno-nav-item-subtitle">${escapeHtml(typeSummary || "No typed annotations yet")}</span>
      </div>
      <span class="anno-nav-item-count">${doc.count}</span>
    `;
    item.addEventListener("click", () => selectDoc(doc.doc_id));
    navList.append(item);
  }
}

async function selectDoc(docId: string): Promise<void> {
  currentDocId = docId;
  renderNav();
  try {
    currentAnnotations = (await client.annotations(docId)).annotations;
  } catch {
    currentAnnotations = [];
  }
  currentFilter = "all";
  renderDetail();
}

function renderDetail(): void {
  const doc = docs.find((d) => d.doc_id === currentDocId);
  if (!doc || !currentDocId) {
    detailEl.innerHTML = `<div class="anno-detail-empty">Select a document to view annotations.</div>`;
    return;
  }

  const title = doc.title ?? currentDocId.slice(0, 8) + "...";

  detailEl.innerHTML = `
    <div class="anno-detail-header">
      <div class="anno-detail-kicker">Annotation Index</div>
      <div class="anno-detail-title">${escapeHtml(title)}</div>
      <div class="anno-detail-subtitle"><code>${currentDocId.slice(0, 8)}...</code> · ${currentAnnotations.length} annotations</div>
    </div>
    <div class="anno-detail-overview">
      ${detailStats(doc)}
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
  if (openReaderBtn && currentDocId) {
    const targetDocId = currentDocId;
    openReaderBtn.addEventListener("click", () => {
      void openKnowledgePage(`reader.html?docId=${encodeURIComponent(targetDocId)}`);
    });
  }
  const deleteAllBtn = detailEl.querySelector("#anno-delete-all") as HTMLButtonElement | null;
  if (deleteAllBtn) {
    deleteAllBtn.addEventListener("click", async () => {
      if (!currentDocId) return;
      if (!confirm(`Delete all ${currentAnnotations.length} annotations for this document?`)) return;
      try {
        await client.deleteAnnotationsForDoc(currentDocId);
        currentAnnotations = [];
        // Update doc summary
        const doc = docs.find((d) => d.doc_id === currentDocId);
        if (doc) { doc.count = 0; doc.types = {}; }
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
    if (!currentDocId) return;
    if (!confirm(`Delete this ${anno.type} annotation?`)) return;
    try {
      await client.deleteAnnotation(currentDocId, anno.annotation_id);
      currentAnnotations = currentAnnotations.filter((a) => a.annotation_id !== anno.annotation_id);
      const doc = docs.find((d) => d.doc_id === currentDocId);
      if (doc) {
        doc.count = Math.max(0, doc.count - 1);
        doc.types[anno.type] = Math.max(0, (doc.types[anno.type] ?? 1) - 1);
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
  docCountEl.textContent = String(docs.length);
  totalCountEl.textContent = String(docs.reduce((sum, doc) => sum + doc.count, 0));
}

function summarizeTypes(types: Record<string, number>): string {
  return Object.entries(types)
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 2)
    .map(([type, count]) => `${type} ${count}`)
    .join(" · ");
}

function detailStats(doc: AnnotationDocSummary): string {
  const entries = Object.entries(doc.types)
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
