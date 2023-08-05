import { createKnowledgeApiClient } from "./api-client.js";
import { DEFAULT_SETTINGS, getSettings, resetSettings, sanitizeSettingsForDiagnostics, saveSettings } from "./settings.js";
import { ExtensionSettings, InputMode, PanelView } from "./types.js";

const form = mustGet<HTMLFormElement>("settings-form");
const serverUrlInput = mustGet<HTMLInputElement>("server-url");
const tokenInput = mustGet<HTMLInputElement>("server-token");
const defaultInputModeSelect = mustGet<HTMLSelectElement>("default-input-mode");
const allowServerFetchInput = mustGet<HTMLInputElement>("allow-server-fetch");
const autoRefreshInput = mustGet<HTMLInputElement>("auto-refresh");
const healthCheckInput = mustGet<HTMLInputElement>("health-check-on-open");
const requestTimeoutInput = mustGet<HTMLInputElement>("request-timeout-ms");
const deleteFilesInput = mustGet<HTMLInputElement>("delete-files-by-default");
const showParserInput = mustGet<HTMLInputElement>("show-parser-diagnostics");
const savedListLimitInput = mustGet<HTMLInputElement>("saved-list-limit");
const defaultPanelTabSelect = mustGet<HTMLSelectElement>("default-panel-tab");
const testButton = mustGet<HTMLButtonElement>("test-connection");
const resetButton = mustGet<HTMLButtonElement>("reset-settings");
const statusOutput = mustGet<HTMLElement>("status-output");
const versionOutput = mustGet<HTMLElement>("extension-version");

versionOutput.textContent = chrome.runtime.getManifest().version;
let settings = await getSettings();
renderSettings(settings);

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveCurrentSettings();
});
testButton.addEventListener("click", () => testConnection());
resetButton.addEventListener("click", () => resetToDefaults());

async function saveCurrentSettings(): Promise<void> {
  settings = readSettingsFromForm();
  await saveSettings(settings);
  setStatus("Saved", "Settings saved.");
}

async function testConnection(): Promise<void> {
  const draft = readSettingsFromForm();
  setStatus("Checking", "Connecting to the local knowledge server...");
  try {
    const health = await createKnowledgeApiClient(draft).health();
    setStatus("Connected", `${health.service} ${health.version} · ${health.storeRoot}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus("Connection failed", message);
  }
}

async function resetToDefaults(): Promise<void> {
  settings = await resetSettings();
  renderSettings(settings);
  setStatus("Reset", "Settings restored to defaults.");
}

function renderSettings(value: ExtensionSettings): void {
  serverUrlInput.value = value.serverUrl;
  tokenInput.value = value.token;
  defaultInputModeSelect.value = value.defaultInputMode;
  allowServerFetchInput.checked = value.allowServerFetch;
  autoRefreshInput.checked = value.autoRefresh;
  healthCheckInput.checked = value.healthCheckOnOpen;
  requestTimeoutInput.value = String(value.requestTimeoutMs);
  deleteFilesInput.checked = value.deleteFilesByDefault;
  showParserInput.checked = value.showParserDiagnostics;
  savedListLimitInput.value = String(value.savedListLimit);
  defaultPanelTabSelect.value = value.defaultPanelTab;
  setStatus("Ready", JSON.stringify(sanitizeSettingsForDiagnostics(value), null, 2));
}

function readSettingsFromForm(): ExtensionSettings {
  return {
    serverUrl: serverUrlInput.value.trim().replace(/\/+$/, "") || DEFAULT_SETTINGS.serverUrl,
    token: tokenInput.value,
    defaultInputMode: asInputMode(defaultInputModeSelect.value),
    allowServerFetch: allowServerFetchInput.checked,
    autoRefresh: autoRefreshInput.checked,
    healthCheckOnOpen: healthCheckInput.checked,
    requestTimeoutMs: clampNumber(requestTimeoutInput.value, DEFAULT_SETTINGS.requestTimeoutMs, 3000, 60000),
    deleteFilesByDefault: deleteFilesInput.checked,
    showParserDiagnostics: showParserInput.checked,
    savedListLimit: clampNumber(savedListLimitInput.value, DEFAULT_SETTINGS.savedListLimit, 10, 200),
    defaultPanelTab: asPanelView(defaultPanelTabSelect.value)
  };
}

function setStatus(title: string, detail: string): void {
  statusOutput.replaceChildren();
  const heading = document.createElement("strong");
  heading.textContent = title;
  const body = document.createElement("pre");
  body.textContent = detail;
  statusOutput.append(heading, body);
}

function asInputMode(value: string): InputMode {
  return value === "server_fetch" ? "server_fetch" : "browser_html";
}

function asPanelView(value: string): PanelView {
  return value === "json" || value === "rawdoc" || value === "parser" || value === "saved" ? value : "preview";
}

function clampNumber(value: string, fallback: number, min: number, max: number): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(numberValue)));
}

function mustGet<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }
  return element as T;
}
