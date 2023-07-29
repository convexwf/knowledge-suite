import { ExtensionSettings } from "./types.js";

export const DEFAULT_SETTINGS: ExtensionSettings = {
  serverUrl: "http://127.0.0.1:18765",
  token: "dev-token",
  inputMode: "browser_html",
  autoRefresh: true
};

export async function getSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return {
    serverUrl: String(stored.serverUrl || DEFAULT_SETTINGS.serverUrl),
    token: String(stored.token || DEFAULT_SETTINGS.token),
    inputMode: stored.inputMode === "server_fetch" ? "server_fetch" : "browser_html",
    autoRefresh: stored.autoRefresh !== false
  };
}

export async function saveSettings(settings: Partial<ExtensionSettings>): Promise<void> {
  await chrome.storage.local.set(settings);
}
