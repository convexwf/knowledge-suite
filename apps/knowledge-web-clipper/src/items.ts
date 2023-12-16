import { createKnowledgeApiClient } from "./api-client.js";
import {
  buildBatchDeletePlan,
  buildReaderListEntries,
  normalizeSourceFilter,
  ReaderListCollection,
  resolveCollectionShellsToDelete,
  SourceFilter
} from "./items-model.js";
import { getSettings, setActiveServerProfile } from "./settings.js";
import { hasServerProfileChange, renderServerProfileOptions } from "./server-profiles.js";
import { openKnowledgePage } from "./tabs.js";
import { parseGitHubMarkdownUrl } from "./github-markdown-url.js";
import {
  CollectionDetail,
  CollectionSummary,
  GitHubMarkdownRequest,
  GitHubMarkdownScanResult,
  KnowledgeItem,
  KnowledgeSourceType
} from "./types.js";
import {
  MarkdownDirectoryFiles,
  MarkdownDirectoryHandle,
  MarkdownImportScan,
  MarkdownSourceMode,
  readMarkdownDirectory,
  scanMarkdownImport
} from "./markdown-import.js";

interface DirectoryPickerWindow extends Window {
  showDirectoryPicker?: (options?: { mode?: "read" }) => Promise<MarkdownDirectoryHandle>;
}

const importForm = mustGet<HTMLFormElement>("import-form");
const fileInput = mustGet<HTMLInputElement>("epub-file");
const calibreFolderInput = mustGet<HTMLInputElement>("calibre-folder");
const titleHintInput = mustGet<HTMLInputElement>("title-hint");
const tagsInput = mustGet<HTMLInputElement>("tags-input");
const uploadButton = mustGet<HTMLButtonElement>("upload-button");
const statusOutput = mustGet<HTMLElement>("status-output");
const openImportButton = mustGet<HTMLButtonElement>("open-import");
const importDialog = mustGet<HTMLDialogElement>("import-dialog");
const importSourceType = mustGet<HTMLSelectElement>("import-source-type");
const epubImportConfig = mustGet<HTMLElement>("epub-import-config");
const markdownImportConfig = mustGet<HTMLElement>("markdown-import-config");
const githubMarkdownImportConfig = mustGet<HTMLElement>("github-markdown-import-config");
const markdownSourceMode = mustGet<HTMLSelectElement>("markdown-source-mode");
const markdownFileRow = mustGet<HTMLElement>("markdown-file-row");
const markdownFolderRow = mustGet<HTMLElement>("markdown-folder-row");
const markdownFileInput = mustGet<HTMLInputElement>("markdown-file");
const markdownFolderInput = mustGet<HTMLInputElement>("markdown-folder");
const markdownResourceFolderInput = mustGet<HTMLInputElement>("markdown-resource-folder");
const chooseMarkdownFolderButton = mustGet<HTMLButtonElement>("choose-markdown-folder");
const chooseMarkdownResourceFolderButton = mustGet<HTMLButtonElement>("choose-markdown-resource-folder");
const markdownFolderName = mustGet<HTMLElement>("markdown-folder-name");
const markdownResourceFolderName = mustGet<HTMLElement>("markdown-resource-folder-name");
const markdownTagsInput = mustGet<HTMLInputElement>("markdown-tags-input");
const markdownScanOutput = mustGet<HTMLElement>("markdown-scan-output");
const importCancelButton = mustGet<HTMLButtonElement>("import-cancel");
const markdownScanButton = mustGet<HTMLButtonElement>("markdown-scan");
const markdownImportButton = mustGet<HTMLButtonElement>("markdown-import");
const githubUrlInput = mustGet<HTMLInputElement>("github-url");
const githubTagsInput = mustGet<HTMLInputElement>("github-tags-input");
const githubScanOutput = mustGet<HTMLElement>("github-scan-output");
const githubScanButton = mustGet<HTMLButtonElement>("github-scan");
const githubImportButton = mustGet<HTMLButtonElement>("github-import");
const itemList = mustGet<HTMLElement>("item-list");
const refreshButton = mustGet<HTMLButtonElement>("refresh-items");
const settingsButton = mustGet<HTMLButtonElement>("open-settings");
const serverProfileSelect = mustGet<HTMLSelectElement>("server-profile");
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

