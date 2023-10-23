import { createKnowledgeApiClient } from "./api-client.js";
import { renderMarkdownPreview } from "./markdown-preview/render.js";
import { getSettings, saveSettings } from "./settings.js";
import {
  ActiveTabInfo,
  BatchCandidate,
  BatchDiscoverItem,
  BatchDiscoverResult,
  BatchJobResult,
  CandidatePreview,
  ClipDeleteMode,
  ClipListItem,
  ClipRequestBody,
  ClipSaveRequestBody,
  ExtensionSettings,
  InputMode,
  PanelView,
  PageSnapshot,
  PreviewResult
} from "./types.js";

const previewOutput = mustGet<HTMLElement>("preview-output");
const codeOutput = mustGet<HTMLPreElement>("code-output");
const rawdocOutput = mustGet<HTMLPreElement>("rawdoc-output");
const parserOutput = mustGet<HTMLDivElement>("parser-output");
const statusPill = mustGet<HTMLElement>("status-pill");
const statusDetail = mustGet<HTMLElement>("status-detail");
const pageTitleEl = mustGet<HTMLElement>("page-title");
const pageUrlEl = mustGet<HTMLElement>("page-url");
const pageOriginEl = mustGet<HTMLElement>("page-origin");
const pageStateEl = mustGet<HTMLElement>("page-state");
const autoRefreshInput = mustGet<HTMLInputElement>("auto-refresh");
const moreMenu = mustGet<HTMLDetailsElement>("more-menu");
const settingsButton = mustGet<HTMLButtonElement>("settings-button");
const refreshButton = mustGet<HTMLButtonElement>("refresh-button");
const saveButton = mustGet<HTMLButtonElement>("save-button");
const saveSectionButton = mustGet<HTMLButtonElement>("save-section-button");
const diagnosticsButton = mustGet<HTMLButtonElement>("diagnostics-button");
const copyButton = mustGet<HTMLButtonElement>("copy-button");
const removeButton = mustGet<HTMLButtonElement>("remove-button");
const purgeButton = mustGet<HTMLButtonElement>("purge-button");
const modeBrowserButton = mustGet<HTMLButtonElement>("mode-browser");
const modeFetchButton = mustGet<HTMLButtonElement>("mode-fetch");
const diagnosticsToggleRow = mustGet<HTMLElement>("diagnostics-toggle-row");
const diagnosticsToggleButton = mustGet<HTMLButtonElement>("diagnostics-toggle");
const diagnosticsTabs = mustGet<HTMLElement>("diagnostics-tabs");
const tabPreviewButton = mustGet<HTMLButtonElement>("tab-preview");
const tabJsonButton = mustGet<HTMLButtonElement>("tab-json");
const tabRawdocButton = mustGet<HTMLButtonElement>("tab-rawdoc");
const tabParserButton = mustGet<HTMLButtonElement>("tab-parser");
const tabSavedButton = mustGet<HTMLButtonElement>("tab-saved");
const tabBatchButton = mustGet<HTMLButtonElement>("tab-batch");
const candidateControl = mustGet<HTMLElement>("candidate-control");
const candidateSelect = mustGet<HTMLSelectElement>("candidate-select");
const savedList = mustGet<HTMLDivElement>("saved-list");
const batchOutput = mustGet<HTMLDivElement>("batch-output");

let settings: ExtensionSettings = await getSettings();
let activeTab: ActiveTabInfo | undefined;
let lastPreview: PreviewResult | undefined;
let activeCandidateId: string | undefined;
let savedClips: ClipListItem[] = [];
let batchDiscover: BatchDiscoverResult | undefined;
let batchJob: BatchJobResult | undefined;
let batchPollTimer: number | undefined;

let currentInputMode: InputMode = settings.defaultInputMode;
let activeView: PanelView = settings.defaultPanelTab;
let lastPrimaryView: "preview" | "saved" = activeView === "saved" ? "saved" : "preview";
let diagnosticsExpanded = isDiagnosticsView(activeView);
let autoRefreshTimer: number | undefined;
let pendingAction: "batch" | "delete" | "preview" | "save" | undefined;

autoRefreshInput.checked = settings.autoRefresh;
applySettingsToUi();
setMode(currentInputMode, false);
setView(activeView, false);
await refreshActiveTab();
await preview();
updateActionButtons();

refreshButton.addEventListener("click", () => preview());
settingsButton.addEventListener("click", () => {
  closeMoreMenu();
  chrome.runtime.openOptionsPage();
});
saveButton.addEventListener("click", () => save());
saveSectionButton.addEventListener("click", () => {
  closeMoreMenu();
  void discoverSection();
});
diagnosticsButton.addEventListener("click", () => {
  closeMoreMenu();
  diagnosticsExpanded = true;
  setView(settings.showParserDiagnostics ? "parser" : "json", true);
});
copyButton.addEventListener("click", () => {
  closeMoreMenu();
  void copyMarkdown();
});
removeButton.addEventListener("click", () => {
  closeMoreMenu();
  void deleteCurrentClip("remove");
});
purgeButton.addEventListener("click", () => {
  closeMoreMenu();
  void deleteCurrentClip("purge");
});
modeBrowserButton.addEventListener("click", () => setMode("browser_html"));
modeFetchButton.addEventListener("click", () => setMode("server_fetch"));
diagnosticsToggleButton.addEventListener("click", () => toggleDiagnostics());
tabPreviewButton.addEventListener("click", () => setView("preview", true));
tabJsonButton.addEventListener("click", () => setView("json", true));
tabRawdocButton.addEventListener("click", () => setView("rawdoc", true));
tabParserButton.addEventListener("click", () => setView("parser", true));
tabSavedButton.addEventListener("click", () => setView("saved", true));
tabBatchButton.addEventListener("click", () => setView("batch", true));
candidateSelect.addEventListener("change", () => {
  activeCandidateId = candidateSelect.value;
  renderOutput();
});
autoRefreshInput.addEventListener("change", () => persistPanelSettings());
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && hasSettingsChange(changes)) {
    void reloadSettings();
  }
});
chrome.tabs.onActivated.addListener(() => scheduleAutoRefresh());
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.status === "complete" || changeInfo.url) {
    scheduleAutoRefresh();
  }
});

