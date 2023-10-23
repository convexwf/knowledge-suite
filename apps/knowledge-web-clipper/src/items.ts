import { createKnowledgeApiClient } from "./api-client.js";
import { getSettings } from "./settings.js";
import { openKnowledgePage } from "./tabs.js";
import { KnowledgeItem, KnowledgeSourceType } from "./types.js";

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
const sourceFilter = mustGet<HTMLSelectElement>("source-filter");
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
let currentItems: KnowledgeItem[] = [];

settingsButton.addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
});

refreshButton.addEventListener("click", () => {
  void refreshItems();
});

sourceFilter.addEventListener("change", () => {
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
    const sourceType = sourceFilter.value ? sourceFilter.value as KnowledgeSourceType : undefined;
    const result = await client.listItems(sourceType, settings.savedListLimit);
    renderItems(result.items);
  } catch (error) {
    itemList.replaceChildren(emptyNode(errorMessage(error)));
  } finally {
    refreshButton.disabled = false;
  }
}

function renderItems(items: KnowledgeItem[]): void {
  currentItems = items;
  renderOverview(items);
  itemList.replaceChildren();
  if (items.length === 0) {
    itemList.append(emptyNode("No saved items match the current filter."));
    updateBatchBar();
    return;
  }

  for (const item of items) {
    itemList.append(itemRow(item));
  }
  updateBatchBar();
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
  const sourceLine = document.createElement("div");
  sourceLine.className = "item-summary-line item-statline";
  sourceLine.textContent = [
    item.language || "Unknown language",
    item.creators.length > 0 ? `${item.creators.length} creator${item.creators.length > 1 ? "s" : ""}` : "Unknown creator",
    item.parsedAt ? `Parsed ${formatDate(item.parsedAt)}` : "Waiting for parse"
  ].join(" · ");
  const dateLine = document.createElement("div");
  dateLine.className = "item-summary-line";
  dateLine.textContent = `Updated ${formatDate(item.updatedAt)}`;
  body.append(kickerRow, title, creator, sourceLine, dateLine);

  if (item.tags.length > 0) {
    const tagsLine = document.createElement("div");
    tagsLine.className = "item-tags";
    tagsLine.textContent = item.tags.join(", ");
    body.append(tagsLine);
  }

  const actions = document.createElement("div");
  actions.className = "item-actions";
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

  const details = itemDetails(item);
  details.hidden = true;
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
    : `${items.filter((item) => item.sourceType === "url").length} web, ${items.filter((item) => item.sourceType === "epub").length} EPUB, ${items.filter((item) => item.sourceType === "pdf").length} PDF.`;
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
  reparseBtn.addEventListener("click", (e) => {
    e.preventDefault();
    menu.open = false;
    void reparseItem(item.itemId);
  });

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.textContent = "Remove";
  removeBtn.addEventListener("click", (e) => {
    e.preventDefault();
    menu.open = false;
    void deleteItem(item, "remove");
  });

  const purgeBtn = document.createElement("button");
  purgeBtn.type = "button";
  purgeBtn.textContent = "Purge";
  purgeBtn.className = "danger-button";
  purgeBtn.addEventListener("click", (e) => {
    e.preventDefault();
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
      return "SingleFile";
    default:
      return sourceType;
  }
}

function sourceShortLabel(sourceType: KnowledgeSourceType): string {
  switch (sourceType) {
    case "url":
      return "WB";
    case "epub":
      return "EP";
    case "pdf":
      return "PDF";
    case "singlefile_html":
      return "SF";
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