let settings = await getSettings();
let client = createKnowledgeApiClient(settings);
const query = new URLSearchParams(globalThis.location.search);

let currentItems: KnowledgeItem[] = [];
let currentCollections: CollectionSummary[] = [];
let markdownScan: MarkdownImportScan | undefined;
let githubScan: GitHubMarkdownScanResult | undefined;
let markdownFolderHandle: MarkdownDirectoryHandle | undefined;
let markdownResourceFolderHandle: MarkdownDirectoryHandle | undefined;
let activeSourceFilter: SourceFilter = normalizeSourceFilter(query.get("source") ?? (query.get("collectionId") ? "collection" : "all"));
const focusCollectionId = query.get("collectionId") || "";
const collectionDetailCache = new Map<string, Promise<CollectionDetail>>();
let refreshGeneration = 0;
let profileReloadPromise: Promise<void> | undefined;

renderServerProfileOptions(serverProfileSelect, settings);

serverProfileSelect.addEventListener("change", () => {
  void switchServerProfile(serverProfileSelect.value);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && hasServerProfileChange(changes)) {
    void reloadServerProfile();
  }
});

settingsButton.addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
});

refreshButton.addEventListener("click", () => {
  void refreshItems();
});

importForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (importSourceType.value === "markdown") {
    void importMarkdownFiles();
  } else if (importSourceType.value === "github-markdown") {
    void importGitHubMarkdown();
  } else {
    void importEpub();
  }
});

openImportButton.addEventListener("click", () => {
  resetImportDialog();
  importDialog.showModal();
});

importSourceType.addEventListener("change", () => {
  updateImportSource();
});

chooseMarkdownFolderButton.addEventListener("click", () => {
  void chooseMarkdownDirectory("source");
});

chooseMarkdownResourceFolderButton.addEventListener("click", () => {
  void chooseMarkdownDirectory("resource");
});

markdownFolderInput.addEventListener("change", () => {
  markdownFolderHandle = undefined;
  updateMarkdownDirectoryNames();
  invalidateMarkdownScan();
});

markdownResourceFolderInput.addEventListener("change", () => {
  markdownResourceFolderHandle = undefined;
  updateMarkdownDirectoryNames();
  invalidateMarkdownScan();
});

markdownFileInput.addEventListener("change", () => {
  invalidateMarkdownScan();
});

importCancelButton.addEventListener("click", () => {
  importDialog.close();
});

markdownSourceMode.addEventListener("change", () => {
  updateMarkdownSourceMode();
  invalidateMarkdownScan();
});

markdownScanButton.addEventListener("click", () => {
  void scanMarkdownFiles();
});

githubScanButton.addEventListener("click", () => {
  void scanGitHubMarkdown();
});

for (const input of [githubUrlInput, githubTagsInput]) {
  input.addEventListener("input", invalidateGitHubScan);
}

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
updateMarkdownDirectoryPickerUI();
updateMarkdownDirectoryNames();
updateMarkdownSourceMode();
updateImportSource();
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
    importDialog.close();
    resetImportDialog();
    await refreshItems();
    openReader(result.knowledgeItem.itemId);
  } catch (error) {
    setStatus(errorMessage(error));
  } finally {
    uploadButton.disabled = false;
  }
}

async function scanMarkdownFiles(): Promise<void> {
  const mode = markdownSourceMode.value as MarkdownSourceMode;
  const sourceSelection = mode === "file"
    ? { files: Array.from(markdownFileInput.files ?? []), relativePaths: new Map<File, string>() }
    : await selectedMarkdownDirectory(markdownFolderHandle, markdownFolderInput);
  const resourceSelection = await selectedMarkdownDirectory(markdownResourceFolderHandle, markdownResourceFolderInput);
  const sourceFiles = sourceSelection.files;
  const resourceFiles = resourceSelection.files;
  if (sourceFiles.length === 0) {
    markdownScanOutput.textContent = mode === "file"
      ? "Choose a Markdown file first."
      : "Choose a Markdown folder first.";
    markdownImportButton.disabled = true;
    return;
  }

  markdownScanButton.disabled = true;
  markdownImportButton.disabled = true;
  try {
    markdownScanOutput.textContent = "Scanning Markdown files and resource metadata...";
    markdownScan = await scanMarkdownImport({
      mode,
      sourceFiles,
      resourceFiles,
      sourceRelativePaths: sourceSelection.relativePaths,
      resourceRelativePaths: resourceSelection.relativePaths,
      onProgress: (current, total) => {
        markdownScanOutput.textContent = `Scanning ${current}/${total} Markdown file(s)...`;
      }
    });
    renderMarkdownScan(markdownScan);
    markdownImportButton.disabled = markdownScan.documents.length === 0;
  } catch (error) {
    markdownScan = undefined;
    markdownScanOutput.textContent = errorMessage(error);
  } finally {
    markdownScanButton.disabled = false;
  }
}

