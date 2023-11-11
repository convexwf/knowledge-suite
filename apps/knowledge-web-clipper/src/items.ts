import { createKnowledgeApiClient } from "./api-client.js";
import { buildReaderListEntries, normalizeSourceFilter, ReaderListCollection, SourceFilter } from "./items-model.js";
import { getSettings } from "./settings.js";
import { openKnowledgePage } from "./tabs.js";
import { CollectionDetail, CollectionSummary, KnowledgeItem, KnowledgeSourceType } from "./types.js";

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
let activeSourceFilter: SourceFilter = normalizeSourceFilter(query.get("source") ?? (query.get("collectionId") ? "collection" : "all"));
const focusCollectionId = query.get("collectionId") || "";
const collectionDetailCache = new Map<string, Promise<CollectionDetail>>();

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
renderFilterBar();
await refreshItems();

function itemCheckboxes(): NodeListOf<HTMLInputElement> {
  return itemList.querySelectorAll<HTMLInputElement>(".item-checkbox");
}

function selectedSelections(): Array<{ itemId?: string; collectionId?: string }> {
  const selections: Array<{ itemId?: string; collectionId?: string }> = [];
  for (const checkbox of Array.from(itemCheckboxes())) {
    if (!checkbox.checked) continue;
    selections.push({
      itemId: checkbox.dataset.itemId,
      collectionId: checkbox.dataset.collectionId
    });
  }
  return selections;
}

function updateBatchBar(): void {
  const count = selectedSelections().length;
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
  collectionDetailCache.clear();
  try {
    const sourceType = activeSourceFilter !== "all" && activeSourceFilter !== "collection"
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
    sourceFilter: activeSourceFilter
  });

  if (entries.length === 0) {
    itemList.append(emptyNode("No saved items match the current filter."));
    updateBatchBar();
    return;
  }

  for (const entry of entries) {
    itemList.append(entry.kind === "collection" ? collectionRow(entry) : itemRow(entry));
  }
  updateBatchBar();
}

function renderFilterBar(): void {
  const label = document.createElement("span");
  label.className = "filter-chip-label";
  label.textContent = "Source";

  const rail = document.createElement("div");
  rail.className = "filter-chip-rail";

  for (const option of [
    { value: "all", label: "All" },
    { value: "url", label: "Web" },
    { value: "epub", label: "EPUB" },
    { value: "pdf", label: "PDF" },
    { value: "collection", label: "Collection" }
  ]) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "filter-chip";
    chip.dataset.active = String(option.value === activeSourceFilter);
    chip.setAttribute("aria-pressed", String(option.value === activeSourceFilter));
    chip.textContent = option.label;
    chip.addEventListener("click", () => {
      activeSourceFilter = normalizeSourceFilter(option.value);
      renderFilterBar();
      void refreshItems();
    });
    rail.append(chip);
  }

  sourceFilterBar.replaceChildren(label, rail);
}

function collectionRow(collection: ReaderListCollection): HTMLElement {
  const row = document.createElement("article");
  row.className = "item-row collection-row";
  if (focusCollectionId === collection.collectionId) {
    row.classList.add("focused");
  }

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "item-checkbox";
  checkbox.dataset.collectionId = collection.collectionId;
  checkbox.addEventListener("change", () => {
    syncCollectionSelection(collection.collectionId, checkbox.checked, members);
    updateBatchBar();
  });

  const avatar = document.createElement("div");
  avatar.className = "item-avatar collection-avatar";
  avatar.textContent = "[i]";

  const body = document.createElement("div");
  body.className = "item-body";
  const kickerRow = document.createElement("div");
  kickerRow.className = "item-kicker-row";
  kickerRow.append(
    badge("Collection", "collection"),
    badge(`${collection.itemCount} page${collection.itemCount === 1 ? "" : "s"}`, "doc"),
    badge(collection.state === "active" ? "Reader Ready" : collection.state, collection.state === "active" ? "parsed" : "captured")
  );
  const title = marqueeTitle("h3", "item-title", collection.title);
  const creator = document.createElement("div");
  creator.className = "item-creator";
  creator.textContent = collection.rootUrl || "Collection of saved web clips";
  const meta = document.createElement("div");
  meta.className = "item-summary-line";
  meta.textContent = `Collection · Updated ${formatDate(collection.updatedAt)}`;
  body.append(kickerRow, title, creator, meta);

  const actions = document.createElement("div");
  actions.className = "item-actions";
  const members = document.createElement("div");
  members.className = "item-details collection-members";
  members.hidden = true;

  const itemsButton = button("Items", "", () => {
    members.hidden = !members.hidden;
    itemsButton.setAttribute("aria-expanded", String(!members.hidden));
    if (!members.hidden) {
      void loadCollectionMembers(collection.collectionId, members, checkbox.checked);
    }
  });
  itemsButton.setAttribute("aria-expanded", "false");

  const readButton = button("Read", "primary-button", () => {
    void openCollectionFirstItem(collection.collectionId);
  });

  const more = collectionMoreMenu(collection);
  actions.append(itemsButton, readButton, more);
  row.append(checkbox, avatar, body, actions, members);

  if (focusCollectionId === collection.collectionId) {
    members.hidden = false;
    itemsButton.setAttribute("aria-expanded", "true");
    void loadCollectionMembers(collection.collectionId, members, checkbox.checked);
  }
  return row;
}

