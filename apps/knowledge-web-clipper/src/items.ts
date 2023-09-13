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

const settings = await getSettings();
const client = createKnowledgeApiClient(settings);

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

setStatus("Ready");
await refreshItems();

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
  itemList.replaceChildren();
  if (items.length === 0) {
    itemList.append(emptyNode("No saved items match the current filter."));
    return;
  }

  for (const item of items) {
    itemList.append(itemRow(item));
  }
}

function itemRow(item: KnowledgeItem): HTMLElement {
  const row = document.createElement("article");
  row.className = "item-row";

  const body = document.createElement("div");
  const title = document.createElement("h3");
  title.className = "item-title";
  title.textContent = displayTitle(item);
  const meta = document.createElement("div");
  meta.className = "item-meta";
  meta.append(
    metaSpan(item.sourceType.toUpperCase()),
    metaSpan(item.state),
    metaSpan(item.creators.join(", ") || "Unknown creator"),
    metaSpan(item.language || "Unknown language"),
    metaSpan(`Updated ${formatDate(item.updatedAt)}`)
  );
  if (item.tags.length) {
    meta.append(metaSpan(item.tags.join(", ")));
  }
  body.append(title, meta);

  const actions = document.createElement("div");
  actions.className = "item-actions";
  const readButton = button("Read", "primary-button", () => openReader(item.itemId));
  readButton.disabled = item.state !== "parsed" || !item.activeDocId;
  const reparseButton = button("Reparse", "", () => {
    void reparseItem(item.itemId);
  });
  reparseButton.disabled = item.sourceType !== "epub";
  const removeButton = button("Remove", "", () => {
    void deleteItem(item, "remove");
  });
  const purgeButton = button("Purge", "danger-button", () => {
    void deleteItem(item, "purge");
  });
  actions.append(readButton, reparseButton, removeButton, purgeButton);

  row.append(body, actions);
  return row;
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
    ? `Purge ${displayTitle(item)} and delete the stored raw EPUB file?`
    : `Remove parsed output for ${displayTitle(item)} but keep the raw EPUB file?`;
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

function openReader(itemId: string): void {
  void openKnowledgePage(`reader.html?itemId=${encodeURIComponent(itemId)}`);
}

function parseTags(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function displayTitle(item: KnowledgeItem): string {
  return item.title || item.subtitle || item.itemId;
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

function metaSpan(text: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.textContent = text;
  return span;
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