async function chooseMarkdownDirectory(kind: "source" | "resource"): Promise<void> {
  const picker = (globalThis as unknown as DirectoryPickerWindow).showDirectoryPicker;
  if (!picker) {
    (kind === "source" ? markdownFolderInput : markdownResourceFolderInput).click();
    return;
  }

  try {
    const handle = await picker({ mode: "read" });
    if (kind === "source") {
      markdownFolderHandle = handle;
      markdownFolderInput.value = "";
    } else {
      markdownResourceFolderHandle = handle;
      markdownResourceFolderInput.value = "";
    }
    updateMarkdownDirectoryNames();
    invalidateMarkdownScan();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    markdownScanOutput.textContent = errorMessage(error);
  }
}

async function selectedMarkdownDirectory(
  handle: MarkdownDirectoryHandle | undefined,
  fallbackInput: HTMLInputElement
): Promise<MarkdownDirectoryFiles> {
  if (handle) return readMarkdownDirectory(handle);
  return {
    files: Array.from(fallbackInput.files ?? []),
    relativePaths: new Map<File, string>()
  };
}

function invalidateMarkdownScan(): void {
  markdownScan = undefined;
  markdownImportButton.disabled = true;
}

function resetImportDialog(): void {
  importForm.reset();
  markdownFolderHandle = undefined;
  markdownResourceFolderHandle = undefined;
  markdownScan = undefined;
  githubScan = undefined;
  markdownScanOutput.textContent = "Choose a source and scan before importing.";
  githubScanOutput.textContent = "Paste a GitHub URL and scan before importing.";
  updateMarkdownDirectoryNames();
  updateMarkdownSourceMode();
  updateImportSource();
}

function updateImportSource(): void {
  const epub = importSourceType.value === "epub";
  const markdown = importSourceType.value === "markdown";
  const githubMarkdown = importSourceType.value === "github-markdown";
  epubImportConfig.hidden = !epub;
  markdownImportConfig.hidden = !markdown;
  githubMarkdownImportConfig.hidden = !githubMarkdown;
  uploadButton.hidden = markdown || githubMarkdown;
  markdownScanButton.hidden = !markdown;
  markdownImportButton.hidden = !markdown;
  githubScanButton.hidden = !githubMarkdown;
  githubImportButton.hidden = !githubMarkdown;
  if (markdown) {
    markdownImportButton.disabled = !markdownScan || markdownScan.documents.length === 0;
  } else if (githubMarkdown) {
    githubImportButton.disabled = !githubScan || githubScan.files.length === 0;
  } else {
    uploadButton.disabled = false;
  }
}

function updateMarkdownDirectoryPickerUI(): void {
  const supported = typeof (globalThis as unknown as DirectoryPickerWindow).showDirectoryPicker === "function";
  chooseMarkdownFolderButton.hidden = !supported;
  chooseMarkdownResourceFolderButton.hidden = !supported;
  markdownFolderInput.hidden = supported;
  markdownResourceFolderInput.hidden = supported;
}

function updateMarkdownDirectoryNames(): void {
  markdownFolderName.textContent = markdownFolderHandle?.name
    ?? selectedFileCountLabel(markdownFolderInput, "No folder selected");
  markdownResourceFolderName.textContent = markdownResourceFolderHandle?.name
    ?? selectedFileCountLabel(markdownResourceFolderInput, "No resource folder selected");
}