async function loadCollectionMembers(collectionId: string, host: HTMLElement, selectedByParent: boolean): Promise<void> {
  if (host.dataset.loaded === "true") return;
  host.replaceChildren(emptyNode("Loading collection items..."));
  try {
    const detail = await loadCollectionDetail(collectionId);
    const list = document.createElement("div");
    list.className = "collection-members-list";
    for (const member of detail.items) {
      if (!member.itemId) continue;
      const item = currentItems.find((entry) => entry.itemId === member.itemId);
      if (!item) continue;
      const nestedRow = itemRow(item, { nested: true, indexLabel: `[${member.orderIndex + 1}]` });
      const nestedCheckbox = nestedRow.querySelector<HTMLInputElement>(".item-checkbox");
      if (nestedCheckbox) {
        nestedCheckbox.checked = selectedByParent;
      }
      list.append(nestedRow);
    }
    host.replaceChildren(list.children.length ? list : emptyNode("No reader items in this collection."));
    host.dataset.loaded = "true";
  } catch (error) {
    host.replaceChildren(emptyNode(errorMessage(error)));
  }
}

function itemRow(item: KnowledgeItem, options?: { nested?: boolean; indexLabel?: string }): HTMLElement {
  const row = document.createElement("article");
  row.className = "item-row";
  if (options?.nested) {
    row.classList.add("nested-item-row");
  }

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "item-checkbox";
  checkbox.dataset.itemId = item.itemId;
  checkbox.addEventListener("change", updateBatchBar);

  const avatar = document.createElement("div");
  avatar.className = "item-avatar";
  avatar.textContent = options?.indexLabel || sourceShortLabel(item.sourceType);

  const body = document.createElement("div");
  body.className = "item-body";
  const kickerRow = document.createElement("div");
  kickerRow.className = "item-kicker-row";
  kickerRow.append(
    badge(sourceBadgeLabel(item.sourceType), "source"),
    badge(item.state === "parsed" ? "Reader Ready" : "Captured", item.state),
    item.activeDocId ? badge("Document", "doc") : badge("Raw Only", "raw")
  );
  const title = marqueeTitle("h3", "item-title", displayTitle(item));
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

  panel.append(
    actionButton("Reparse", item.sourceType === "pdf", async () => reparseItem(item.itemId), menu),
    actionButton("Remove", false, async () => deleteItem(item, "remove"), menu),
    actionButton("Purge", false, async () => deleteItem(item, "purge"), menu, "danger-button")
  );
  menu.append(panel);
  return menu;
}

function collectionMoreMenu(collection: ReaderListCollection): HTMLElement {
  const menu = document.createElement("details");
  menu.className = "more-menu";
  const summary = document.createElement("summary");
  summary.textContent = "More";
  menu.append(summary);

  const panel = document.createElement("div");
  panel.className = "more-menu-panel";
  panel.append(
    actionButton("Reparse", false, async () => operateOnCollection(collection.collectionId, "reparse"), menu),
    actionButton("Remove", false, async () => operateOnCollection(collection.collectionId, "remove"), menu),
    actionButton("Purge", false, async () => operateOnCollection(collection.collectionId, "purge"), menu, "danger-button")
  );
  menu.append(panel);
  return menu;
}

function actionButton(
  label: string,
  disabled: boolean,
  onClick: () => Promise<void>,
  menu: HTMLDetailsElement,
  className = ""
): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.disabled = disabled;
  if (className) element.className = className;
  element.addEventListener("click", (event) => {
    event.preventDefault();
    menu.open = false;
    void onClick();
  });
  return element;
}

