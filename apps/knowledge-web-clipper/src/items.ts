import { createKnowledgeApiClient } from "./api-client.js";
import {
  buildReaderListEntries,
  normalizeSourceFilter,
  normalizeStructureFilter,
  SourceFilter,
  StructureFilter
} from "./items-model.js";
import { getSettings } from "./settings.js";
import { openKnowledgePage } from "./tabs.js";
import { CollectionSummary, KnowledgeItem, KnowledgeSourceType } from "./types.js";

const uploadForm = mustGet<HTMLFormElement>("upload-form");
const fileInput = mustGet<HTMLInputElement>("epub-file");
const calibreFolderInput = mustGet<HTMLInputElement>("calibre-folder");
const titleHintInput = mustGet<HTMLInputElement>("title-hint");
const tagsInput = mustGet<HTMLInputElement>("tags-input");
const uploadButton = mustGet<HTMLButtonElement>("upload-button");
const statusOutput = mustGet<HTMLElement>("status-output");
const itemList = mustGet<HTMLElement>("item-list");
const refreshButton = mustGet<HTMLButtonElement>("refresh-items");
const settingsButton = mustGet<HTMLButtonElement>("open-settings");
const structureFilterBar = mustGet<HTMLElement>("structure-filter");
const sourceFilterBar = mustGet<HTMLElement>("source-filter");
const selectAll = mustGet<HTMLInputElement>("select-all");
const selectCount = mustGet<HTMLElement>("select-count");
const batchBar = mustGet<HTMLElement>("batch-bar");
const batchReparseBtn = mustGet<HTMLButtonElement>("batch-reparse");
const batchRemoveBtn = mustGet<HTMLButtonElement>("batch-remove");
const batchPurgeBtn = mustGet<HTMLButtonElement>("batch-purge");
const overviewTotal = mustGet<HTMLElement>("overview-total");
const overviewParsed = mustGet<HTMLElement>("overview-parsed");
const overviewLatest = mustGet<HTMLElement>("overview-latest");
const overviewTotalDetail = mustGet<HTMLElement>("overview-total-detail");
const overviewParsedDetail = mustGet<HTMLElement>("overview-parsed-detail");
const overviewLatestDetail = mustGet<HTMLElement>("overview-latest-detail");

const settings = await getSettings();
const client = createKnowledgeApiClient(settings);
const query = new URLSearchParams(globalThis.location.search);

let currentItems: KnowledgeItem[] = [];
let currentCollections: CollectionSummary[] = [];
let activeStructureFilter: StructureFilter = normalizeStructureFilter(
  query.get("structure") ?? (query.get("collectionId") ? "collections" : "all")
);
let activeSourceFilter: SourceFilter = normalizeSourceFilter(query.get("source"));
const focusCollectionId = query.get("collectionId") || "";

settingsButton.addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
});

refreshButton.addEventListener("click", () => {
  void refreshItems();
});

uploadForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void importEpub();
});

selectAll.addEventListener("change", () => {
  const checked = selectAll.checked;
  for (const checkbox of Array.from(itemCheckboxes())) {
    checkbox.checked = checked;
  }
  updateBatchBar();
});

batchReparseBtn.addEventListener("click", () => {
  void batchReparse();
});

batchRemoveBtn.addEventListener("click", () => {
  void batchDelete("remove");
});

batchPurgeBtn.addEventListener("click", () => {
  void batchDelete("purge");
});

setStatus("Ready");
renderFilterBars();
await refreshItems();

function itemCheckboxes(): NodeListOf<HTMLInputElement> {
  return itemList.querySelectorAll<HTMLInputElement>(".item-checkbox");
}

function selectedItemIds(): string[] {
  const ids: string[] = [];
  for (const checkbox of Array.from(itemCheckboxes())) {
    if (checkbox.checked && checkbox.dataset.itemId) {
      ids.push(checkbox.dataset.itemId);
    }
  }
  return ids;
}

function updateBatchBar(): void {
  const count = selectedItemIds().length;
  batchBar.hidden = count === 0;
  selectCount.textContent = `${count} selected`;
  if (count === 0) {
    selectAll.checked = false;
  }
}

async function importEpub(): Promise<void> {
  const selected = selectedImportFiles();
  if (!selected.file) {
    setStatus("Choose an EPUB file or a Calibre folder first.");
    return;
  }

  uploadButton.disabled = true;
  setStatus(`Importing ${selected.file.name}...`);
  try {
    const result = await client.importEpub({
      file: selected.file,
      sourceUri: selected.sourceUri,
      titleHint: titleHintInput.value,
      tags: parseTags(tagsInput.value),
      metadataOpf: selected.metadataOpf,
      cover: selected.cover
    });
    setStatus(`Imported ${displayTitle(result.knowledgeItem)}.`);
    uploadForm.reset();
    await refreshItems();
    openReader(result.knowledgeItem.itemId);
  } catch (error) {
    setStatus(errorMessage(error));
  } finally {
    uploadButton.disabled = false;
  }
}

