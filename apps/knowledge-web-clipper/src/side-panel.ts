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

const previewOutput = mustGet<HTMLElement>("preview-output");
const codeOutput = mustGet<HTMLPreElement>("code-output");
const statusPill = mustGet<HTMLElement>("status-pill");
const pageUrlEl = mustGet<HTMLElement>("page-url");
const serverUrlInput = mustGet<HTMLInputElement>("server-url");
const serverTokenInput = mustGet<HTMLInputElement>("server-token");
const autoRefreshInput = mustGet<HTMLInputElement>("auto-refresh");
const refreshButton = mustGet<HTMLButtonElement>("refresh-button");
const saveButton = mustGet<HTMLButtonElement>("save-button");
const copyButton = mustGet<HTMLButtonElement>("copy-button");
const deleteButton = mustGet<HTMLButtonElement>("delete-button");
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
let autoRefreshTimer: number | undefined;

serverUrlInput.value = settings.serverUrl;
serverTokenInput.value = settings.token;
autoRefreshInput.checked = settings.autoRefresh;
setMode(settings.inputMode);
await refreshActiveTab();
await preview();

refreshButton.addEventListener("click", () => preview());
saveButton.addEventListener("click", () => save());
copyButton.addEventListener("click", () => copyMarkdown());
deleteButton.addEventListener("click", () => deleteCurrentClip());
modeBrowserButton.addEventListener("click", () => setMode("browser_html"));
modeFetchButton.addEventListener("click", () => setMode("server_fetch"));
tabPreviewButton.addEventListener("click", () => setView("preview"));
tabJsonButton.addEventListener("click", () => setView("json"));
tabSavedButton.addEventListener("click", () => setView("saved"));
serverUrlInput.addEventListener("change", () => persistSettings());
serverTokenInput.addEventListener("change", () => persistSettings());
autoRefreshInput.addEventListener("change", () => persistSettings());
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
    renderError(error);
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
    await notifyBadgeRefresh();
    setStatus("Saved");
    renderOutput();
  } catch (error) {
    setStatus("Error");
    renderError(error);
  }
}

async function copyMarkdown(): Promise<void> {
  if (!lastPreview?.markdown) {
    setStatus("Nothing to copy");
    return;
  }

  await navigator.clipboard.writeText(lastPreview.markdown);
  setStatus("Copied");
}

async function deleteCurrentClip(): Promise<void> {
  await refreshActiveTab();
  if (!activeTab) {
    return;
  }

  setStatus("Deleting");
  try {
    const deleted = await createKnowledgeApiClient(settings).deleteClip(activeTab.url);
    lastPreview = lastPreview
      ? { ...lastPreview, status: { ...lastPreview.status, saved: false } }
      : undefined;
    await loadSavedClips();
    await notifyBadgeRefresh();
    setStatus(deleted.deleted ? "Deleted" : "Not saved");
    renderOutput();
  } catch (error) {
    setStatus("Error");
    renderError(error);
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
  previewOutput.hidden = activeView !== "preview";
  codeOutput.hidden = activeView !== "json";
  savedList.hidden = activeView !== "saved";
  if (activeView === "saved") {
    renderSavedList();
    return;
  }

  if (!lastPreview) {
    previewOutput.replaceChildren();
    codeOutput.textContent = "";
    return;
  }
  previewOutput.replaceChildren(renderMarkdown(lastPreview.markdown));
  codeOutput.textContent = JSON.stringify(lastPreview.document, null, 2);
}

function setMode(mode: InputMode): void {
  settings = { ...settings, inputMode: mode };
  modeBrowserButton.dataset.active = String(mode === "browser_html");
  modeFetchButton.dataset.active = String(mode === "server_fetch");
  void saveSettings({ inputMode: mode });
  scheduleAutoRefresh();
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
    token: serverTokenInput.value,
    autoRefresh: autoRefreshInput.checked
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

function renderError(error: unknown): void {
  previewOutput.hidden = false;
  codeOutput.hidden = true;
  savedList.hidden = true;
  activeView = "preview";
  tabPreviewButton.dataset.active = "true";
  tabJsonButton.dataset.active = "false";
  tabSavedButton.dataset.active = "false";
  const message = error instanceof Error ? error.message : String(error);
  const pre = document.createElement("pre");
  pre.textContent = message;
  previewOutput.replaceChildren(pre);
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
  const lines = markdown.split(/\r?\n/);
  let paragraph: string[] = [];
  let list: HTMLUListElement | undefined;
  let codeBlock: string[] | undefined;

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

  for (const line of lines) {
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
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
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
  flushParagraph();
  flushList();
  return fragment;
}

function appendInlineMarkdown(parent: HTMLElement, text: string): void {
  const parts = text.split(/(`[^`]+`)/g);
  for (const part of parts) {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      const code = document.createElement("code");
      code.textContent = part.slice(1, -1);
      parent.append(code);
    } else if (part) {
      parent.append(document.createTextNode(part));
    }
  }
}

function mustGet<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }
  return element as T;
}