function selectedFileCountLabel(input: HTMLInputElement, emptyLabel: string): string {
  const count = input.files?.length ?? 0;
  return count > 0 ? `${count} file(s) selected` : emptyLabel;
}

async function importMarkdownFiles(): Promise<void> {
  if (!markdownScan) {
    markdownScanOutput.textContent = "Run Scan before importing.";
    markdownImportButton.disabled = true;
    return;
  }
  if (markdownScan.documents.length === 0) return;

  markdownImportButton.disabled = true;
  markdownScanButton.disabled = true;
  const documents = markdownScan.documents;
  const tags = parseTags(markdownTagsInput.value);
  let succeeded = 0;
  const failures: string[] = [];
  let firstItemId: string | undefined;
  try {
    for (let index = 0; index < documents.length; index += 1) {
      const document = documents[index];
      markdownScanOutput.textContent = `Importing ${index + 1}/${documents.length}: ${document.file.name}`;
      try {
        const result = await client.importMarkdown({
          file: document.file,
          sourceUri: document.sourceUri,
          relativePath: document.relativePath,
          tags,
          assets: document.assets
        });
        succeeded += 1;
        firstItemId ??= result.knowledgeItem.itemId;
      } catch (error) {
        failures.push(`${document.file.name}: ${errorMessage(error)}`);
      }
    }
    const warningCount = documents.reduce((sum, document) => sum + document.warnings.length, 0);
    const summary = `Imported ${succeeded}/${documents.length} Markdown file(s).${warningCount ? ` ${warningCount} warning(s).` : ""}${failures.length ? ` ${failures.length} failed.` : ""}`;
    markdownScanOutput.textContent = [...[summary], ...failures].join("\n");
    setStatus(summary);
    importDialog.close();
    resetImportDialog();
    await refreshItems();
    if (firstItemId && documents.length === 1 && failures.length === 0) {
      openReader(firstItemId);
    }
  } finally {
    markdownImportButton.disabled = false;
    markdownScanButton.disabled = false;
  }
}

async function scanGitHubMarkdown(): Promise<void> {
  if (!githubUrlInput.value.trim()) {
    githubScanOutput.textContent = "Paste a GitHub Markdown URL first.";
    githubImportButton.disabled = true;
    return;
  }
  githubScanButton.disabled = true;
  githubImportButton.disabled = true;
  try {
    const request = githubMarkdownRequest();
    if (!request) {
      githubScanOutput.textContent = "Paste a GitHub Markdown URL first.";
      return;
    }
    githubScanOutput.textContent = "Scanning GitHub Markdown and image metadata...";
    githubScan = await client.scanGitHubMarkdown(request);
    renderGitHubScan(githubScan);
    githubImportButton.disabled = githubScan.files.length === 0;
  } catch (error) {
    githubScan = undefined;
    githubScanOutput.textContent = errorMessage(error);
  } finally {
    githubScanButton.disabled = false;
  }
}

async function importGitHubMarkdown(): Promise<void> {
  githubScanButton.disabled = true;
  githubImportButton.disabled = true;
  try {
    const request = githubMarkdownRequest();
    if (!request || !githubScan) {
      githubScanOutput.textContent = request ? "Run Scan before importing." : "Paste a valid GitHub Markdown URL first.";
      return;
    }
    githubScanOutput.textContent = "Importing GitHub Markdown...";
    const result = await client.importGitHubMarkdown(request);
    const succeeded = result.results.filter((item) => item.saved).length;
    const failed = result.results.length - succeeded;
    const warnings = result.results.reduce((sum, item) => sum + (item.warnings?.length ?? 0), 0);
    const summary = `Imported ${succeeded}/${result.results.length} GitHub Markdown file(s).${warnings ? ` ${warnings} warning(s).` : ""}${failed ? ` ${failed} failed.` : ""}`;
    githubScanOutput.textContent = [summary, ...result.results.filter((item) => item.error).map((item) => `${item.path}: ${item.error}`)].join("\n");
    setStatus(summary);
    const firstItem = result.results.find((item) => item.saved && item.knowledgeItem);
    importDialog.close();
    resetImportDialog();
    await refreshItems();
    if (firstItem?.knowledgeItem && result.results.length === 1 && failed === 0) {
      openReader(firstItem.knowledgeItem.itemId);
    }
  } catch (error) {
    githubScanOutput.textContent = errorMessage(error);
  } finally {
    githubScanButton.disabled = false;
    githubImportButton.disabled = false;
  }
}

