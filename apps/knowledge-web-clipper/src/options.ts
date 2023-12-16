import { createKnowledgeApiClient } from "./api-client.js";
import {
  createServerProfile,
  decodeServerProfileString,
  DEFAULT_SETTINGS,
  encodeServerProfileState,
  getSettings,
  resetSettings,
  sanitizeSettingsForDiagnostics,
  saveServerProfileState,
  saveSettings
} from "./settings.js";
import { openKnowledgePage } from "./tabs.js";
import {
  ExtensionSettings,
  InputMode,
  PanelView,
  ServerProfile,
  StoreMaintenanceScan
} from "./types.js";

const form = mustGet<HTMLFormElement>("settings-form");
const serverProfileSelect = mustGet<HTMLSelectElement>("server-profile-select");
const addServerProfileButton = mustGet<HTMLButtonElement>("add-server-profile");
const editServerProfileButton = mustGet<HTMLButtonElement>("edit-server-profile");
const deleteServerProfileButton = mustGet<HTMLButtonElement>("delete-server-profile");
const exportServerProfilesButton = mustGet<HTMLButtonElement>("export-server-profiles");
const importServerProfilesButton = mustGet<HTMLButtonElement>("import-server-profiles");
const profileActionsMenu = mustGet<HTMLDetailsElement>("profile-actions-menu");
const serverProfileDialog = mustGet<HTMLDialogElement>("server-profile-dialog");
const serverProfileDialogTitle = mustGet<HTMLElement>("server-profile-dialog-title");
const serverProfileForm = mustGet<HTMLFormElement>("server-profile-form");
const profileNameInput = mustGet<HTMLInputElement>("profile-name");
const profileUrlInput = mustGet<HTMLInputElement>("profile-url");
const profileTokenInput = mustGet<HTMLInputElement>("profile-token");
const profileDialogCancelButton = mustGet<HTMLButtonElement>("profile-dialog-cancel");
const serverProfileExportDialog = mustGet<HTMLDialogElement>("server-profile-export-dialog");
const profileExportValue = mustGet<HTMLTextAreaElement>("profile-export-value");
const profileExportCopyButton = mustGet<HTMLButtonElement>("profile-export-copy");
const profileExportCloseButton = mustGet<HTMLButtonElement>("profile-export-close");
const serverProfileImportDialog = mustGet<HTMLDialogElement>("server-profile-import-dialog");
const serverProfileImportForm = mustGet<HTMLFormElement>("server-profile-import-form");
const profileImportValue = mustGet<HTMLTextAreaElement>("profile-import-value");
const profileImportCancelButton = mustGet<HTMLButtonElement>("profile-import-cancel");
const connectionStatusOutput = mustGet<HTMLElement>("connection-status");
const profileTestConnectionButton = mustGet<HTMLButtonElement>("profile-test-connection");
const profileTestStatusOutput = mustGet<HTMLElement>("profile-test-status");
const defaultInputModeSelect = mustGet<HTMLSelectElement>("default-input-mode");
const allowServerFetchInput = mustGet<HTMLInputElement>("allow-server-fetch");
const autoRefreshInput = mustGet<HTMLInputElement>("auto-refresh");
const healthCheckInput = mustGet<HTMLInputElement>("health-check-on-open");
const requestTimeoutInput = mustGet<HTMLInputElement>("request-timeout-ms");
const showParserInput = mustGet<HTMLInputElement>("show-parser-diagnostics");
const savedListLimitInput = mustGet<HTMLInputElement>("saved-list-limit");
const defaultPanelTabSelect = mustGet<HTMLSelectElement>("default-panel-tab");
const openItemsButton = mustGet<HTMLButtonElement>("open-items");
const testButton = mustGet<HTMLButtonElement>("test-connection");
const resetButton = mustGet<HTMLButtonElement>("reset-settings");
const scanStoreButton = mustGet<HTMLButtonElement>("scan-store");
const clearParsedButton = mustGet<HTMLButtonElement>("clear-parsed-results");
const clearStoreButton = mustGet<HTMLButtonElement>("clear-store");
const storeScanOutput = mustGet<HTMLElement>("store-scan-output");
const statusOutput = mustGet<HTMLElement>("status-output");
const versionOutput = mustGet<HTMLElement>("extension-version");