function selectedImportFiles(): {
  file?: File;
  sourceUri?: string;
  metadataOpf?: File;
  cover?: File;
} {
  const folderFiles = Array.from(calibreFolderInput.files ?? []);
  if (folderFiles.length) {
    const file = folderFiles.find((item) => item.name.toLowerCase().endsWith(".epub"));
    const metadataOpf = folderFiles.find((item) => item.name.toLowerCase() === "metadata.opf");
    const cover = folderFiles.find((item) => /^cover\.(jpe?g|png|webp)$/i.test(item.name));
    return {
      file,
      sourceUri: calibreFolderName(folderFiles) ?? file?.name,
      metadataOpf,
      cover
    };
  }

  const file = fileInput.files?.[0];
  return {
    file,
    sourceUri: file?.name
  };
}

function calibreFolderName(files: File[]): string | undefined {
  const relativePath = webkitRelativePath(files[0]);
  return relativePath?.split("/")[0] || undefined;
}

function webkitRelativePath(file: File | undefined): string | undefined {
  return (file as (File & { webkitRelativePath?: string }) | undefined)?.webkitRelativePath;
}

async function refreshItems(): Promise<void> {
  refreshButton.disabled = true;
  itemList.replaceChildren(loadingNode());
  try {
    const sourceType = activeSourceFilter !== "all"
      ? activeSourceFilter as KnowledgeSourceType
      : undefined;
    const [result, collectionsResult] = await Promise.all([
      client.listItems(sourceType, settings.savedListLimit),
      client.listCollections()
    ]);
    currentCollections = collectionsResult.collections;
    currentItems = await hydrateCollectionIds(result.items);
    renderItems(currentItems);
  } catch (error) {
    itemList.replaceChildren(emptyNode(errorMessage(error)));
  } finally {
    refreshButton.disabled = false;
  }
}

async function hydrateCollectionIds(items: KnowledgeItem[]): Promise<KnowledgeItem[]> {
  return Promise.all(items.map(async (item) => {
    try {
      const detail = await client.item(item.itemId);
      return { ...item, collectionIds: detail.collectionIds ?? [] };
    } catch {
      return { ...item, collectionIds: [] };
    }
  }));
}

function renderItems(items: KnowledgeItem[]): void {
  currentItems = items;
  renderOverview(items);
  itemList.replaceChildren();
  const entries = buildReaderListEntries({
    items,
    collections: currentCollections,
    structureFilter: activeStructureFilter,
    sourceFilter: activeSourceFilter
  });

  if (entries.length === 0) {
    itemList.append(emptyNode("No saved items match the current filter."));
    updateBatchBar();
    return;
  }

  for (const entry of entries) {
    if (entry.kind === "collection") {
      itemList.append(collectionCard(entry));
    } else {
      itemList.append(itemRow(entry));
    }
  }
  updateBatchBar();
}

function renderFilterBars(): void {
  renderChipGroup({
    host: structureFilterBar,
    name: "Structure",
    value: activeStructureFilter,
    options: [
      { value: "all", label: "All" },
      { value: "collections", label: "Collections" },
      { value: "standalone", label: "Standalone" }
    ],
    onChange: (value) => {
      activeStructureFilter = normalizeStructureFilter(value);
      renderFilterBars();
      renderItems(currentItems);
    }
  });

  renderChipGroup({
    host: sourceFilterBar,
    name: "Source",
    value: activeSourceFilter,
    options: [
      { value: "all", label: "All" },
      { value: "url", label: "Web" },
      { value: "epub", label: "EPUB" },
      { value: "pdf", label: "PDF" }
    ],
    onChange: (value) => {
      activeSourceFilter = normalizeSourceFilter(value);
      renderFilterBars();
      void refreshItems();
    }
  });
}

function renderChipGroup(params: {
  host: HTMLElement;
  name: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}): void {
  const label = document.createElement("span");
  label.className = "filter-chip-label";
  label.textContent = params.name;

  const rail = document.createElement("div");
  rail.className = "filter-chip-rail";

  for (const option of params.options) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "filter-chip";
    chip.dataset.active = String(option.value === params.value);
    chip.setAttribute("aria-pressed", String(option.value === params.value));
    chip.textContent = option.label;
    chip.addEventListener("click", () => params.onChange(option.value));
    rail.append(chip);
  }

  params.host.replaceChildren(label, rail);
}

