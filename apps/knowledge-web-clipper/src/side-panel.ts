import { createKnowledgeApiClient } from "./api-client.js";
import { getSettings, saveSettings } from "./settings.js";
import {
  ActiveTabInfo,
  ClipDeleteMode,
  ClipListItem,
  ClipRequestBody,
  ExtensionSettings,
  InputMode,
  PanelView,
  PageSnapshot,
  PreviewResult
} from "./types.js";

declare global {
  interface Window {
    katex?: {
      render: (
        source: string,
        element: HTMLElement,
        options: {
          displayMode?: boolean;
          output?: "html" | "mathml" | "htmlAndMathml";
          strict?: boolean | string;
          throwOnError?: boolean;
          trust?: boolean;
        }
      ) => void;
    };
  }
}

const previewOutput = mustGet<HTMLElement>("preview-output");
const codeOutput = mustGet<HTMLPreElement>("code-output");
const rawdocOutput = mustGet<HTMLPreElement>("rawdoc-output");
const parserOutput = mustGet<HTMLDivElement>("parser-output");
const statusPill = mustGet<HTMLElement>("status-pill");
const statusDetail = mustGet<HTMLElement>("status-detail");
const pageUrlEl = mustGet<HTMLElement>("page-url");
const autoRefreshInput = mustGet<HTMLInputElement>("auto-refresh");
const settingsButton = mustGet<HTMLButtonElement>("settings-button");
const refreshButton = mustGet<HTMLButtonElement>("refresh-button");
const saveButton = mustGet<HTMLButtonElement>("save-button");
const copyButton = mustGet<HTMLButtonElement>("copy-button");
const removeButton = mustGet<HTMLButtonElement>("remove-button");
const purgeButton = mustGet<HTMLButtonElement>("purge-button");
const modeBrowserButton = mustGet<HTMLButtonElement>("mode-browser");
const modeFetchButton = mustGet<HTMLButtonElement>("mode-fetch");
const tabPreviewButton = mustGet<HTMLButtonElement>("tab-preview");
const tabJsonButton = mustGet<HTMLButtonElement>("tab-json");
const tabRawdocButton = mustGet<HTMLButtonElement>("tab-rawdoc");
const tabParserButton = mustGet<HTMLButtonElement>("tab-parser");
const tabSavedButton = mustGet<HTMLButtonElement>("tab-saved");
const savedList = mustGet<HTMLDivElement>("saved-list");

let settings: ExtensionSettings = await getSettings();
let activeTab: ActiveTabInfo | undefined;
let lastPreview: PreviewResult | undefined;
let savedClips: ClipListItem[] = [];

let currentInputMode: InputMode = settings.defaultInputMode;
let activeView: PanelView = settings.defaultPanelTab;
let autoRefreshTimer: number | undefined;
let pendingAction: "delete" | "preview" | "save" | undefined;

autoRefreshInput.checked = settings.autoRefresh;
applySettingsToUi();
setMode(currentInputMode, false);
setView(activeView, false);
await refreshActiveTab();
await preview();
updateActionButtons();

refreshButton.addEventListener("click", () => preview());
settingsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());
saveButton.addEventListener("click", () => save());
copyButton.addEventListener("click", () => copyMarkdown());
removeButton.addEventListener("click", () => deleteCurrentClip("remove"));
purgeButton.addEventListener("click", () => deleteCurrentClip("purge"));
modeBrowserButton.addEventListener("click", () => setMode("browser_html"));
modeFetchButton.addEventListener("click", () => setMode("server_fetch"));
tabPreviewButton.addEventListener("click", () => setView("preview", true));
tabJsonButton.addEventListener("click", () => setView("json", true));
tabRawdocButton.addEventListener("click", () => setView("rawdoc", true));
tabParserButton.addEventListener("click", () => setView("parser", true));
tabSavedButton.addEventListener("click", () => setView("saved", true));
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
    pageUrlEl.textContent = "No active page";
    return;
  }

  activeTab = {
    tabId: tab.id,
    url: tab.url,
    title: tab.title,
    isFileUrl: tab.url.startsWith("file://")
  };
  pageUrlEl.textContent = tab.url;

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
    lastPreview = await createKnowledgeApiClient(settings).preview(body);
    setStatus(statusLabel(lastPreview.status));
    renderOutput();
    updateActionButtons();
    if (lastPreview.status.state !== "empty") {
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
    const body = await buildRequestBody();
    lastPreview = await createKnowledgeApiClient(settings).save(body);
    await loadSavedClips();
    await notifyBadgeRefresh();
    setStatus("Saved", summarizeSave(previousStatus, lastPreview));
    renderOutput();
  } catch (error) {
    setStatus("Error");
    renderError(error);
  } finally {
    pendingAction = undefined;
    updateActionButtons();
  }
}

