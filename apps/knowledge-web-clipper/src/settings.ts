import { ExtensionSettings, InputMode, PanelView } from "./types.js";

export const DEFAULT_SETTINGS: ExtensionSettings = {
  serverUrl: "http://127.0.0.1:18765",
  token: "dev-token",
  defaultInputMode: "browser_html",
  allowServerFetch: true,
  autoRefresh: true,
  healthCheckOnOpen: true,
  requestTimeoutMs: 15000,
  showParserDiagnostics: true,
  savedListLimit: 50,
  defaultPanelTab: "preview"
};

export async function getSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get(null);
  return normalizeSettings(stored);
}

export async function saveSettings(settings: Partial<ExtensionSettings>): Promise<void> {
  await chrome.storage.local.set(settings);
}

export async function resetSettings(): Promise<ExtensionSettings> {
  await chrome.storage.local.set(DEFAULT_SETTINGS);
  return DEFAULT_SETTINGS;
}

export function normalizeSettings(stored: Record<string, unknown> | null | undefined): ExtensionSettings {
  const source = stored ?? {};
  const legacyInputMode = asInputMode(source.inputMode, DEFAULT_SETTINGS.defaultInputMode);
  const defaultInputMode = asInputMode(source.defaultInputMode, legacyInputMode);
  const savedListLimit = clampNumber(source.savedListLimit, DEFAULT_SETTINGS.savedListLimit, 10, 200);
  const requestTimeoutMs = clampNumber(source.requestTimeoutMs, DEFAULT_SETTINGS.requestTimeoutMs, 3000, 60000);

  return {
    serverUrl: normalizeServerUrl(source.serverUrl),
    token: String(source.token || DEFAULT_SETTINGS.token),
    defaultInputMode,
    allowServerFetch: source.allowServerFetch !== false,
    autoRefresh: source.autoRefresh !== false,
    healthCheckOnOpen: source.healthCheckOnOpen !== false,
    requestTimeoutMs,
    showParserDiagnostics: source.showParserDiagnostics !== false,
    savedListLimit,
    defaultPanelTab: asPanelView(source.defaultPanelTab, DEFAULT_SETTINGS.defaultPanelTab)
  };
}

export function sanitizeSettingsForDiagnostics(settings: ExtensionSettings): Omit<ExtensionSettings, "token"> & {
  token: string;
} {
  return {
    ...settings,
    token: settings.token ? "********" : ""
  };
}

function normalizeServerUrl(value: unknown): string {
  const url = String(value || DEFAULT_SETTINGS.serverUrl).trim().replace(/\/+$/, "");
  return url || DEFAULT_SETTINGS.serverUrl;
}

function asInputMode(value: unknown, fallback: InputMode): InputMode {
  return value === "server_fetch" || value === "browser_html" ? value : fallback;
}

function asPanelView(value: unknown, fallback: PanelView): PanelView {
  return value === "preview" || value === "json" || value === "rawdoc" || value === "parser" || value === "saved"
    ? value
    : fallback;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(numberValue)));
}
