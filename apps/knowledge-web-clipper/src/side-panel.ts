import { createKnowledgeApiClient } from "./api-client.js";
import { getSettings, saveSettings } from "./settings.js";
import { ActiveTabInfo, ClipRequestBody, ExtensionSettings, InputMode, PageSnapshot, PreviewResult } from "./types.js";

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

let settings: ExtensionSettings = await getSettings();
let activeTab: ActiveTabInfo | undefined;
let lastPreview: PreviewResult | undefined;
let activeView: "preview" | "json" = "preview";

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
  }) as PageSnapshot;

  return {
    inputMode: "browser_html",
    snapshot
  };
}

function renderOutput(): void {
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

function setView(view: "preview" | "json"): void {
  activeView = view;
  tabPreviewButton.dataset.active = String(view === "preview");
  tabJsonButton.dataset.active = String(view === "json");
  renderOutput();
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