function githubMarkdownRequest(): GitHubMarkdownRequest | undefined {
  const parsed = parseGitHubMarkdownUrl(githubUrlInput.value);
  if (!parsed) return undefined;
  return { ...parsed, tags: parseTags(githubTagsInput.value) };
}

function invalidateGitHubScan(): void {
  githubScan = undefined;
  githubImportButton.disabled = true;
  githubScanOutput.textContent = "GitHub URL or tags changed. Run Scan again.";
}

function renderGitHubScan(scan: GitHubMarkdownScanResult): void {
  const imageCount = scan.files.reduce((sum, file) => sum + file.referencedAssetCount, 0);
  const lines = [
    `Source: ${scan.owner}/${scan.repo}@${scan.ref}:${scan.path}`,
    `Resolved commit: ${scan.commitSha.slice(0, 12)}`,
    `Markdown files: ${scan.files.length}`,
    `Referenced images: ${imageCount}`,
    `Image delivery: ${scan.private ? "server proxy" : "raw URL"}`
  ];
  if (scan.warnings.length > 0) {
    lines.push("", ...scan.warnings.slice(0, 12));
    if (scan.warnings.length > 12) lines.push(`... and ${scan.warnings.length - 12} more warning(s)`);
  }
  githubScanOutput.textContent = lines.join("\n");
}

function renderMarkdownScan(scan: MarkdownImportScan): void {
  const lines = [
    `Markdown files: ${scan.markdownCount}`,
    `Local image references: ${scan.referencedAssetCount}`,
    `Matched local assets: ${scan.matchedAssetCount}`,
    `Missing local assets: ${scan.missingAssetCount}`,
    `Ignored files: ${scan.ignoredCount}`
  ];
  if (scan.warnings.length > 0) {
    lines.push("", ...scan.warnings.slice(0, 12));
    if (scan.warnings.length > 12) lines.push(`... and ${scan.warnings.length - 12} more warning(s)`);
  }
  markdownScanOutput.textContent = lines.join("\n");
}

function updateMarkdownSourceMode(): void {
  const folderMode = markdownSourceMode.value === "folder";
  markdownFileRow.hidden = folderMode;
  markdownFolderRow.hidden = !folderMode;
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
  const generation = ++refreshGeneration;
  const requestClient = client;
  const requestLimit = settings.savedListLimit;
  refreshButton.disabled = true;
  itemList.replaceChildren(loadingNode());
  collectionDetailCache.clear();
  try {
    const sourceType = activeSourceFilter !== "all" && activeSourceFilter !== "collection"
      ? activeSourceFilter as KnowledgeSourceType
      : undefined;
    const [result, collectionsResult] = await Promise.all([
      requestClient.listItems(sourceType, requestLimit),
      requestClient.listCollections()
    ]);
    if (generation !== refreshGeneration) return;
    currentCollections = collectionsResult.collections;
    currentItems = await hydrateCollectionIds(result.items, requestClient);
    if (generation !== refreshGeneration) return;
    renderItems(currentItems);
  } catch (error) {
    if (generation !== refreshGeneration) return;
    itemList.replaceChildren(emptyNode(errorMessage(error)));
  } finally {
    if (generation === refreshGeneration) {
      refreshButton.disabled = false;
    }
  }
}

async function switchServerProfile(profileId: string): Promise<void> {
  serverProfileSelect.disabled = true;
  try {
    await setActiveServerProfile(profileId);
    await reloadServerProfile();
  } catch (error) {
    setStatus(errorMessage(error));
    renderServerProfileOptions(serverProfileSelect, settings);
  } finally {
    serverProfileSelect.disabled = false;
  }
}

async function reloadServerProfile(): Promise<void> {
  if (profileReloadPromise) return profileReloadPromise;
  profileReloadPromise = reloadServerProfileInternal();
  try {
    await profileReloadPromise;
  } finally {
    profileReloadPromise = undefined;
  }
}