versionOutput.textContent = chrome.runtime.getManifest().version;
let settings = await getSettings();
let latestStoreScan: StoreMaintenanceScan | undefined;
let editingProfileId: string | undefined;
let profilesReloadPromise: Promise<void> | undefined;
renderSettings(settings);

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveCurrentSettings();
});
openItemsButton.addEventListener("click", () => {
  void openKnowledgePage("items.html");
});
testButton.addEventListener("click", () => testConnection());
resetButton.addEventListener("click", () => resetToDefaults());
scanStoreButton.addEventListener("click", () => scanStore());
clearParsedButton.addEventListener("click", () => clearParsedResults());
clearStoreButton.addEventListener("click", () => clearStore());
serverProfileSelect.addEventListener("change", () => void selectServerProfile());
addServerProfileButton.addEventListener("click", () => {
  closeProfileActionsMenu();
  openProfileDialog();
});
editServerProfileButton.addEventListener("click", () => {
  closeProfileActionsMenu();
  openProfileDialog(currentProfile());
});
deleteServerProfileButton.addEventListener("click", () => {
  closeProfileActionsMenu();
  void deleteCurrentProfile();
});
exportServerProfilesButton.addEventListener("click", () => {
  closeProfileActionsMenu();
  openExportDialog();
});
importServerProfilesButton.addEventListener("click", () => {
  closeProfileActionsMenu();
  openImportDialog();
});
profileDialogCancelButton.addEventListener("click", () => serverProfileDialog.close());
serverProfileForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveProfileFromDialog();
});
profileExportCopyButton.addEventListener("click", () => void copyExportValue());
profileExportCloseButton.addEventListener("click", () => serverProfileExportDialog.close());
profileImportCancelButton.addEventListener("click", () => serverProfileImportDialog.close());
profileTestConnectionButton.addEventListener("click", () => void testProfileFromDialog());
serverProfileImportForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void importProfilesFromDialog();
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && ("serverProfiles" in changes || "activeServerProfileId" in changes)) {
    void reloadProfiles();
  }
});

document.addEventListener("click", (event) => {
  if (!profileActionsMenu.contains(event.target as Node)) {
    closeProfileActionsMenu();
  }
});

async function saveCurrentSettings(): Promise<void> {
  const draft = readSettingsFromForm();
  await saveSettings({
    defaultInputMode: draft.defaultInputMode,
    allowServerFetch: draft.allowServerFetch,
    autoRefresh: draft.autoRefresh,
    healthCheckOnOpen: draft.healthCheckOnOpen,
    requestTimeoutMs: draft.requestTimeoutMs,
    showParserDiagnostics: draft.showParserDiagnostics,
    savedListLimit: draft.savedListLimit,
    defaultPanelTab: draft.defaultPanelTab
  });
  settings = await getSettings();
  renderSettings(settings);
  setStatus("Saved", "Settings saved.");
}

