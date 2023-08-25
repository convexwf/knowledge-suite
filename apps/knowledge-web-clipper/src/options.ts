import { createKnowledgeApiClient } from "./api-client.js";
import { DEFAULT_SETTINGS, getSettings, resetSettings, sanitizeSettingsForDiagnostics, saveSettings } from "./settings.js";
import { ExtensionSettings, InputMode, PanelView, STORE_CLEAR_CONFIRMATION, StoreMaintenanceScan } from "./types.js";

const form = mustGet<HTMLFormElement>("settings-form");
const serverUrlInput = mustGet<HTMLInputElement>("server-url");
const tokenInput = mustGet<HTMLInputElement>("server-token");
const defaultInputModeSelect = mustGet<HTMLSelectElement>("default-input-mode");
const allowServerFetchInput = mustGet<HTMLInputElement>("allow-server-fetch");
const autoRefreshInput = mustGet<HTMLInputElement>("auto-refresh");
const healthCheckInput = mustGet<HTMLInputElement>("health-check-on-open");
const requestTimeoutInput = mustGet<HTMLInputElement>("request-timeout-ms");
const showParserInput = mustGet<HTMLInputElement>("show-parser-diagnostics");
const savedListLimitInput = mustGet<HTMLInputElement>("saved-list-limit");
const defaultPanelTabSelect = mustGet<HTMLSelectElement>("default-panel-tab");
const testButton = mustGet<HTMLButtonElement>("test-connection");
const resetButton = mustGet<HTMLButtonElement>("reset-settings");
const scanStoreButton = mustGet<HTMLButtonElement>("scan-store");
const clearStoreConfirmationInput = mustGet<HTMLInputElement>("clear-store-confirmation");
const clearStoreButton = mustGet<HTMLButtonElement>("clear-store");
const storeScanOutput = mustGet<HTMLElement>("store-scan-output");
const statusOutput = mustGet<HTMLElement>("status-output");
const versionOutput = mustGet<HTMLElement>("extension-version");

versionOutput.textContent = chrome.runtime.getManifest().version;
let settings = await getSettings();
let latestStoreScan: StoreMaintenanceScan | undefined;
renderSettings(settings);

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveCurrentSettings();
});
testButton.addEventListener("click", () => testConnection());
resetButton.addEventListener("click", () => resetToDefaults());
scanStoreButton.addEventListener("click", () => scanStore());
clearStoreButton.addEventListener("click", () => clearStore());
clearStoreConfirmationInput.addEventListener("input", () => updateClearStoreAvailability());

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

async function scanStore(): Promise<void> {
  const draft = readSettingsFromForm();
  const client = createKnowledgeApiClient(draft);
  setStoreScanStatus("Scanning", "Reading local store tables and content folders...");
  latestStoreScan = undefined;
  updateClearStoreAvailability();
  try {
    latestStoreScan = await client.scanStore();
    setStoreScanStatus("Scan complete", formatStoreScan(latestStoreScan));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStoreScanStatus("Scan failed", message);
  } finally {
    updateClearStoreAvailability();
  }
}

async function clearStore(): Promise<void> {
  if (!latestStoreScan || clearStoreConfirmationInput.value.trim() !== STORE_CLEAR_CONFIRMATION) {
    updateClearStoreAvailability();
    return;
  }

  const rows = latestStoreScan.totals.rows;
  const files = latestStoreScan.totals.contentFiles;
  const confirmed = globalThis.confirm(
    `Clear the local knowledge store?\n\nThis will delete ${rows} database rows and ${files} stored content files.`
  );
  if (!confirmed) {
    return;
  }

  const draft = readSettingsFromForm();
  const client = createKnowledgeApiClient(draft);
  clearStoreButton.disabled = true;
  setStoreScanStatus("Clearing", "Deleting local store database rows and stored content files...");
  try {
    const result = await client.clearStore();
    latestStoreScan = result.after;
    clearStoreConfirmationInput.value = "";
    setStoreScanStatus(
      "Store cleared",
      [
        "Before:",
        formatStoreScan(result.before),
        "",
        "After:",
        formatStoreScan(result.after)
      ].join("\n")
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStoreScanStatus("Clear failed", message);
  } finally {
    updateClearStoreAvailability();
  }
}

function renderSettings(value: ExtensionSettings): void {
  serverUrlInput.value = value.serverUrl;
  tokenInput.value = value.token;
  defaultInputModeSelect.value = value.defaultInputMode;
  allowServerFetchInput.checked = value.allowServerFetch;
  autoRefreshInput.checked = value.autoRefresh;
  healthCheckInput.checked = value.healthCheckOnOpen;
  requestTimeoutInput.value = String(value.requestTimeoutMs);
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
    showParserDiagnostics: showParserInput.checked,
    savedListLimit: clampNumber(savedListLimitInput.value, DEFAULT_SETTINGS.savedListLimit, 10, 200),
    defaultPanelTab: asPanelView(defaultPanelTabSelect.value)
  };
}

function setStatus(title: string, detail: string): void {
  setOutput(statusOutput, title, detail);
}

function setStoreScanStatus(title: string, detail: string): void {
  setOutput(storeScanOutput, title, detail);
}

function setOutput(target: HTMLElement, title: string, detail: string): void {
  target.replaceChildren();
  const heading = document.createElement("strong");
  heading.textContent = title;
  const body = document.createElement("pre");
  body.textContent = detail;
  target.append(heading, body);
}

function updateClearStoreAvailability(): void {
  clearStoreButton.disabled = !latestStoreScan ||
    clearStoreConfirmationInput.value.trim() !== STORE_CLEAR_CONFIRMATION ||
    (latestStoreScan.totals.rows === 0 && latestStoreScan.totals.contentFiles === 0);
}

function formatStoreScan(scan: StoreMaintenanceScan): string {
  return [
    `Store root: ${scan.storeRoot}`,
    `Database: ${scan.database.exists ? "present" : "missing"} (${scan.database.sizeBytes} bytes)`,
    `Rows: ${scan.totals.rows}`,
    `Content files: ${scan.totals.contentFiles}`,
    `Tables: clips=${scan.tables.clips}, rawdocs=${scan.tables.rawdocs}, documents=${scan.tables.documents}, chunks=${scan.tables.chunks}, collections=${scan.tables.collections}, collectionItems=${scan.tables.collectionItems}, batchJobs=${scan.tables.batchJobs}, batchItems=${scan.tables.batchItems}`,
    `Files: rawdocs=${scan.files.rawdocs}, documents=${scan.files.documents}, markdown=${scan.files.markdown}, assets=${scan.files.assets}`,
    `Scanned at: ${scan.scannedAt}`
  ].join("\n");
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