function collectionCard(collection: CollectionSummary): HTMLElement {
  const details = document.createElement("details");
  details.className = "collection-card";
  details.dataset.collectionId = collection.collectionId;
  if (focusCollectionId === collection.collectionId) {
    details.classList.add("focused");
  }

  const summary = document.createElement("summary");
  summary.className = "collection-summary";

  const titleRow = document.createElement("div");
  titleRow.className = "collection-title-row";

  const titleCluster = document.createElement("div");
  titleCluster.className = "collection-title-cluster";

  const eyebrow = document.createElement("span");
  eyebrow.className = "collection-eyebrow";
  eyebrow.textContent = "Collection";

  const title = document.createElement("span");
  title.className = "collection-title";
  title.textContent = collection.title;

  const meta = document.createElement("span");
  meta.className = "collection-meta";
  meta.textContent = `${collection.itemCount} page${collection.itemCount !== 1 ? "s" : ""} · Updated ${formatDate(collection.updatedAt)}`;

  titleCluster.append(eyebrow, title, meta);

  const metaRail = document.createElement("div");
  metaRail.className = "collection-meta-rail";
  metaRail.append(
    badge(sourceBadgeLabel(collection.sourceType as KnowledgeSourceType), "source"),
    badge(collection.state === "active" ? "Ready" : collection.state, collection.state === "active" ? "parsed" : "captured")
  );

  const caret = document.createElement("span");
  caret.className = "collection-caret";
  caret.setAttribute("aria-hidden", "true");
  caret.textContent = "▾";

  titleRow.append(titleCluster, metaRail, caret);
  summary.append(titleRow);
  details.append(summary);

  const body = document.createElement("div");
  body.className = "collection-body";
  const loadingEl = document.createElement("div");
  loadingEl.className = "empty-state";
  loadingEl.textContent = "Loading...";
  body.append(loadingEl);
  details.append(body);

  details.addEventListener("toggle", async () => {
    caret.textContent = details.open ? "▴" : "▾";
    if (!details.open || body.dataset.loaded === "true") {
      return;
    }
    try {
      const detail = await client.collection(collection.collectionId);
      body.replaceChildren();
      body.dataset.loaded = "true";
      for (const item of detail.items) {
        const row = document.createElement("article");
        row.className = "collection-item";

        const indexBadge = document.createElement("span");
        indexBadge.className = "collection-item-index";
        indexBadge.textContent = `[${item.orderIndex + 1}]`;

        const content = document.createElement("div");
        content.className = "collection-item-content";

        const itemTitle = document.createElement("h3");
        itemTitle.className = "collection-item-title";
        itemTitle.textContent = item.title || item.pageTitle || item.normalizedUrl;

        const creator = document.createElement("div");
        creator.className = "collection-item-creator";
        creator.textContent = item.creators?.join(", ") || "Unknown creator";

        const itemMeta = document.createElement("div");
        itemMeta.className = "collection-item-meta";
        itemMeta.textContent = `${item.language || "Unknown language"} · Updated ${formatDate(item.updatedAt)}`;

        content.append(itemTitle, creator, itemMeta);
        row.append(indexBadge, content);

        if (item.docId) {
          row.classList.add("clickable");
          row.addEventListener("click", () => {
            if (item.itemId) {
              void openKnowledgePage(`reader.html?itemId=${encodeURIComponent(item.itemId)}`);
            } else {
              void openKnowledgePage(`reader.html?docId=${encodeURIComponent(item.docId!)}`);
            }
          });
        }

        body.append(row);
      }
      if (body.children.length === 0) {
        body.append(emptyNode("No items in this collection."));
      }
    } catch (error) {
      body.replaceChildren(emptyNode(error instanceof Error ? error.message : String(error)));
    }
  });

  if (focusCollectionId === collection.collectionId) {
    details.open = true;
  }
  return details;
}