async function openCollectionFirstItem(collectionId: string): Promise<void> {
  const detail = await loadCollectionDetail(collectionId);
  const first = detail.items.find((item) => item.itemId || item.docId);
  if (!first) return;
  if (first.itemId) {
    openReader(first.itemId);
  } else if (first.docId) {
    void openKnowledgePage(`reader.html?docId=${encodeURIComponent(first.docId)}`);
  }
}

async function operateOnCollection(collectionId: string, mode: "reparse" | "remove" | "purge"): Promise<void> {
  const itemIds = await resolveCollectionItemIds(collectionId);
  if (itemIds.length === 0) {
    setStatus("This collection has no reader items yet.");
    return;
  }
  if (mode === "reparse") {
    await performBatchReparse(itemIds, `Reparsing collection (${itemIds.length} item(s))...`);
    return;
  }
  await performBatchDelete(itemIds, mode, `${mode === "purge" ? "Purge" : "Remove"} this collection's ${itemIds.length} item(s)?`);
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
  await performBatchDelete([item.itemId], mode, message, displayTitle(item));
}

async function batchReparse(): Promise<void> {
  const ids = await resolveSelectedItemIds();
  if (ids.length === 0) return;
  await performBatchReparse(ids, `Reparsing ${ids.length} selected item(s)...`);
}

async function batchDelete(mode: "remove" | "purge"): Promise<void> {
  const ids = await resolveSelectedItemIds();
  if (ids.length === 0) return;
  await performBatchDelete(ids, mode, `${mode === "purge" ? "Purge" : "Remove"} ${ids.length} selected item(s)?`);
}

async function performBatchReparse(ids: string[], startMessage: string): Promise<void> {
  setStatus(startMessage);
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

async function performBatchDelete(
  ids: string[],
  mode: "remove" | "purge",
  confirmMessage: string,
  singularLabel?: string
): Promise<void> {
  if (!globalThis.confirm(confirmMessage)) return;
  const verb = mode === "purge" ? "Purge" : "Remove";
  setStatus(`${verb.toLowerCase()}ing ${singularLabel ?? `${ids.length} item(s)`}...`);
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

async function resolveSelectedItemIds(): Promise<string[]> {
  const ids = new Set<string>();
  for (const selection of selectedSelections()) {
    if (selection.itemId) {
      ids.add(selection.itemId);
    }
    if (selection.collectionId) {
      for (const itemId of await resolveCollectionItemIds(selection.collectionId)) {
        ids.add(itemId);
      }
    }
  }
  return [...ids];
}

async function resolveCollectionItemIds(collectionId: string): Promise<string[]> {
  const detail = await loadCollectionDetail(collectionId);
  return detail.items.map((item) => item.itemId).filter((value): value is string => Boolean(value));
}

function loadCollectionDetail(collectionId: string): Promise<CollectionDetail> {
  let detail = collectionDetailCache.get(collectionId);
  if (!detail) {
    detail = client.collection(collectionId);
    collectionDetailCache.set(collectionId, detail);
  }
  return detail;
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

function syncCollectionSelection(collectionId: string, checked: boolean, host: HTMLElement): void {
  host.dataset.parentSelected = checked ? "true" : "false";
  for (const checkbox of Array.from(host.querySelectorAll<HTMLInputElement>(".item-checkbox"))) {
    checkbox.checked = checked;
  }
  const collectionRowElement = host.closest(".collection-row") as HTMLElement | null;
  if (collectionRowElement) {
    collectionRowElement.dataset.selected = checked ? "true" : "false";
  }
}

function marqueeTitle<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className: string,
  text: string
): HTMLElementTagNameMap[K] {
  const heading = document.createElement(tagName);
  heading.className = `${className} scroll-title`;
  const textNode = document.createElement("span");
  textNode.className = "scroll-title-text";
  textNode.textContent = text;
  heading.append(textNode);
  heading.title = text;
  globalThis.requestAnimationFrame(() => {
    const overflow = textNode.scrollWidth - heading.clientWidth;
    if (overflow > 12) {
      heading.dataset.marquee = "true";
      heading.style.setProperty("--marquee-distance", `${overflow}px`);
      const seconds = Math.max(6, Math.min(16, overflow / 18));
      heading.style.setProperty("--marquee-duration", `${seconds}s`);
    }
  });
  return heading;
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