async function reloadServerProfileInternal(): Promise<void> {
  const previousProfile = settings.profiles.find((profile) => profile.id === settings.activeProfileId);
  const previousSignature = previousProfile
    ? `${previousProfile.id}\u0000${previousProfile.serverUrl}\u0000${previousProfile.token}`
    : "";
  settings = await getSettings();
  client = createKnowledgeApiClient(settings);
  renderServerProfileOptions(serverProfileSelect, settings);
  const activeProfile = settings.profiles.find((profile) => profile.id === settings.activeProfileId);
  const nextSignature = activeProfile
    ? `${activeProfile.id}\u0000${activeProfile.serverUrl}\u0000${activeProfile.token}`
    : "";
  if (previousSignature === nextSignature) return;
  currentItems = [];
  currentCollections = [];
  collectionDetailCache.clear();
  renderFilterBar();
  await refreshItems();
}

async function hydrateCollectionIds(items: KnowledgeItem[], requestClient = client): Promise<KnowledgeItem[]> {
  return Promise.all(items.map(async (item) => {
    try {
      const detail = await requestClient.item(item.itemId);
      return { ...item, collectionIds: detail.collectionIds ?? [] };
    } catch {
      return { ...item, collectionIds: [] };
    }
  }));
}

function renderItems(items: KnowledgeItem[]): void {
  currentItems = items;
  const entries = buildReaderListEntries({
    items,
    collections: currentCollections,
    sourceFilter: activeSourceFilter
  });
  renderOverview(entries);
  itemList.replaceChildren();

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
    { value: "markdown", label: "Markdown" },
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
      const url = new URL(globalThis.location.href);
      if (activeSourceFilter === "all") {
        url.searchParams.delete("source");
      } else {
        url.searchParams.set("source", activeSourceFilter);
      }
      globalThis.history.replaceState(null, "", url);
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
  creator.textContent = "Collection of saved pages";
  const meta = document.createElement("div");
  meta.className = "item-summary-line";
  meta.textContent = `${collection.itemCount} page${collection.itemCount === 1 ? "" : "s"} · Updated ${formatDate(collection.updatedAt)}`;
  body.append(kickerRow, title, creator, meta);

  const actions = document.createElement("div");
  actions.className = "item-actions";
  const details = collectionDetails(collection);
  details.hidden = true;
  const detailsButton = button("i", "info-button", () => {
    details.hidden = !details.hidden;
    detailsButton.setAttribute("aria-expanded", String(!details.hidden));
  });
  detailsButton.title = "Collection details";
  detailsButton.setAttribute("aria-label", "Collection details");
  detailsButton.setAttribute("aria-expanded", "false");
  const members = document.createElement("div");
  members.className = "item-details collection-members";
  members.hidden = true;

  const readButton = button("Read", "primary-button", () => {
    void openCollectionFirstItem(collection.collectionId);
  });
  readButton.classList.add("collection-read-button");

  const itemsButton = button("Items", "", () => {
    members.hidden = !members.hidden;
    itemsButton.setAttribute("aria-expanded", String(!members.hidden));
    if (!members.hidden) {
      void loadCollectionMembers(collection.collectionId, members, checkbox.checked);
    }
  });
  itemsButton.classList.add("collection-items-button", "item-slot-button");
  itemsButton.setAttribute("aria-expanded", "false");

  const more = collectionMoreMenu(collection);
  more.classList.add("collection-more-menu");
  actions.classList.add("collection-actions");
  actions.append(detailsButton, readButton, itemsButton, more);
  row.append(checkbox, avatar, body, actions, details, members);

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
    void openKnowledgePage(`annotations.html?itemId=${encodeURIComponent(item.itemId)}`);
  });
  annotateButton.classList.add("item-slot-button");
  annotateButton.disabled = !item.activeDocId;

  const more = itemMoreMenu(item);
  actions.append(detailsButton, readButton, annotateButton, more);
  row.append(checkbox, avatar, body, actions, details);
  return row;
}