function itemRow(item: KnowledgeItem): HTMLElement {
  const row = document.createElement("article");
  row.className = "item-row";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "item-checkbox";
  checkbox.dataset.itemId = item.itemId;
  checkbox.addEventListener("change", updateBatchBar);

  const avatar = document.createElement("div");
  avatar.className = "item-avatar";
  avatar.textContent = sourceShortLabel(item.sourceType);

  const body = document.createElement("div");
  body.className = "item-body";
  const kickerRow = document.createElement("div");
  kickerRow.className = "item-kicker-row";
  kickerRow.append(
    badge(sourceBadgeLabel(item.sourceType), "source"),
    badge(item.state === "parsed" ? "Reader Ready" : "Captured", item.state),
    item.activeDocId ? badge("Document", "doc") : badge("Raw Only", "raw")
  );
  const title = document.createElement("h3");
  title.className = "item-title";
  title.textContent = displayTitle(item);
  const creator = document.createElement("div");
  creator.className = "item-creator";
  creator.textContent = item.creators.join(", ") || "Unknown creator";
  const meta = document.createElement("div");
  meta.className = "item-summary-line";
  meta.textContent = `${item.language || "Unknown language"} · Updated ${formatDate(item.updatedAt)}`;
  body.append(kickerRow, title, creator, meta);

  const actions = document.createElement("div");
  actions.className = "item-actions";
  const details = itemDetails(item);
  details.hidden = true;
  const detailsButton = button("i", "info-button", () => {
    details.hidden = !details.hidden;
    detailsButton.setAttribute("aria-expanded", String(!details.hidden));
  });
  detailsButton.title = "Item details";
  detailsButton.setAttribute("aria-label", "Item details");
  detailsButton.setAttribute("aria-expanded", "false");

  const readButton = button("Read", "primary-button", () => openReader(item.itemId));
  readButton.disabled = item.state !== "parsed" || !item.activeDocId;

  const annotateButton = button("Annotations", "", () => {
    void openKnowledgePage(`annotations.html?docId=${encodeURIComponent(item.activeDocId!)}&itemId=${encodeURIComponent(item.itemId)}`);
  });
  annotateButton.disabled = !item.activeDocId;

  const more = itemMoreMenu(item);
  actions.append(detailsButton, readButton, annotateButton, more);
  row.append(checkbox, avatar, body, actions, details);
  return row;
}

function renderOverview(items: KnowledgeItem[]): void {
  const parsed = items.filter((item) => item.state === "parsed").length;
  const latest = items
    .map((item) => ({ item, time: Date.parse(item.updatedAt) }))
    .filter((entry) => !Number.isNaN(entry.time))
    .sort((left, right) => right.time - left.time)[0]?.item;

  overviewTotal.textContent = String(items.length);
  overviewParsed.textContent = String(parsed);
  overviewLatest.textContent = latest ? formatShortDate(latest.updatedAt) : "-";
  overviewTotalDetail.textContent = items.length === 0
    ? "Start by importing an EPUB or opening a saved web clip."
    : `${items.filter((item) => item.sourceType === "url" || item.sourceType === "singlefile_html").length} web, ${items.filter((item) => item.sourceType === "epub").length} EPUB, ${items.filter((item) => item.sourceType === "pdf").length} PDF.`;
  overviewParsedDetail.textContent = parsed === 0
    ? "No reader-ready items yet."
    : `${parsed} of ${items.length} item(s) can open directly in Reader mode.`;
  overviewLatestDetail.textContent = latest
    ? `${displayTitle(latest)} was updated most recently.`
    : "No activity yet.";
}

function itemDetails(item: KnowledgeItem): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "item-details";
  const table = document.createElement("table");
  table.append(
    detailsRow("Title", displayTitle(item)),
    detailsRow("State", item.state),
    detailsRow("Source", item.sourceType.toUpperCase()),
    detailsRow("Language", item.language || "-"),
    detailsRow("Tags", item.tags.join(", ") || "-"),
    detailsRow("Item ID", item.itemId),
    detailsRow("RawDoc ID", item.activeRawdocId),
    detailsRow("Document ID", item.activeDocId || "-"),
    detailsRow("Collections", item.collectionIds?.length ? item.collectionIds.join(", ") : "-"),
    detailsRow("Identity hash", item.identityHash),
    detailsRow("Created", formatDate(item.createdAt)),
    detailsRow("Updated", formatDate(item.updatedAt)),
    detailsRow("Parsed", item.parsedAt ? formatDate(item.parsedAt) : "-")
  );
  wrapper.append(table);
  return wrapper;
}

function detailsRow(label: string, value: string): HTMLTableRowElement {
  const row = document.createElement("tr");
  const key = document.createElement("th");
  key.scope = "row";
  key.textContent = label;
  const cell = document.createElement("td");
  cell.textContent = value;
  row.append(key, cell);
  return row;
}

