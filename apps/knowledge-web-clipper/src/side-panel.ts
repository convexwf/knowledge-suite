import { createKnowledgeApiClient } from "./api-client.js";
import { getSettings, saveSettings } from "./settings.js";
import {
  ActiveTabInfo,
  ClipListItem,
  ClipRequestBody,
  ExtensionSettings,
  InputMode,
  PageSnapshot,
  PreviewResult
} from "./types.js";

const output = mustGet<HTMLPreElement>("output");
const statusPill = mustGet<HTMLElement>("status-pill");
const pageUrlEl = mustGet<HTMLElement>("page-url");
const serverUrlInput = mustGet<HTMLInputElement>("server-url");
const serverTokenInput = mustGet<HTMLInputElement>("server-token");
const refreshButton = mustGet<HTMLButtonElement>("refresh-button");
const saveButton = mustGet<HTMLButtonElement>("save-button");
const modeBrowserButton = mustGet<HTMLButtonElement>("mode-browser");
const modeFetchButton = mustGet<HTMLButtonElement>("mode-fetch");
const tabPreviewButton = mustGet<HTMLButtonElement>("tab-preview");
const tabJsonButton = mustGet<HTMLButtonElement>("tab-json");
const tabSavedButton = mustGet<HTMLButtonElement>("tab-saved");
const savedList = mustGet<HTMLDivElement>("saved-list");

let settings: ExtensionSettings = await getSettings();
let activeTab: ActiveTabInfo | undefined;
let lastPreview: PreviewResult | undefined;
let savedClips: ClipListItem[] = [];
let activeView: "preview" | "json" | "saved" = "preview";

serverUrlInput.value = settings.serverUrl;
serverTokenInput.value = settings.token;
setMode(settings.inputMode);
await refreshActiveTab();
await preview();

refreshButton.addEventListener("click", () => preview());
saveButton.addEventListener("click", () => save());
modeBrowserButton.addEventListener("click", () => setMode("browser_html"));
modeFetchButton.addEventListener("click", () => setMode("server_fetch"));
tabPreviewButton.addEventListener("click", () => setView("preview"));
tabJsonButton.addEventListener("click", () => setView("json"));
tabSavedButton.addEventListener("click", () => setView("saved"));
serverUrlInput.addEventListener("change", () => persistSettings());
serverTokenInput.addEventListener("change", () => persistSettings());

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
    setMode("browser_html");
    modeFetchButton.disabled = true;
  } else {
    modeFetchButton.disabled = false;
  }
}

async function preview(): Promise<void> {
  await refreshActiveTab();
  if (!activeTab) {
    return;
  }

  setStatus("Previewing");
  try {
    await refreshServerStatus();
    const body = await buildRequestBody();
    lastPreview = await createKnowledgeApiClient(settings).preview(body);
    setStatus(lastPreview.status.saved ? "Saved" : "Ready");
    renderOutput();
    if (lastPreview.status.saved) {
      void loadSavedClips();
    }
  } catch (error) {
    setStatus("Error");
    output.textContent = error instanceof Error ? error.message : String(error);
  }
}

async function save(): Promise<void> {
  if (!activeTab) {
    return;
  }

  setStatus("Saving");
  try {
    await refreshServerStatus();
    const body = await buildRequestBody();
    lastPreview = await createKnowledgeApiClient(settings).save(body);
    await loadSavedClips();
    setStatus("Saved");
    renderOutput();
  } catch (error) {
    setStatus("Error");
    output.textContent = error instanceof Error ? error.message : String(error);
  }
}

async function buildRequestBody(): Promise<ClipRequestBody> {
  if (!activeTab) {
    throw new Error("No active tab");
  }

  if (settings.inputMode === "server_fetch") {
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
  output.hidden = activeView === "saved";
  savedList.hidden = activeView !== "saved";
  if (activeView === "saved") {
    renderSavedList();
    return;
  }

  if (!lastPreview) {
    output.textContent = "";
    return;
  }
  output.textContent = activeView === "preview"
    ? lastPreview.markdown
    : JSON.stringify(lastPreview.document, null, 2);
}

function setMode(mode: InputMode): void {
  settings = { ...settings, inputMode: mode };
  modeBrowserButton.dataset.active = String(mode === "browser_html");
  modeFetchButton.dataset.active = String(mode === "server_fetch");
  void saveSettings({ inputMode: mode });
}

function setView(view: "preview" | "json" | "saved"): void {
  activeView = view;
  tabPreviewButton.dataset.active = String(view === "preview");
  tabJsonButton.dataset.active = String(view === "json");
  tabSavedButton.dataset.active = String(view === "saved");
  renderOutput();
  if (view === "saved") {
    void loadSavedClips();
  }
}

async function persistSettings(): Promise<void> {
  settings = {
    ...settings,
    serverUrl: serverUrlInput.value.replace(/\/+$/, ""),
    token: serverTokenInput.value
  };
  await saveSettings(settings);
}

async function refreshServerStatus(): Promise<void> {
  await persistSettings();
  const api = createKnowledgeApiClient(settings);
  const health = await api.health();
  if (!health.ok) {
    throw new Error("Knowledge server is not healthy");
  }

  if (activeTab) {
    const status = await api.status(activeTab.url);
    setStatus(status.saved ? "Saved" : "Connected");
  } else {
    setStatus("Connected");
  }
}

async function loadSavedClips(): Promise<void> {
  try {
    savedClips = (await createKnowledgeApiClient(settings).list(50)).clips;
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
    meta.textContent = new Date(clip.savedAt).toLocaleString();

    const paths = document.createElement("div");
    paths.className = "saved-paths";
    paths.textContent = [clip.markdownPath, clip.documentPath].filter(Boolean).join(" | ");

    item.append(title, url, meta);
    if (paths.textContent) {
      item.append(paths);
    }
    return item;
  }));
}

function makeEmptyState(text: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "saved-empty";
  element.textContent = text;
  return element;
}

function setStatus(text: string): void {
  statusPill.textContent = text;
}

function mustGet<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }
  return element as T;
}