function renderOverview(entries: ReturnType<typeof buildReaderListEntries>): void {
  const latest = entries
    .map((entry) => ({ entry, time: Date.parse(entry.updatedAt) }))
    .filter((entry) => !Number.isNaN(entry.time))
    .sort((left, right) => right.time - left.time)[0]?.entry;
  const collectionCount = entries.filter((entry) => entry.kind === "collection").length;
  const standaloneCount = entries.filter((entry) => entry.kind === "standalone").length;
  const visibleTotal = entries.length;

  // Total documents: standalone docs + items nested inside collections
  const totalCollectionItems = entries
    .filter((entry): entry is ReaderListCollection => entry.kind === "collection")
    .reduce((sum, c) => sum + c.itemCount, 0);
  const totalDocs = standaloneCount + totalCollectionItems;

  // Card 1 (Library): source-type breakdown, omit zero-count types
  const breakdown: string[] = [];
  const web = entries.filter((entry) => entry.kind === "standalone" && (entry.sourceType === "url" || entry.sourceType === "singlefile_html")).length;
  const epub = entries.filter((entry) => entry.kind === "standalone" && entry.sourceType === "epub").length;
  const pdf = entries.filter((entry) => entry.kind === "standalone" && entry.sourceType === "pdf").length;
  const markdown = entries.filter((entry) => entry.kind === "standalone" && entry.sourceType === "markdown").length;
  if (web > 0) breakdown.push(`${web} web`);
  if (epub > 0) breakdown.push(`${epub} epub`);
  if (pdf > 0) breakdown.push(`${pdf} pdf`);
  if (markdown > 0) breakdown.push(`${markdown} markdown`);
  if (collectionCount > 0) breakdown.push(`${collectionCount} collection${collectionCount !== 1 ? "s" : ""}`);

  // Card 2 (Reader Ready): total document count with breakdown
  const detailParts: string[] = [];
  if (standaloneCount > 0) detailParts.push(`${standaloneCount} standalone`);
  if (collectionCount > 0) {
    const word = collectionCount === 1 ? "collection" : "collections";
    detailParts.push(`${totalCollectionItems} from ${collectionCount} ${word}`);
  }

  overviewTotal.textContent = String(visibleTotal);
  overviewParsed.textContent = String(totalDocs);
  overviewLatest.textContent = latest ? formatShortDate(latest.updatedAt) : "-";
  overviewTotalDetail.textContent = visibleTotal === 0
    ? "No cards match the current source filter."
    : breakdown.join(" · ") + ".";
  overviewParsedDetail.textContent = detailParts.length > 0
    ? detailParts.join(", ") + "."
    : "No items yet.";
  overviewLatestDetail.textContent = latest
    ? `${latest.kind === "collection" ? latest.title : displayTitle(latest)} was updated most recently.`
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

function collectionDetails(collection: ReaderListCollection): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "item-details";
  const table = document.createElement("table");
  table.append(
    detailsRow("Title", collection.title),
    detailsRow("State", collection.state),
    detailsRow("Source", "COLLECTION"),
    detailsRow("Pages", String(collection.itemCount)),
    detailsRow("Root URL", collection.rootUrl || "-"),
    detailsRow("Collection ID", collection.collectionId),
    detailsRow("Created", formatDate(collection.createdAt)),
    detailsRow("Updated", formatDate(collection.updatedAt))
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
    actionButton("Reparse", !["pdf", "epub", "markdown"].includes(item.sourceType), async () => reparseItem(item.itemId), menu),
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
  const first = detail.items.find((item) => item.itemId);
  if (!first) return;
  openReader(first.itemId!);
}

async function operateOnCollection(collectionId: string, mode: "reparse" | "remove" | "purge"): Promise<void> {
  collectionDetailCache.delete(collectionId);
  const itemIds = await resolveCollectionItemIds(collectionId);
  if (itemIds.length === 0) {
    if (mode === "purge") {
      const result = await client.deleteCollection(collectionId);
      setStatus(result.deleted ? "Purged empty collection shell." : "Collection no longer exists.");
      await refreshItems();
      return;
    }
    setStatus("This collection has no reader items yet.");
    return;
  }
  if (mode === "reparse") {
    await performBatchReparse(itemIds, `Reparsing collection (${itemIds.length} item(s))...`);
    return;
  }
  const result = await performBatchDelete(
    itemIds,
    mode,
    `${mode === "purge" ? "Purge" : "Remove"} this collection's ${itemIds.length} item(s)?`
  );
  if (mode === "purge" && result.ok === itemIds.length) {
    try {
      const deleteResult = await client.deleteCollection(collectionId);
      if (deleteResult.deleted) {
        setStatus(`Purged ${result.ok}/${itemIds.length} item(s) and removed the collection shell.`);
        await refreshItems();
      }
    } catch (error) {
      setStatus(`Purged items, but failed to remove the collection shell: ${errorMessage(error)}`);
      await refreshItems();
    }
  }
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
  const ids = (await resolveBatchDeletePlan()).itemIds;
  if (ids.length === 0) return;
  await performBatchReparse(ids, `Reparsing ${ids.length} selected item(s)...`);
}

async function batchDelete(mode: "remove" | "purge"): Promise<void> {
  const plan = await resolveBatchDeletePlan();
  if (plan.itemIds.length === 0 && plan.collectionTargets.length === 0) return;
  if (mode === "purge" && plan.itemIds.length === 0) {
    if (!globalThis.confirm(`Purge ${plan.collectionTargets.length} selected empty collection shell(s)?`)) return;
    let deleted = 0;
    for (const target of plan.collectionTargets) {
      try {
        const deleteResult = await client.deleteCollection(target.collectionId);
        if (deleteResult.deleted) deleted += 1;
      } catch (error) {
        setStatus(`Failed to remove empty collection shell ${target.collectionId}: ${errorMessage(error)}`);
      }
    }
    setStatus(`Purged ${deleted}/${plan.collectionTargets.length} empty collection shell(s).`);
    await refreshItems();
    return;
  }
  const result = await performBatchDelete(
    plan.itemIds,
    mode,
    `${mode === "purge" ? "Purge" : "Remove"} ${plan.itemIds.length} selected item(s)?`
  );
  if (mode !== "purge" || result.cancelled) return;

  const collectionIds = resolveCollectionShellsToDelete(plan.collectionTargets, result.successIds);
  if (collectionIds.length === 0) return;

  let deleted = 0;
  for (const collectionId of collectionIds) {
    try {
      const deleteResult = await client.deleteCollection(collectionId);
      if (deleteResult.deleted) deleted += 1;
    } catch (error) {
      setStatus(`Purged items, but failed to remove collection shell ${collectionId}: ${errorMessage(error)}`);
    }
  }
  if (deleted > 0) {
    setStatus(`Purged ${result.ok}/${plan.itemIds.length} item(s) and removed ${deleted} collection shell(s).`);
    await refreshItems();
  }
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
): Promise<{ ok: number; cancelled: boolean; successIds: Set<string> }> {
  if (!globalThis.confirm(confirmMessage)) return { ok: 0, cancelled: true, successIds: new Set<string>() };
  const verb = mode === "purge" ? "Purge" : "Remove";
  setStatus(`${verb.toLowerCase()}ing ${singularLabel ?? `${ids.length} item(s)`}...`);
  let ok = 0;
  const successIds = new Set<string>();
  for (const id of ids) {
    try {
      await client.deleteItem(id, mode);
      ok += 1;
      successIds.add(id);
    } catch (error) {
      setStatus(`${verb} failed for ${id}: ${errorMessage(error)}`);
    }
  }
  setStatus(`${verb}d ${ok}/${ids.length} item(s).`);
  await refreshItems();
  return { ok, cancelled: false, successIds };
}

async function resolveBatchDeletePlan(): Promise<ReturnType<typeof buildBatchDeletePlan>> {
  const selections = selectedSelections();
  const collectionItemsById: Record<string, string[]> = {};
  const collectionIds = [...new Set(selections.map((selection) => selection.collectionId).filter((value): value is string => Boolean(value)))];

  for (const collectionId of collectionIds) {
    collectionDetailCache.delete(collectionId);
    collectionItemsById[collectionId] = await resolveCollectionItemIds(collectionId);
  }

  return buildBatchDeletePlan(selections, collectionItemsById);
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
      return "Web Page";
    case "epub":
      return "EPUB";
    case "pdf":
      return "PDF";
    case "markdown":
      return "Markdown";
    case "singlefile_html":
      return "Web Page";
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
    case "markdown":
      return "MD";
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