async function refreshActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) {
    activeTab = undefined;
    lastPreview = undefined;
    activeCandidateId = undefined;
    updatePageHeader();
    return;
  }

  const previousUrl = activeTab?.url;
  activeTab = {
    tabId: tab.id,
    url: tab.url,
    title: tab.title,
    isFileUrl: tab.url.startsWith("file://")
  };
  if (previousUrl && previousUrl !== tab.url) {
    lastPreview = undefined;
    activeCandidateId = undefined;
  }
  updatePageHeader();

  if (activeTab.isFileUrl) {
    setMode("browser_html", false);
    modeFetchButton.disabled = true;
  } else {
    modeFetchButton.disabled = !settings.allowServerFetch;
  }
  updateActionButtons();
}

async function preview(): Promise<void> {
  await refreshActiveTab();
  if (!activeTab) {
    return;
  }
  if (pendingAction) {
    return;
  }

  pendingAction = "preview";
  updateActionButtons();
  setStatus("Previewing");
  try {
    await refreshServerStatus();
    const body = await buildRequestBody();
    const nextPreview = await createKnowledgeApiClient(settings).preview(body);
    setLastPreview(nextPreview);
    setStatus(statusLabel(nextPreview.status));
    renderOutput();
    updateActionButtons();
    if (nextPreview.status.state !== "empty") {
      void loadSavedClips();
    }
  } catch (error) {
    setStatus("Error");
    renderError(error);
  } finally {
    pendingAction = undefined;
    updateActionButtons();
  }
}

async function save(): Promise<void> {
  if (!activeTab) {
    return;
  }
  if (pendingAction === "save") {
    setStatus("Saving", "A save request is already running.");
    return;
  }
  if (pendingAction) {
    setStatus("Busy", "Wait for the current request to finish.");
    return;
  }

  const previousStatus = lastPreview?.status;
  pendingAction = "save";
  updateActionButtons();
  setStatus("Saving");
  try {
    await refreshServerStatus();
    const body = await buildSaveRequestBody();
    const nextPreview = await createKnowledgeApiClient(settings).save(body);
    setLastPreview(nextPreview);
    await loadSavedClips();
    await notifyBadgeRefresh();
    setStatus("Saved", summarizeSave(previousStatus, nextPreview));
    renderOutput();
  } catch (error) {
    setStatus("Error");
    renderError(error);
  } finally {
    pendingAction = undefined;
    updateActionButtons();
  }
}

async function discoverSection(): Promise<void> {
  await refreshActiveTab();
  if (!activeTab || activeTab.isFileUrl) {
    setStatus("Unavailable", "Batch section save only supports http(s) pages.");
    return;
  }
  if (pendingAction) {
    setStatus("Busy", "Wait for the current request to finish.");
    return;
  }

  pendingAction = "batch";
  updateActionButtons();
  setStatus("Discovering", "Scanning this page for navigation links.");
  try {
    await refreshServerStatus();
    const discovered = await collectNavigationLinks();
    if (discovered.candidates.length === 0) {
      batchDiscover = undefined;
      setView("batch", false);
      renderBatchOutput();
      setStatus("No links", "No sidebar or navigation links were found.");
      return;
    }
    batchDiscover = await createKnowledgeApiClient(settings).discoverBatch(discovered.pageUrl, discovered.candidates);
    batchJob = undefined;
    setView("batch", true);
    setStatus("Ready", `${batchDiscover.items.filter((item) => item.selectedByDefault).length} pages selected for this section.`);
  } catch (error) {
    setStatus("Error");
    renderError(error);
  } finally {
    pendingAction = undefined;
    updateActionButtons();
  }
}

async function startBatchJob(): Promise<void> {
  if (!activeTab || !batchDiscover) {
    return;
  }
  const selected = selectedBatchItems();
  if (selected.length === 0) {
    setStatus("Nothing selected", "Select at least one page to save.");
    return;
  }
  pendingAction = "batch";
  updateActionButtons();
  setStatus("Starting", "Creating collection and batch job.");
  try {
    batchJob = await createKnowledgeApiClient(settings).createBatchJob({
      sourcePageUrl: activeTab.url,
      collection: {
        title: collectionTitle(),
        rootUrl: activeTab.url,
        strategy: "create"
      },
      items: selected.map((item, index) => ({
        url: item.url,
        titleHint: item.titleHint,
        source: item.source,
        order: index,
        depth: item.depth
      }))
    });
    renderBatchOutput();
    setStatus("Running", `Saving ${batchJob.total} pages into a collection.`);
    pollBatchJob(batchJob.jobId);
  } catch (error) {
    setStatus("Error");
    renderError(error);
  } finally {
    pendingAction = undefined;
    updateActionButtons();
  }
}