async function testConnection(): Promise<void> {
  const draft = readSettingsFromForm();
  await runConnectionTest(draft.serverUrl, draft.token, connectionStatusOutput, testButton);
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
  if (!latestStoreScan) {
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

async function clearParsedResults(): Promise<void> {
  if (!latestStoreScan) {
    updateClearStoreAvailability();
    return;
  }

  const impact = parsedImpact(latestStoreScan);
  const confirmed = globalThis.confirm(
    [
      "Clear parsed results but keep raw captures?",
      "",
      `This will remove ${impact.rows} parsed-result rows and ${impact.files} derived files.`,
      `Raw capture rows/files will remain for later reparse.`
    ].join("\n")
  );
  if (!confirmed) {
    return;
  }

  const draft = readSettingsFromForm();
  const client = createKnowledgeApiClient(draft);
  clearParsedButton.disabled = true;
  setStoreScanStatus("Clearing parsed results", "Deleting parser outputs while preserving raw captures...");
  try {
    const result = await client.clearParsedResults();
    latestStoreScan = result.after;
    setStoreScanStatus(
      "Parsed results cleared",
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
    setStoreScanStatus("Parsed-results clear failed", message);
  } finally {
    updateClearStoreAvailability();
  }
}

function renderSettings(value: ExtensionSettings): void {
  renderProfileOptions(value);
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
    ...settings,
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

function renderProfileOptions(value: ExtensionSettings): void {
  serverProfileSelect.replaceChildren(...value.profiles.map((profile) => {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.name;
    option.selected = profile.id === value.activeProfileId;
    return option;
  }));
  editServerProfileButton.disabled = value.profiles.length === 0;
  deleteServerProfileButton.disabled = value.profiles.length <= 1;
}

function closeProfileActionsMenu(): void {
  profileActionsMenu.open = false;
}

function currentProfile(): ServerProfile | undefined {
  return settings.profiles.find((profile) => profile.id === settings.activeProfileId);
}

async function selectServerProfile(): Promise<void> {
  try {
    await saveServerProfileState({ profiles: settings.profiles, activeProfileId: serverProfileSelect.value });
    await reloadProfiles();
  } catch (error) {
    setStatus("Profile switch failed", errorMessage(error));
    renderProfileOptions(settings);
  }
}

function openProfileDialog(profile?: ServerProfile): void {
  editingProfileId = profile?.id;
  serverProfileDialogTitle.textContent = profile ? "Edit Server Profile" : "Add Server Profile";
  profileNameInput.value = profile?.name ?? "";
  profileUrlInput.value = profile?.serverUrl ?? DEFAULT_SETTINGS.serverUrl;
  profileTokenInput.value = profile?.token ?? "";
  profileTestStatusOutput.hidden = true;
  profileTestStatusOutput.replaceChildren();
  serverProfileDialog.showModal();
}

async function testProfileFromDialog(): Promise<void> {
  await runConnectionTest(
    profileUrlInput.value,
    profileTokenInput.value,
    profileTestStatusOutput,
    profileTestConnectionButton
  );
}

async function runConnectionTest(
  serverUrl: string,
  token: string,
  output: HTMLElement,
  button: HTMLButtonElement
): Promise<void> {
  const previousText = button.textContent || "Test Connection";
  button.disabled = true;
  button.textContent = "Testing...";
  output.hidden = false;
  setOutput(output, "Checking", "Connecting to the knowledge server...");
  try {
    const normalizedUrl = normalizeConnectionUrl(serverUrl);
    const health = await createKnowledgeApiClient({ ...settings, serverUrl: normalizedUrl, token }).health();
    setOutput(output, "Connected", `${health.service} ${health.version} · ${health.storeRoot}`);
  } catch (error) {
    setOutput(output, "Connection failed", errorMessage(error));
  } finally {
    button.disabled = false;
    button.textContent = previousText;
  }
}

function normalizeConnectionUrl(value: string): string {
  const url = value.trim().replace(/\/+$/, "");
  if (!url) {
    throw new Error("Invalid server URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid server URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Invalid server URL");
  }
  return url;
}

async function saveProfileFromDialog(): Promise<void> {
  const name = profileNameInput.value.trim();
  const serverUrl = profileUrlInput.value.trim();
  if (!name || !serverUrl) return;
  try {
    const nextProfile = editingProfileId
      ? { id: editingProfileId, name, serverUrl, token: profileTokenInput.value }
      : createServerProfile({ name, serverUrl, token: profileTokenInput.value });
    const profiles = settings.profiles.filter((candidate) => candidate.id !== editingProfileId);
    profiles.push(nextProfile);
    await saveServerProfileState({ profiles, activeProfileId: settings.activeProfileId });
    serverProfileDialog.close();
    await reloadProfiles();
    setStatus("Saved", `Server profile ${name} saved.`);
  } catch (error) {
    setStatus("Profile save failed", errorMessage(error));
  }
}

async function deleteCurrentProfile(): Promise<void> {
  const profile = currentProfile();
  if (!profile || settings.profiles.length <= 1) return;
  if (!globalThis.confirm(`Delete server profile "${profile.name}"?`)) return;
  try {
    const profiles = settings.profiles.filter((candidate) => candidate.id !== profile.id);
    await saveServerProfileState({ profiles, activeProfileId: profiles[0].id });
    await reloadProfiles();
    setStatus("Deleted", `Server profile ${profile.name} deleted.`);
  } catch (error) {
    setStatus("Profile delete failed", errorMessage(error));
  }
}

function openExportDialog(): void {
  profileExportValue.value = encodeServerProfileState({
    profiles: settings.profiles,
    activeProfileId: settings.activeProfileId
  });
  serverProfileExportDialog.showModal();
  profileExportValue.select();
}

async function copyExportValue(): Promise<void> {
  await navigator.clipboard.writeText(profileExportValue.value);
  setStatus("Copied", "Server profile string copied.");
}

function openImportDialog(): void {
  profileImportValue.value = "";
  serverProfileImportDialog.showModal();
}

async function importProfilesFromDialog(): Promise<void> {
  try {
    const imported = decodeServerProfileString(profileImportValue.value);
    const byId = new Map(settings.profiles.map((profile) => [profile.id, profile]));
    for (const profile of imported.profiles) byId.set(profile.id, profile);
    await saveServerProfileState({
      profiles: Array.from(byId.values()),
      activeProfileId: settings.activeProfileId
    });
    serverProfileImportDialog.close();
    await reloadProfiles();
    setStatus("Imported", "Server profiles imported.");
  } catch (error) {
    setStatus("Profile import failed", errorMessage(error));
  }
}

async function reloadProfiles(): Promise<void> {
  if (profilesReloadPromise) return profilesReloadPromise;
  profilesReloadPromise = reloadProfilesInternal();
  try {
    await profilesReloadPromise;
  } finally {
    profilesReloadPromise = undefined;
  }
}

async function reloadProfilesInternal(): Promise<void> {
  settings = await getSettings();
  renderSettings(settings);
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
  const impact = latestStoreScan ? parsedImpact(latestStoreScan) : { rows: 0, files: 0 };
  clearParsedButton.disabled = !latestStoreScan ||
    (impact.rows === 0 && impact.files === 0);
  clearStoreButton.disabled = !latestStoreScan ||
    (latestStoreScan.totals.rows === 0 && latestStoreScan.totals.contentFiles === 0);
}

function formatStoreScan(scan: StoreMaintenanceScan): string {
  const impact = parsedImpact(scan);
  return [
    `Store root: ${scan.storeRoot}`,
    `Database: ${scan.database.exists ? "present" : "missing"} (${scan.database.sizeBytes} bytes)`,
    `Rows: ${scan.totals.rows}`,
    `Content files: ${scan.totals.contentFiles}`,
    `Parsed impact: items=${impact.items}, webItems=${impact.webItems}, rows=${impact.rows}, files=${impact.files}, collectionRefs=${impact.collectionItemRefs}, batchRefs=${impact.batchItemRefs}`,
    `Tables: knowledgeItems=${scan.tables.knowledgeItems ?? 0}, webItems=${scan.tables.webItems}, epubMetadata=${scan.tables.epubMetadata ?? 0}, rawdocs=${scan.tables.rawdocs}, documents=${scan.tables.documents}, chunks=${scan.tables.chunks}, collections=${scan.tables.collections}, collectionItems=${scan.tables.collectionItems}, batchJobs=${scan.tables.batchJobs}, batchItems=${scan.tables.batchItems}`,
    `Files: rawdocs=${scan.files.rawdocs}, documents=${scan.files.documents}, markdown=${scan.files.markdown}, assets=${scan.files.assets}`,
    `Scanned at: ${scan.scannedAt}`
  ].join("\n");
}

function parsedImpact(scan: StoreMaintenanceScan): {
  webItems: number;
  items: number;
  rows: number;
  files: number;
  collectionItemRefs: number;
  batchItemRefs: number;
} {
  const parsedResults = scan.parsedResults;
  if (parsedResults) {
    return {
      items: parsedResults.parsedItems ?? 0,
      webItems: parsedResults.parsedWebItems,
      rows: parsedResults.documentRows + parsedResults.chunkRows,
      files: parsedResults.derivedFiles,
      collectionItemRefs: parsedResults.collectionItemRefs,
      batchItemRefs: parsedResults.batchItemRefs
    };
  }

  return {
    items: scan.tables.knowledgeItems ?? 0,
    webItems: scan.tables.documents,
    rows: scan.tables.documents + scan.tables.chunks,
    files: scan.files.documents + scan.files.markdown + scan.files.assets,
    collectionItemRefs: 0,
    batchItemRefs: 0
  };
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