async function copyMarkdown(): Promise<void> {
  if (!lastPreview?.markdown) {
    setStatus("Nothing to copy", "Preview or save a page first.");
    return;
  }

  await navigator.clipboard.writeText(lastPreview.markdown);
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
  if (activeView === "saved") {
    renderSavedList();
    return;
  }

  if (!lastPreview) {
    previewOutput.replaceChildren();
    codeOutput.textContent = "";
    rawdocOutput.textContent = "";
    parserOutput.replaceChildren();
    return;
  }
  previewOutput.replaceChildren(renderMarkdown(lastPreview.markdown));
  codeOutput.textContent = JSON.stringify(lastPreview.document, null, 2);
  rawdocOutput.textContent = JSON.stringify(lastPreview.rawdoc, null, 2);
  parserOutput.replaceChildren(renderParserDiagnostics(lastPreview));
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
    view = "preview";
  }
  activeView = view;
  tabPreviewButton.dataset.active = String(view === "preview");
  tabJsonButton.dataset.active = String(view === "json");
  tabRawdocButton.dataset.active = String(view === "rawdoc");
  tabParserButton.dataset.active = String(view === "parser");
  tabSavedButton.dataset.active = String(view === "saved");
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
  tabParserButton.hidden = !settings.showParserDiagnostics;
  if (!settings.showParserDiagnostics && activeView === "parser") {
    activeView = "preview";
  }
  modeFetchButton.hidden = !settings.allowServerFetch;
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
}