function itemMoreMenu(item: KnowledgeItem): HTMLElement {
  const menu = document.createElement("details");
  menu.className = "more-menu";
  const summary = document.createElement("summary");
  summary.textContent = "More";
  menu.append(summary);

  const panel = document.createElement("div");
  panel.className = "more-menu-panel";

  const reparseBtn = document.createElement("button");
  reparseBtn.type = "button";
  reparseBtn.textContent = "Reparse";
  reparseBtn.disabled = item.sourceType === "pdf";
  reparseBtn.addEventListener("click", (event) => {
    event.preventDefault();
    menu.open = false;
    void reparseItem(item.itemId);
  });

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.textContent = "Remove";
  removeBtn.addEventListener("click", (event) => {
    event.preventDefault();
    menu.open = false;
    void deleteItem(item, "remove");
  });

  const purgeBtn = document.createElement("button");
  purgeBtn.type = "button";
  purgeBtn.textContent = "Purge";
  purgeBtn.className = "danger-button";
  purgeBtn.addEventListener("click", (event) => {
    event.preventDefault();
    menu.open = false;
    void deleteItem(item, "purge");
  });

  panel.append(reparseBtn, removeBtn, purgeBtn);
  menu.append(panel);
  return menu;
}

async function reparseItem(itemId: string): Promise<void> {
  setStatus("Reparsing item...");
  try {
    const result = await client.reparseItem(itemId);
    setStatus(`Reparsed ${displayTitle(result.knowledgeItem)}.`);
    await refreshItems();
  } catch (error) {
    setStatus(errorMessage(error));
  }
}

async function deleteItem(item: KnowledgeItem, mode: "remove" | "purge"): Promise<void> {
  const message = mode === "purge"
    ? `Purge ${displayTitle(item)} and delete the stored raw file?`
    : `Remove parsed output for ${displayTitle(item)} but keep the raw file?`;
  if (!globalThis.confirm(message)) {
    return;
  }

  setStatus(`${mode === "purge" ? "Purging" : "Removing"} item...`);
  try {
    await client.deleteItem(item.itemId, mode);
    setStatus(`${mode === "purge" ? "Purged" : "Removed"} ${displayTitle(item)}.`);
    await refreshItems();
  } catch (error) {
    setStatus(errorMessage(error));
  }
}

async function batchReparse(): Promise<void> {
  const ids = selectedItemIds();
  if (ids.length === 0) return;
  setStatus(`Reparsing ${ids.length} item(s)...`);
  let ok = 0;
  for (const id of ids) {
    try {
      await client.reparseItem(id);
      ok += 1;
    } catch (error) {
      setStatus(`Reparse failed for ${id}: ${errorMessage(error)}`);
    }
  }
  setStatus(`Reparsed ${ok}/${ids.length} item(s).`);
  await refreshItems();
}

async function batchDelete(mode: "remove" | "purge"): Promise<void> {
  const ids = selectedItemIds();
  if (ids.length === 0) return;
  const verb = mode === "purge" ? "Purge" : "Remove";
  if (!globalThis.confirm(`${verb} ${ids.length} selected item(s)?`)) return;
  setStatus(`${verb.toLowerCase()}ing ${ids.length} item(s)...`);
  let ok = 0;
  for (const id of ids) {
    try {
      await client.deleteItem(id, mode);
      ok += 1;
    } catch (error) {
      setStatus(`${verb} failed for ${id}: ${errorMessage(error)}`);
    }
  }
  setStatus(`${verb}d ${ok}/${ids.length} item(s).`);
  await refreshItems();
}

function openReader(itemId: string): void {
  void openKnowledgePage(`reader.html?itemId=${encodeURIComponent(itemId)}`);
}

function parseTags(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function displayTitle(item: KnowledgeItem): string {
  return item.title || item.subtitle || item.itemId;
}

function badge(label: string, tone: string): HTMLElement {
  const element = document.createElement("span");
  element.className = `item-badge ${tone}`;
  element.textContent = label;
  return element;
}

function sourceBadgeLabel(sourceType: KnowledgeSourceType): string {
  switch (sourceType) {
    case "url":
      return "Web Clip";
    case "epub":
      return "EPUB";
    case "pdf":
      return "PDF";
    case "singlefile_html":
      return "Web Clip";
    default:
      return sourceType;
  }
}

function sourceShortLabel(sourceType: KnowledgeSourceType): string {
  switch (sourceType) {
    case "url":
      return "WEB";
    case "epub":
      return "EP";
    case "pdf":
      return "PDF";
    case "singlefile_html":
      return "WEB";
    default:
      return String(sourceType);
  }
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  if (className) {
    element.className = className;
  }
  element.addEventListener("click", onClick);
  return element;
}

function loadingNode(): HTMLElement {
  return emptyNode("Loading saved items...");
}

function emptyNode(text: string): HTMLElement {
  const node = document.createElement("div");
  node.className = "empty-state";
  node.textContent = text;
  return node;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatShortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric"
  });
}

function setStatus(message: string): void {
  statusOutput.textContent = message;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mustGet<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }
  return element as T;
}