async function collectNavigationLinks(): Promise<{ pageUrl: string; title?: string; candidates: BatchCandidate[] }> {
  if (!activeTab) {
    throw new Error("No active tab");
  }
  return chrome.tabs.sendMessage(activeTab.tabId, {
    type: "knowledge.discoverLinks"
  }).catch(async (error) => {
    if (!isMissingContentScriptError(error)) {
      throw error;
    }
    await injectContentScript(activeTab!.tabId);
    return chrome.tabs.sendMessage(activeTab!.tabId, {
      type: "knowledge.discoverLinks"
    });
  });
}

function pollBatchJob(jobId: string): void {
  window.clearTimeout(batchPollTimer);
  batchPollTimer = window.setTimeout(async () => {
    try {
      batchJob = await createKnowledgeApiClient(settings).batchJob(jobId);
      renderBatchOutput();
      const done = batchJob.saved + batchJob.skipped + batchJob.failed + batchJob.cancelled;
      setStatus(
        batchJob.state === "succeeded" ? "Batch complete" : "Running",
        `${done} / ${batchJob.total} pages finished.`
      );
      if (batchJob.state === "queued" || batchJob.state === "running") {
        pollBatchJob(jobId);
      } else {
        await loadSavedClips();
        await notifyBadgeRefresh();
      }
    } catch (error) {
      setStatus("Error", error instanceof Error ? error.message : String(error));
    }
  }, 1000);
}

async function copyMarkdown(): Promise<void> {
  const markdown = lastPreview ? activeCandidate(lastPreview)?.markdown ?? lastPreview.markdown : "";
  if (!markdown) {
    setStatus("Nothing to copy", "Preview or save a page first.");
    return;
  }

  await navigator.clipboard.writeText(markdown);
  setStatus("Copied", "Markdown copied to your clipboard.");
}

async function deleteCurrentClip(mode: ClipDeleteMode): Promise<void> {
  await refreshActiveTab();
  if (!activeTab) {
    return;
  }
  if (pendingAction) {
    setStatus("Busy", "Wait for the current request to finish.");
    return;
  }

  if (mode === "remove" && lastPreview?.status.state !== "parsed") {
    setStatus("Nothing to remove", "This page does not have an active parsed document.");
    updateActionButtons();
    return;
  }
  if (mode === "purge" && lastPreview?.status.state === "empty") {
    setStatus("Nothing to purge", "This page is not stored yet.");
    updateActionButtons();
    return;
  }

  pendingAction = "delete";
  updateActionButtons();
  setStatus(
    mode === "remove" ? "Removing parsed result" : "Purging capture",
    mode === "remove"
      ? "Raw HTML and RawDoc will stay available for reparse."
      : "This removes both the capture and the parsed result."
  );
  try {
    const deleted = await createKnowledgeApiClient(settings).deleteClip(activeTab.url, mode);
    lastPreview = lastPreview
      ? { ...lastPreview, status: clipStatusFromDelete(deleted) }
      : undefined;
    updatePageHeader();
    await loadSavedClips();
    await notifyBadgeRefresh();
    setStatus(
      deleted.deleted ? "Deleted" : "Not saved",
      summarizeDelete(mode, deleted.deleted)
    );
    renderOutput();
  } catch (error) {
    setStatus("Error");
    renderError(error);
  } finally {
    pendingAction = undefined;
    updateActionButtons();
  }
}

async function buildRequestBody(): Promise<ClipRequestBody> {
  if (!activeTab) {
    throw new Error("No active tab");
  }

  if (currentInputMode === "server_fetch" && settings.allowServerFetch && !activeTab.isFileUrl) {
    return {
      inputMode: "server_fetch",
      url: activeTab.url
    };
  }

  const snapshot = await chrome.tabs.sendMessage(activeTab.tabId, {
    type: "knowledge.collectSnapshot"
  }).catch(async (error) => {
    if (!isMissingContentScriptError(error)) {
      throw error;
    }
    await injectContentScript(activeTab!.tabId);
    return chrome.tabs.sendMessage(activeTab!.tabId, {
      type: "knowledge.collectSnapshot"
    });
  }) as PageSnapshot;

  return {
    inputMode: "browser_html",
    snapshot
  };
}

async function buildSaveRequestBody(): Promise<ClipSaveRequestBody> {
  const body = await buildRequestBody();
  return activeCandidateId ? { ...body, candidateId: activeCandidateId } : body;
}

function setLastPreview(preview: PreviewResult): void {
  lastPreview = preview;
  activeCandidateId = preview.activeCandidateId ??
    preview.selectedCandidateId ??
    preview.serverSelectedCandidateId ??
    preview.candidatePreviews?.[0]?.id;
  updatePageHeader();
}

function activeCandidate(preview: PreviewResult): CandidatePreview | undefined {
  return preview.candidatePreviews?.find((candidate) => candidate.id === activeCandidateId) ??
    preview.candidatePreviews?.find((candidate) => candidate.id === preview.activeCandidateId) ??
    preview.candidatePreviews?.find((candidate) => candidate.id === preview.selectedCandidateId);
}