function renderError(error: unknown): void {
  previewOutput.hidden = false;
  codeOutput.hidden = true;
  rawdocOutput.hidden = true;
  parserOutput.hidden = true;
  savedList.hidden = true;
  activeView = "preview";
  tabPreviewButton.dataset.active = "true";
  tabJsonButton.dataset.active = "false";
  tabRawdocButton.dataset.active = "false";
  tabParserButton.dataset.active = "false";
  tabSavedButton.dataset.active = "false";
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
  refreshButton.disabled = busy;
  settingsButton.disabled = busy;
  removeButton.disabled = busy || state !== "parsed";
  purgeButton.disabled = busy || state === "empty";
  modeBrowserButton.disabled = busy;
  modeFetchButton.disabled = busy || (activeTab?.isFileUrl ?? false) || !settings.allowServerFetch;
  autoRefreshInput.disabled = busy;
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
    title: deleted.title,
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
  const warnings = collectParserWarnings(preview);

  fragment.append(
    makeParserGroup("Extraction", [
      ["parser_version", preview.document.meta.parser_version],
      ["parser_method", metadata.parserMethod],
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
      ["doc_id", preview.document.doc_id],
      ["title", preview.document.meta.title],
      ["authors", preview.document.meta.authors?.join(", ")],
      ["published_at", preview.document.meta.published_at],
      ["language", preview.document.meta.language],
      ["section_count", preview.document.sections.length],
      ["markdown_chars", preview.markdown.length],
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
        [`${index + 1}.selected`, candidateRecord.selected],
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

function collectParserWarnings(preview: PreviewResult): string[] {
  const warnings: string[] = [];
  const metadata = preview.rawdoc.metadata ?? {};

  if (Array.isArray(metadata.parserWarnings)) {
    warnings.push(...metadata.parserWarnings.map((warning) => String(warning)));
  }
  if (metadata.parserMethod === "dom_fallback" && warnings.length === 0) {
    warnings.push("Generic DOM fallback was selected.");
  }
  if (preview.document.sections.length <= 1) {
    warnings.push("Only one content section was extracted.");
  }
  if (preview.markdown.trim().length < 300) {
    warnings.push("Markdown output is short; check whether the page needs a site adapter or selector extraction.");
  }
  if (!preview.document.meta.title || preview.document.meta.title === metadata.normalizedUrl) {
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

function renderMarkdown(markdown: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const lines = stripFrontmatter(markdown).split(/\r?\n/);
  let paragraph: string[] = [];
  let list: HTMLUListElement | undefined;
  let codeBlock: string[] | undefined;
  let mathBlock: string[] | undefined;
  let tableRows: string[][] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) {
      return;
    }
    const p = document.createElement("p");
    appendInlineMarkdown(p, paragraph.join(" "));
    fragment.append(p);
    paragraph = [];
  };

  const flushList = () => {
    if (list) {
      fragment.append(list);
      list = undefined;
    }
  };

  const flushTable = () => {
    if (tableRows.length === 0) {
      return;
    }
    const table = tableRowsToElement(tableRows);
    if (table) {
      fragment.append(table);
    }
    tableRows = [];
  };

  for (const line of lines) {
    const trimmedLine = line.trim();
    const inlineDisplayMath = parseOneLineDisplayMath(trimmedLine);
    if (inlineDisplayMath) {
      flushParagraph();
      flushList();
      flushTable();
      fragment.append(renderMath(inlineDisplayMath, true));
      continue;
    }

    if (trimmedLine === "$$" || trimmedLine === "\\[") {
      if (mathBlock) {
        fragment.append(renderMath(mathBlock.join("\n"), true));
        mathBlock = undefined;
      } else {
        flushParagraph();
        flushList();
        flushTable();
        mathBlock = [];
      }
      continue;
    }

    if (trimmedLine === "\\]" && mathBlock) {
      fragment.append(renderMath(mathBlock.join("\n"), true));
      mathBlock = undefined;
      continue;
    }

    if (mathBlock) {
      mathBlock.push(line);
      continue;
    }

    if (line.startsWith("```")) {
      if (codeBlock) {
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = codeBlock.join("\n");
        pre.append(code);
        fragment.append(pre);
        codeBlock = undefined;
      } else {
        flushParagraph();
        flushList();
        flushTable();
        codeBlock = [];
      }
      continue;
    }

    if (codeBlock) {
      codeBlock.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      flushTable();
      continue;
    }

    const tableRow = parseMarkdownTableRow(line);
    if (tableRow) {
      flushParagraph();
      flushList();
      tableRows.push(tableRow);
      continue;
    }
    flushTable();

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      const h = document.createElement(`h${level}`);
      appendInlineMarkdown(h, heading[2]);
      fragment.append(h);
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      list ??= document.createElement("ul");
      const li = document.createElement("li");
      appendInlineMarkdown(li, bullet[1]);
      list.append(li);
      continue;
    }

    if (line.startsWith("> ")) {
      flushParagraph();
      flushList();
      const blockquote = document.createElement("blockquote");
      appendInlineMarkdown(blockquote, line.slice(2));
      fragment.append(blockquote);
      continue;
    }

    paragraph.push(line.trim());
  }

  if (codeBlock) {
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = codeBlock.join("\n");
    pre.append(code);
    fragment.append(pre);
  }
  if (mathBlock) {
    fragment.append(renderMath(mathBlock.join("\n"), true));
  }
  flushParagraph();
  flushList();
  flushTable();
  return fragment;
}

function stripFrontmatter(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return markdown;
  }

  const endIndex = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (endIndex === -1) {
    return markdown;
  }
  return lines.slice(endIndex + 2).join("\n").trimStart();
}

function appendInlineMarkdown(parent: HTMLElement, text: string): void {
  const parts = text.split(/(!?\[[^\]]*]\([^)]+\)|`[^`]+`|\\\([^\n]+?\\\)|\$[^$\n]+\$)/g);
  for (const part of parts) {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      const code = document.createElement("code");
      code.textContent = part.slice(1, -1);
      parent.append(code);
    } else if (part.startsWith("$") && part.endsWith("$") && part.length > 1) {
      parent.append(renderMath(part.slice(1, -1), false));
    } else if (part.startsWith("\\(") && part.endsWith("\\)") && part.length > 3) {
      parent.append(renderMath(part.slice(2, -2), false));
    } else if (part.startsWith("![")) {
      const image = part.match(/^!\[([^\]]*)]\(([^)]+)\)$/);
      if (image && isSafeMarkdownUrl(image[2], "image")) {
        const img = document.createElement("img");
        img.alt = image[1];
        img.src = image[2];
        img.loading = "lazy";
        img.referrerPolicy = "no-referrer";
        parent.append(img);
      } else if (part) {
        parent.append(document.createTextNode(part));
      }
    } else if (part.startsWith("[")) {
      const link = part.match(/^\[([^\]]+)]\(([^)]+)\)$/);
      if (link && isSafeMarkdownUrl(link[2], "link")) {
        const a = document.createElement("a");
        a.href = link[2];
        a.textContent = link[1];
        a.target = "_blank";
        a.rel = "noreferrer";
        parent.append(a);
      } else if (part) {
        parent.append(document.createTextNode(part));
      }
    } else if (part) {
      parent.append(document.createTextNode(part));
    }
  }
}

function renderMath(source: string, display: boolean): HTMLElement {
  const element = document.createElement(display ? "div" : "span");
  element.className = display ? "math-display" : "math-inline";
  element.dataset.source = source;
  const normalized = source.trim();
  if (window.katex) {
    window.katex.render(normalized, element, {
      displayMode: display,
      output: "htmlAndMathml",
      strict: "ignore",
      throwOnError: false,
      trust: false
    });
    element.classList.add("math-rendered");
    return element;
  }
  appendMathTokens(element, normalized);
  return element;
}

function parseOneLineDisplayMath(line: string): string | undefined {
  if (line.startsWith("$$") && line.endsWith("$$") && line.length > 4) {
    return line.slice(2, -2).trim();
  }
  if (line.startsWith("\\[") && line.endsWith("\\]") && line.length > 4) {
    return line.slice(2, -2).trim();
  }
  return undefined;
}

function appendMathTokens(parent: HTMLElement, source: string): void {
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("\\frac", index)) {
      const parsed = parseFraction(source, index + "\\frac".length);
      if (parsed) {
        const fraction = document.createElement("span");
        fraction.className = "math-frac";
        const numerator = document.createElement("span");
        numerator.className = "math-num";
        appendMathTokens(numerator, parsed.numerator);
        const denominator = document.createElement("span");
        denominator.className = "math-den";
        appendMathTokens(denominator, parsed.denominator);
        fraction.append(numerator, denominator);
        parent.append(fraction);
        index = parsed.nextIndex;
        continue;
      }
    }

    const char = source[index];
    if ((char === "^" || char === "_") && parent.lastChild) {
      const parsed = parseScriptArgument(source, index + 1);
      if (parsed) {
        const script = document.createElement(char === "^" ? "sup" : "sub");
        appendMathTokens(script, parsed.value);
        parent.append(script);
        index = parsed.nextIndex;
        continue;
      }
    }

    if (char === "\\") {
      const command = source.slice(index).match(/^\\[A-Za-z]+/);
      if (command) {
        parent.append(document.createTextNode(mathCommandText(command[0])));
        index += command[0].length;
        continue;
      }
    }

    parent.append(document.createTextNode(mathSymbolText(char)));
    index += 1;
  }
}

function parseFraction(source: string, startIndex: number): { numerator: string; denominator: string; nextIndex: number } | undefined {
  const numerator = parseBraceGroup(source, skipSpaces(source, startIndex));
  if (!numerator) {
    return undefined;
  }
  const denominator = parseBraceGroup(source, skipSpaces(source, numerator.nextIndex));
  if (!denominator) {
    return undefined;
  }
  return {
    numerator: numerator.value,
    denominator: denominator.value,
    nextIndex: denominator.nextIndex
  };
}

function parseScriptArgument(source: string, startIndex: number): { value: string; nextIndex: number } | undefined {
  const index = skipSpaces(source, startIndex);
  if (source[index] === "{") {
    return parseBraceGroup(source, index);
  }
  if (source[index] === "\\") {
    const command = source.slice(index).match(/^\\[A-Za-z]+/);
    if (command) {
      return {
        value: command[0],
        nextIndex: index + command[0].length
      };
    }
  }
  return source[index]
    ? { value: source[index], nextIndex: index + 1 }
    : undefined;
}

function parseBraceGroup(source: string, startIndex: number): { value: string; nextIndex: number } | undefined {
  if (source[startIndex] !== "{") {
    return undefined;
  }
  let depth = 0;
  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          value: source.slice(startIndex + 1, index),
          nextIndex: index + 1
        };
      }
    }
  }
  return undefined;
}

function skipSpaces(source: string, startIndex: number): number {
  let index = startIndex;
  while (source[index] === " ") {
    index += 1;
  }
  return index;
}

function mathCommandText(command: string): string {
  const commands: Record<string, string> = {
    "\\alpha": "α",
    "\\beta": "β",
    "\\gamma": "γ",
    "\\delta": "δ",
    "\\epsilon": "ε",
    "\\theta": "θ",
    "\\lambda": "λ",
    "\\mu": "μ",
    "\\pi": "π",
    "\\sigma": "σ",
    "\\phi": "φ",
    "\\omega": "ω",
    "\\Gamma": "Γ",
    "\\Delta": "Δ",
    "\\Theta": "Θ",
    "\\Lambda": "Λ",
    "\\Pi": "Π",
    "\\Sigma": "Σ",
    "\\Phi": "Φ",
    "\\Omega": "Ω",
    "\\sum": "∑",
    "\\prod": "∏",
    "\\int": "∫",
    "\\infty": "∞",
    "\\partial": "∂",
    "\\nabla": "∇",
    "\\times": "×",
    "\\cdot": "·",
    "\\pm": "±",
    "\\leq": "≤",
    "\\geq": "≥",
    "\\neq": "≠",
    "\\approx": "≈",
    "\\to": "→",
    "\\rightarrow": "→",
    "\\leftarrow": "←",
    "\\Rightarrow": "⇒",
    "\\in": "∈",
    "\\notin": "∉",
    "\\subset": "⊂",
    "\\subseteq": "⊆",
    "\\cup": "∪",
    "\\cap": "∩"
  };
  return commands[command] ?? command.replace(/^\\/, "");
}

function mathSymbolText(char: string): string {
  return char === "~" ? " " : char;
}

function parseMarkdownTableRow(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
    return undefined;
  }
  return trimmed
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function tableRowsToElement(rows: string[][]): HTMLTableElement | undefined {
  const dataRows = rows.filter((row) => !isMarkdownTableSeparator(row));
  if (dataRows.length === 0) {
    return undefined;
  }

  const table = document.createElement("table");
  const [header, ...body] = dataRows;
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const cell of header) {
    const th = document.createElement("th");
    appendInlineMarkdown(th, cell);
    headerRow.append(th);
  }
  thead.append(headerRow);
  table.append(thead);

  if (body.length > 0) {
    const tbody = document.createElement("tbody");
    for (const row of body) {
      const tr = document.createElement("tr");
      for (const cell of row) {
        const td = document.createElement("td");
        appendInlineMarkdown(td, cell);
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(tbody);
  }

  return table;
}

function isMarkdownTableSeparator(row: string[]): boolean {
  return row.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isSafeMarkdownUrl(value: string, kind: "image" | "link"): boolean {
  try {
    const url = new URL(value);
    if (kind === "image") {
      return ["http:", "https:", "data:"].includes(url.protocol);
    }
    return ["http:", "https:", "file:", "mailto:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function mustGet<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }
  return element as T;
}
