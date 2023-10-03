import { createKnowledgeApiClient } from "./api-client.js";
import { getSettings } from "./settings.js";
import { openKnowledgePage } from "./tabs.js";
import type { Annotation, AnnotationType } from "./types.js";

const settings = await getSettings();
const client = createKnowledgeApiClient(settings);
const query = new URLSearchParams(globalThis.location.search);
const docId = query.get("docId") || "";
const itemId = query.get("itemId") || undefined;

const backBtn = mustGet<HTMLButtonElement>("back-to-items");
const titleEl = mustGet<HTMLHeadingElement>("anno-title");
const subtitleEl = mustGet<HTMLElement>("anno-subtitle");
const filterBar = mustGet<HTMLElement>("anno-filter");
const deleteAllBtn = mustGet<HTMLButtonElement>("anno-delete-all");
const listEl = mustGet<HTMLElement>("anno-list");
const emptyEl = mustGet<HTMLElement>("anno-empty");

let currentAnnotations: Annotation[] = [];
let currentFilter: AnnotationType | "all" = "all";

backBtn.addEventListener("click", () => {
  void openKnowledgePage("items.html");
});

if (!docId) {
  titleEl.textContent = "No document selected";
  subtitleEl.textContent = "Open this page from the Items list.";
} else {
  await loadAnnotations();
}

async function loadAnnotations(): Promise<void> {
  try {
    // Try to get document title
    let title = docId;
    try {
      const doc = await client.document(docId);
      title = doc.meta.title || docId;
    } catch {
      // Document JSON may not exist (purged item)
    }
    titleEl.textContent = title;
    subtitleEl.textContent = `doc_id: ${docId.slice(0, 8)}...`;

    const result = await client.annotations(docId);
    currentAnnotations = result.annotations;
    renderFilter();
    renderList();
  } catch (error) {
    titleEl.textContent = "Error";
    subtitleEl.textContent = error instanceof Error ? error.message : String(error);
  }
}

function renderFilter(): void {
  filterBar.replaceChildren();
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

  deleteAllBtn.hidden = currentAnnotations.length === 0;
  deleteAllBtn.textContent = `Delete All ${currentAnnotations.length}`;
}

function renderList(): void {
  listEl.replaceChildren();
  const filtered = currentFilter === "all"
    ? currentAnnotations
    : currentAnnotations.filter((a) => a.type === currentFilter);

  if (filtered.length === 0) {
    emptyEl.hidden = currentAnnotations.length > 0;
    listEl.style.display = "none";
    return;
  }
  emptyEl.hidden = true;
  listEl.style.display = "";

  for (const anno of filtered) {
    listEl.append(renderCard(anno));
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
    if (!confirm(`Delete this ${anno.type} annotation?`)) return;
    try {
      await client.deleteAnnotation(docId, anno.annotation_id);
      currentAnnotations = currentAnnotations.filter((a) => a.annotation_id !== anno.annotation_id);
      renderFilter();
      renderList();
    } catch (error) {
      alert(`Delete failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  return card;
}

deleteAllBtn.addEventListener("click", async () => {
  if (!confirm(`Delete all ${currentAnnotations.length} annotations for this document?`)) return;
  try {
    const result = await client.deleteAnnotationsForDoc(docId);
    currentAnnotations = [];
    renderFilter();
    renderList();
  } catch (error) {
    alert(`Delete failed: ${error instanceof Error ? error.message : String(error)}`);
  }
});

function mustGet<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