async function injectContentScript(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot access this page. Try reloading the page, or use an http(s) page. Details: ${message}`);
  }
}

function isMissingContentScriptError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Receiving end does not exist");
}

function renderOutput(): void {
  previewOutput.hidden = activeView !== "preview";
  codeOutput.hidden = activeView !== "json";
  rawdocOutput.hidden = activeView !== "rawdoc";
  parserOutput.hidden = activeView !== "parser";
  savedList.hidden = activeView !== "saved";
  batchOutput.hidden = activeView !== "batch";
  updateDiagnosticsDisclosure();
  renderCandidateControl();
  if (activeView === "saved") {
    renderSavedList();
    return;
  }
  if (activeView === "batch") {
    renderBatchOutput();
    return;
  }

  if (!lastPreview) {
    previewOutput.replaceChildren();
    codeOutput.textContent = "";
    rawdocOutput.textContent = "";
    parserOutput.replaceChildren();
    batchOutput.replaceChildren();
    return;
  }
  const candidate = activeCandidate(lastPreview);
  previewOutput.replaceChildren(renderMarkdownPreview(candidate?.markdown ?? lastPreview.markdown));
  codeOutput.textContent = JSON.stringify(candidate?.document ?? lastPreview.document, null, 2);
  rawdocOutput.textContent = JSON.stringify(lastPreview.rawdoc, null, 2);
  parserOutput.replaceChildren(renderParserDiagnostics(lastPreview));
}

function renderCandidateControl(): void {
  const candidates = lastPreview?.candidatePreviews ?? [];
  const shouldShow = activeView === "preview" && candidates.length > 1;
  candidateControl.hidden = !shouldShow;
  if (!shouldShow) {
    candidateSelect.replaceChildren();
    return;
  }

  const activeId = activeCandidate(lastPreview!)?.id ?? candidates[0].id;
  candidateSelect.replaceChildren(...candidates.map((candidate) => {
    const option = document.createElement("option");
    option.value = candidate.id;
    option.textContent = candidateOptionLabel(candidate);
    option.selected = candidate.id === activeId;
    return option;
  }));
}

function setMode(mode: InputMode, persist = true): void {
  currentInputMode = mode;
  modeBrowserButton.dataset.active = String(mode === "browser_html");
  modeFetchButton.dataset.active = String(mode === "server_fetch");
  if (persist) {
    settings = { ...settings, defaultInputMode: mode };
    void saveSettings({ defaultInputMode: mode });
    scheduleAutoRefresh();
  }
}

function setView(view: PanelView, persist = false): void {
  if (view === "parser" && !settings.showParserDiagnostics) {
    view = "json";
  }
  if (view === "preview" || view === "saved") {
    lastPrimaryView = view;
  }
  if (isDiagnosticsView(view)) {
    diagnosticsExpanded = true;
  }
  activeView = view;
  tabPreviewButton.dataset.active = String(view === "preview");
  tabJsonButton.dataset.active = String(view === "json");
  tabRawdocButton.dataset.active = String(view === "rawdoc");
  tabParserButton.dataset.active = String(view === "parser");
  tabSavedButton.dataset.active = String(view === "saved");
  tabBatchButton.dataset.active = String(view === "batch");
  updateDiagnosticsDisclosure();
  if (persist) {
    settings = { ...settings, defaultPanelTab: view };
    void saveSettings({ defaultPanelTab: view });
  }
  renderOutput();
  updateActionButtons();
  if (view === "saved") {
    void loadSavedClips();
  }
}

async function persistPanelSettings(): Promise<void> {
  settings = {
    ...settings,
    autoRefresh: autoRefreshInput.checked
  };
  await saveSettings({ autoRefresh: settings.autoRefresh });
}

async function refreshServerStatus(): Promise<void> {
  if (settings.healthCheckOnOpen) {
    settings = await getSettings();
    applySettingsToUi();
  }
  const api = createKnowledgeApiClient(settings);
  const health = await api.health();
  if (!health.ok) {
    throw new Error("Knowledge server is not healthy");
  }

  if (activeTab) {
    const status = await api.status(activeTab.url);
    setStatus(status.state === "empty" ? "Connected" : statusLabel(status), summarizeStatus(status));
  } else {
    setStatus("Connected", "Knowledge server is reachable.");
  }
}

async function loadSavedClips(): Promise<void> {
  try {
    savedClips = (await createKnowledgeApiClient(settings).list(settings.savedListLimit)).clips;
    if (activeView === "saved") {
      renderSavedList();
    }
  } catch (error) {
    if (activeView === "saved") {
      savedList.replaceChildren(makeEmptyState(error instanceof Error ? error.message : String(error)));
    }
  }
}

function renderSavedList(): void {
  if (savedClips.length === 0) {
    savedList.replaceChildren(makeEmptyState("No saved clips"));
    return;
  }

  savedList.replaceChildren(...savedClips.map((clip) => {
    const item = document.createElement("article");
    item.className = "saved-item";

    const title = document.createElement("div");
    title.className = "saved-title";
    title.textContent = clip.title || clip.normalizedUrl;

    const url = document.createElement("div");
    url.className = "saved-url";
    url.textContent = clip.normalizedUrl;

    const meta = document.createElement("div");
    meta.className = "saved-meta";
    meta.textContent = [clip.state === "parsed" ? "Parsed" : "Raw only", new Date(
      (clip.parseUpdatedAt ?? clip.captureUpdatedAt)
    ).toLocaleString()].join(" | ");

    const details = document.createElement("div");
    details.className = "saved-details";
    details.textContent = [clip.rawdocId, clip.docId].filter(Boolean).join(" | ");

    item.append(title, url, meta);
    if (details.textContent) {
      item.append(details);
    }
    return item;
  }));
}

function renderBatchOutput(): void {
  if (batchJob) {
    const summary = document.createElement("section");
    summary.className = "batch-summary";

    const title = document.createElement("div");
    title.className = "batch-title";
    title.textContent = collectionTitle();

    const meta = document.createElement("div");
    meta.className = "batch-meta";
    const done = batchJob.saved + batchJob.skipped + batchJob.failed + batchJob.cancelled;
    meta.textContent = [
      `Job ${shortId(batchJob.jobId)}`,
      batchJob.collectionId ? `Collection ${shortId(batchJob.collectionId)}` : undefined,
      `${done} / ${batchJob.total}`,
      `saved ${batchJob.saved}`,
      `skipped ${batchJob.skipped}`,
      `failed ${batchJob.failed}`
    ].filter(Boolean).join(" | ");

    summary.append(title, meta);
    const list = document.createElement("div");
    list.className = "batch-list";
    for (const item of batchJob.items) {
      const row = document.createElement("article");
      row.className = "batch-item";

      const spacer = document.createElement("span");
      spacer.textContent = stateSymbol(item.state);

      const body = document.createElement("div");
      const itemTitle = document.createElement("div");
      itemTitle.className = "batch-title";
      itemTitle.textContent = item.titleHint || item.normalizedUrl || item.url;
      const itemUrl = document.createElement("div");
      itemUrl.className = "batch-url";
      itemUrl.textContent = item.normalizedUrl || item.url;
      const itemMeta = document.createElement("div");
      itemMeta.className = "batch-meta";
      itemMeta.textContent = [item.state, item.errorMessage].filter(Boolean).join(" | ");
      body.append(itemTitle, itemUrl, itemMeta);
      row.append(spacer, body);
      list.append(row);
    }
    batchOutput.replaceChildren(summary, list);
    return;
  }

  if (!batchDiscover) {
    batchOutput.replaceChildren(makeEmptyState("No section discovery yet."));
    return;
  }

  const summary = document.createElement("section");
  summary.className = "batch-summary";
  const title = document.createElement("div");
  title.className = "batch-title";
  title.textContent = collectionTitle();
  const meta = document.createElement("div");
  meta.className = "batch-meta";
  meta.textContent = [
    `${batchDiscover.stats.selectedCount} selected`,
    `${batchDiscover.stats.dedupedCount} discovered`,
    batchDiscover.pageUrl
  ].join(" | ");
  const actions = document.createElement("div");
  actions.className = "batch-actions";
  const start = document.createElement("button");
  start.textContent = "Start";
  start.addEventListener("click", () => void startBatchJob());
  actions.append(start);
  summary.append(title, meta, actions);

  const list = document.createElement("div");
  list.className = "batch-list";
  for (const item of batchDiscover.items) {
    const row = document.createElement("label");
    row.className = "batch-item";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = item.selectedByDefault;
    checkbox.dataset.url = item.normalizedUrl;
    const body = document.createElement("div");
    const itemTitle = document.createElement("div");
    itemTitle.className = "batch-title";
    itemTitle.textContent = item.titleHint || item.normalizedUrl;
    const itemUrl = document.createElement("div");
    itemUrl.className = "batch-url";
    itemUrl.textContent = item.normalizedUrl;
    const itemMeta = document.createElement("div");
    itemMeta.className = "batch-meta";
    itemMeta.textContent = [item.source, item.status === "parsed" ? "already saved" : item.status].filter(Boolean).join(" | ");
    body.append(itemTitle, itemUrl, itemMeta);
    row.append(checkbox, body);
    list.append(row);
  }
  batchOutput.replaceChildren(summary, list);
}

async function reloadSettings(): Promise<void> {
  const previousMode = currentInputMode;
  settings = await getSettings();
  currentInputMode = settings.defaultInputMode;
  applySettingsToUi();
  if (activeTab?.isFileUrl) {
    currentInputMode = "browser_html";
  } else if (!settings.allowServerFetch && previousMode === "server_fetch") {
    currentInputMode = "browser_html";
  }
  setMode(currentInputMode, false);
  setView(settings.defaultPanelTab, false);
  updateActionButtons();
}

function applySettingsToUi(): void {
  autoRefreshInput.checked = settings.autoRefresh;
  diagnosticsButton.hidden = !settings.showParserDiagnostics;
  tabParserButton.hidden = !settings.showParserDiagnostics;
  if (!settings.showParserDiagnostics && activeView === "parser") {
    activeView = "json";
  }
  modeFetchButton.hidden = !settings.allowServerFetch;
  updateDiagnosticsDisclosure();
}

function hasSettingsChange(changes: Record<string, chrome.storage.StorageChange>): boolean {
  return [
    "serverUrl",
    "token",
    "defaultInputMode",
    "allowServerFetch",
    "autoRefresh",
    "healthCheckOnOpen",
    "requestTimeoutMs",
    "showParserDiagnostics",
    "savedListLimit",
    "defaultPanelTab"
  ].some((key) => key in changes);
}

function makeEmptyState(text: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "saved-empty";
  element.textContent = text;
  return element;
}

function setStatus(text: string, detail?: string): void {
  statusPill.textContent = text;
  statusDetail.textContent = detail ?? defaultStatusDetail(text);
  pageStateEl.textContent = text;
}

function renderError(error: unknown): void {
  previewOutput.hidden = false;
  codeOutput.hidden = true;
  rawdocOutput.hidden = true;
  parserOutput.hidden = true;
  savedList.hidden = true;
  batchOutput.hidden = true;
  candidateControl.hidden = true;
  activeView = "preview";
  tabPreviewButton.dataset.active = "true";
  tabJsonButton.dataset.active = "false";
  tabRawdocButton.dataset.active = "false";
  tabParserButton.dataset.active = "false";
  tabSavedButton.dataset.active = "false";
  tabBatchButton.dataset.active = "false";
  diagnosticsExpanded = false;
  updateDiagnosticsDisclosure();
  const message = error instanceof Error ? error.message : String(error);
  const pre = document.createElement("pre");
  pre.textContent = message;
  previewOutput.replaceChildren(pre);
}

function statusLabel(status: { state: "empty" | "captured" | "parsed" }): string {
  return status.state === "parsed" ? "Parsed" : status.state === "captured" ? "Raw only" : "Not saved";
}

function updateActionButtons(): void {
  const state = lastPreview?.status.state ?? "empty";
  const busy = Boolean(pendingAction);
  copyButton.disabled = busy || !lastPreview?.markdown;
  saveButton.disabled = busy || !activeTab;
  saveSectionButton.disabled = busy || !activeTab || (activeTab?.isFileUrl ?? false);
  refreshButton.disabled = busy;
  settingsButton.disabled = false;
  diagnosticsButton.disabled = busy || !lastPreview;
  removeButton.disabled = busy || state !== "parsed";
  purgeButton.disabled = busy || state === "empty";
  modeBrowserButton.disabled = busy;
  modeFetchButton.disabled = busy || (activeTab?.isFileUrl ?? false) || !settings.allowServerFetch;
  autoRefreshInput.disabled = busy;
}

function updatePageHeader(): void {
  pageTitleEl.textContent = currentPageTitle();
  pageUrlEl.textContent = activeTab?.url ?? "No active page";
  pageOriginEl.textContent = activeTab ? pageOrigin(activeTab.url) : "No active source";
  pageStateEl.textContent = lastPreview ? statusLabel(lastPreview.status) : statusPill.textContent || "Idle";
}

function currentPageTitle(): string {
  if (lastPreview) {
    const candidateDocument = activeCandidate(lastPreview)?.document ?? lastPreview.document;
    return cleanTitle(
      lastPreview.status.pageTitle ??
      candidateDocument.meta.page_title ??
      lastPreview.rawdoc.metadata?.pageTitle ??
      lastPreview.status.displayTitle ??
      lastPreview.rawdoc.metadata?.displayTitle ??
      lastPreview.status.contentTitle ??
      candidateDocument.meta.title ??
      lastPreview.status.title ??
      activeTab?.title
    );
  }
  return cleanTitle(activeTab?.title);
}

function pageOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") {
      return "Local file";
    }
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function cleanTitle(value: string | undefined): string {
  const title = value?.replace(/\s+/g, " ").trim();
  return title || "Knowledge";
}

function closeMoreMenu(): void {
  moreMenu.open = false;
}

function toggleDiagnostics(): void {
  diagnosticsExpanded = !diagnosticsExpanded;
  if (!diagnosticsExpanded && isDiagnosticsView(activeView)) {
    setView(lastPrimaryView, true);
    return;
  }
  updateDiagnosticsDisclosure();
}

function updateDiagnosticsDisclosure(): void {
  diagnosticsTabs.hidden = !diagnosticsExpanded;
  diagnosticsToggleButton.title = diagnosticsExpanded ? "Hide diagnostics" : "Show diagnostics";
  diagnosticsToggleButton.setAttribute(
    "aria-label",
    diagnosticsExpanded ? "Hide diagnostics" : "Show diagnostics"
  );
  diagnosticsToggleButton.setAttribute("aria-expanded", String(diagnosticsExpanded));
  if (diagnosticsExpanded) {
    diagnosticsTabs.after(diagnosticsToggleRow);
  } else {
    diagnosticsTabs.before(diagnosticsToggleRow);
  }
}

function isDiagnosticsView(view: PanelView): boolean {
  return view === "json" || view === "rawdoc" || view === "parser" || view === "batch";
}

function summarizeSave(
  previousStatus: PreviewResult["status"] | undefined,
  preview: PreviewResult
): string {
  const nextDoc = shortId(preview.document.doc_id);
  const nextRawdoc = shortId(preview.rawdoc.rawdoc_id);
  if (!previousStatus || previousStatus.state === "empty") {
    return `Saved a new clip as doc ${nextDoc} from raw ${nextRawdoc}.`;
  }
  if (previousStatus.state === "captured") {
    return `Parsed the saved raw capture and created doc ${nextDoc}.`;
  }
  if (previousStatus.docId && previousStatus.docId !== preview.document.doc_id) {
    return `Replaced doc ${shortId(previousStatus.docId)} with ${nextDoc}.`;
  }
  return `Saved doc ${nextDoc}.`;
}

function summarizeDelete(mode: ClipDeleteMode, deleted: boolean): string {
  if (!deleted) {
    return "Nothing changed.";
  }
  if (mode === "remove") {
    return "Removed the parsed result and kept the raw capture.";
  }
  return "Purged both the raw capture and the parsed result.";
}

function summarizeStatus(status: PreviewResult["status"]): string {
  if (status.state === "empty") {
    return "This page has not been stored yet.";
  }
  if (status.state === "captured") {
    return `Raw capture ${shortId(status.rawdocId)} is stored and ready to reparse.`;
  }
  return `Parsed doc ${shortId(status.docId)} is active for this page.`;
}

function selectedBatchItems(): BatchDiscoverItem[] {
  if (!batchDiscover) {
    return [];
  }
  const selectedUrls = new Set(
    Array.from(batchOutput.querySelectorAll<HTMLInputElement>("input[type='checkbox'][data-url]"))
      .filter((input) => input.checked)
      .map((input) => input.dataset.url)
      .filter(Boolean) as string[]
  );
  if (selectedUrls.size === 0) {
    return [];
  }
  return batchDiscover.items.filter((item) => selectedUrls.has(item.normalizedUrl));
}

function collectionTitle(): string {
  if (activeTab?.title?.trim()) {
    return activeTab.title.trim();
  }
  if (lastPreview?.document.meta.title) {
    return lastPreview.document.meta.page_title ?? lastPreview.document.meta.title;
  }
  return "Knowledge collection";
}

function stateSymbol(state: string): string {
  if (state === "saved") {
    return "OK";
  }
  if (state === "skipped") {
    return "SK";
  }
  if (state === "failed") {
    return "ERR";
  }
  if (state === "cancelled") {
    return "X";
  }
  return "...";
}

function defaultStatusDetail(text: string): string {
  return text === "Idle" ? "Ready" : "";
}

function shortId(value: string | undefined): string {
  return value ? value.slice(0, 8) : "unknown";
}

function clipStatusFromDelete(deleted: {
  normalizedUrl: string;
  urlHash: string;
  currentState: "empty" | "captured";
  hasRawdoc: boolean;
  hasDocument: boolean;
  originalUrl?: string;
  canonicalUrl?: string;
  title?: string;
  pageTitle?: string;
  contentTitle?: string;
  displayTitle?: string;
  rawdocId?: string;
  captureSavedAt?: string;
  captureUpdatedAt?: string;
  parseUpdatedAt?: string;
}): PreviewResult["status"] {
  return {
    normalizedUrl: deleted.normalizedUrl,
    urlHash: deleted.urlHash,
    state: deleted.currentState,
    hasRawdoc: deleted.hasRawdoc,
    hasDocument: deleted.hasDocument,
    originalUrl: deleted.originalUrl,
    canonicalUrl: deleted.canonicalUrl,
    title: deleted.displayTitle ?? deleted.title,
    rawdocId: deleted.rawdocId,
    captureSavedAt: deleted.captureSavedAt,
    captureUpdatedAt: deleted.captureUpdatedAt,
    parseUpdatedAt: deleted.parseUpdatedAt
  };
}

function renderParserDiagnostics(preview: PreviewResult): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const metadata = preview.rawdoc.metadata ?? {};
  const defuddle = metadata.defuddle ?? {};
  const parserDiagnostics = metadata.parserDiagnostics as Record<string, unknown> | undefined;
  const matchedAdapters = Array.isArray(metadata.matchedAdapters) ? metadata.matchedAdapters : [];
  const parserCandidates = Array.isArray(metadata.parserCandidates) ? metadata.parserCandidates : [];
  const currentCandidate = activeCandidate(preview);
  const currentDocument = currentCandidate?.document ?? preview.document;
  const currentMarkdown = currentCandidate?.markdown ?? preview.markdown;
  const warnings = collectParserWarnings(preview);

  fragment.append(
    makeParserGroup("Extraction", [
      ["parser_version", currentDocument.meta.parser_version],
      ["parser_method", currentCandidate?.method ?? metadata.parserMethod],
      ["active_candidate", activeCandidateId],
      ["server_selected_candidate", preview.serverSelectedCandidateId],
      ["user_selected_candidate", metadata.userSelectedCandidateId],
      ["input_mode", metadata.inputMode],
      ["source_type", preview.rawdoc.source_type],
      ["source_uri", preview.rawdoc.source_uri],
      ["original_url", metadata.originalUrl],
      ["canonical_url", metadata.canonicalUrl],
      ["normalized_url", metadata.normalizedUrl],
      ["fetch_time", preview.rawdoc.fetch_time],
      ["content_length", preview.rawdoc.content_length]
    ])
  );

  fragment.append(
    makeParserGroup("Document", [
      ["doc_id", currentDocument.doc_id],
      ["page_title", currentDocument.meta.page_title],
      ["content_title", currentDocument.meta.title],
      ["display_title", preview.status.displayTitle ?? preview.status.title],
      ["authors", currentDocument.meta.authors?.join(", ")],
      ["published_at", currentDocument.meta.published_at],
      ["language", currentDocument.meta.language],
      ["section_count", currentDocument.sections.length],
      ["markdown_chars", currentMarkdown.length],
      ["clip_state", preview.status.state]
    ])
  );

  fragment.append(
    makeParserGroup("Defuddle", Object.entries(defuddle).map(([key, value]) => [key, value]))
  );

  if (parserDiagnostics) {
    fragment.append(
      makeParserGroup("Diagnostics", [
        ["input", parserDiagnostics.input],
        ["cleanup", parserDiagnostics.cleanup],
        ["selected", parserDiagnostics.selected]
      ])
    );
  }

  fragment.append(
    makeParserGroup("Adapters", matchedAdapters.flatMap((adapter, index) => {
      const adapterRecord = adapter as Record<string, unknown>;
      return [
        [`${index + 1}.id`, adapterRecord.id],
        [`${index + 1}.type`, adapterRecord.type],
        [`${index + 1}.score`, adapterRecord.matchScore],
        [`${index + 1}.reason`, adapterRecord.matchReason]
      ];
    }))
  );

  fragment.append(
    makeParserGroup("Candidates", parserCandidates.flatMap((candidate, index) => {
      const candidateRecord = candidate as Record<string, unknown>;
      return [
        [`${index + 1}.method`, candidateRecord.method],
        [`${index + 1}.adapter`, candidateRecord.adapterId],
        [`${index + 1}.selector`, candidateRecord.selector],
        [`${index + 1}.selected`, candidateRecord.selected],
        [`${index + 1}.serverSelected`, candidateRecord.serverSelected],
        [`${index + 1}.score`, candidateRecord.score],
        [`${index + 1}.metrics`, candidateRecord.metrics],
        [`${index + 1}.reason`, candidateRecord.reason]
      ];
    }))
  );

  if (warnings.length > 0) {
    const group = makeParserGroup("Warnings", []);
    for (const warning of warnings) {
      const row = document.createElement("div");
      row.className = "parser-warning";
      row.textContent = warning;
      group.append(row);
    }
    fragment.append(group);
  }

  return fragment;
}

function candidateOptionLabel(candidate: CandidatePreview): string {
  return [
    [
      candidate.method,
      candidate.adapterId,
      candidate.selector
    ].filter(Boolean).join(" / "),
    `score ${candidate.score}`,
    candidate.metrics.sectionCount !== undefined ? `${candidate.metrics.sectionCount} sections` : "",
    candidate.metrics.textLength !== undefined ? `${candidate.metrics.textLength} chars` : "",
    candidate.serverSelected ? "server selected" : "",
    candidate.warnings.length > 0 ? `${candidate.warnings.length} warnings` : ""
  ].filter(Boolean).join(" | ");
}

function collectParserWarnings(preview: PreviewResult): string[] {
  const warnings: string[] = [];
  const metadata = preview.rawdoc.metadata ?? {};
  const candidate = activeCandidate(preview);
  const document = candidate?.document ?? preview.document;
  const markdown = candidate?.markdown ?? preview.markdown;

  if (Array.isArray(metadata.parserWarnings)) {
    warnings.push(...metadata.parserWarnings.map((warning) => String(warning)));
  }
  const method = candidate?.method ?? metadata.parserMethod;
  if (method === "dom_fallback" && warnings.length === 0) {
    warnings.push("Generic DOM fallback was selected.");
  }
  if (document.sections.length <= 1) {
    warnings.push("Only one content section was extracted.");
  }
  if (markdown.trim().length < 300) {
    warnings.push("Markdown output is short; check whether the page needs a site adapter or selector extraction.");
  }
  if (!document.meta.title || document.meta.title === metadata.normalizedUrl) {
    warnings.push("The parser could not find a strong title.");
  }

  return warnings;
}

function makeParserGroup(title: string, rows: Array<[string, unknown]>): HTMLElement {
  const group = document.createElement("section");
  group.className = "parser-group";

  const heading = document.createElement("div");
  heading.className = "parser-heading";
  heading.textContent = title;
  group.append(heading);

  const visibleRows = rows.filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (visibleRows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "parser-value";
    empty.textContent = "No data";
    group.append(empty);
    return group;
  }

  for (const [key, value] of visibleRows) {
    const row = document.createElement("div");
    row.className = "parser-row";

    const keyEl = document.createElement("div");
    keyEl.className = "parser-key";
    keyEl.textContent = key;

    const valueEl = document.createElement("div");
    valueEl.className = "parser-value";
    valueEl.textContent = formatDiagnosticValue(value);

    row.append(keyEl, valueEl);
    group.append(row);
  }

  return group;
}

function formatDiagnosticValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function scheduleAutoRefresh(): void {
  if (!settings.autoRefresh) {
    return;
  }
  window.clearTimeout(autoRefreshTimer);
  autoRefreshTimer = window.setTimeout(() => {
    void preview();
  }, 350);
}

async function notifyBadgeRefresh(): Promise<void> {
  if (!activeTab) {
    return;
  }
  await chrome.runtime.sendMessage({
    type: "knowledge.refreshBadge",
    tabId: activeTab.tabId
  }).catch(() => undefined);
}

function mustGet<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }
  return element as T;
}
