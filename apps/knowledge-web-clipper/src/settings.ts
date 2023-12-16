import {
  ExtensionSettings,
  InputMode,
  PanelView,
  ServerProfile,
  ServerProfileExportPayload,
  ServerProfileState
} from "./types.js";

export const SERVER_PROFILES_KEY = "serverProfiles";
export const ACTIVE_SERVER_PROFILE_KEY = "activeServerProfileId";
export const SERVER_PROFILE_EXPORT_PREFIX = "uknowledge:v1:";
const MAX_PROFILE_EXPORT_LENGTH = 1024 * 1024;

export const DEFAULT_SERVER_PROFILE: ServerProfile = {
  id: "default",
  name: "Default",
  serverUrl: "http://127.0.0.1:18765",
  token: "dev-token"
};

export const DEFAULT_SETTINGS: ExtensionSettings = {
  serverUrl: DEFAULT_SERVER_PROFILE.serverUrl,
  token: DEFAULT_SERVER_PROFILE.token,
  profiles: [DEFAULT_SERVER_PROFILE],
  activeProfileId: DEFAULT_SERVER_PROFILE.id,
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
  await chrome.storage.local.set({
    [SERVER_PROFILES_KEY]: DEFAULT_SETTINGS.profiles,
    [ACTIVE_SERVER_PROFILE_KEY]: DEFAULT_SETTINGS.activeProfileId,
    defaultInputMode: DEFAULT_SETTINGS.defaultInputMode,
    allowServerFetch: DEFAULT_SETTINGS.allowServerFetch,
    autoRefresh: DEFAULT_SETTINGS.autoRefresh,
    healthCheckOnOpen: DEFAULT_SETTINGS.healthCheckOnOpen,
    requestTimeoutMs: DEFAULT_SETTINGS.requestTimeoutMs,
    showParserDiagnostics: DEFAULT_SETTINGS.showParserDiagnostics,
    savedListLimit: DEFAULT_SETTINGS.savedListLimit,
    defaultPanelTab: DEFAULT_SETTINGS.defaultPanelTab
  });
  return DEFAULT_SETTINGS;
}

export function normalizeSettings(stored: Record<string, unknown> | null | undefined): ExtensionSettings {
  const source = stored ?? {};
  const profiles = normalizeProfiles(source[SERVER_PROFILES_KEY]);
  const activeProfileId = stringValue(source[ACTIVE_SERVER_PROFILE_KEY]);
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0];
  const legacyInputMode = asInputMode(source.inputMode, DEFAULT_SETTINGS.defaultInputMode);
  const defaultInputMode = asInputMode(source.defaultInputMode, legacyInputMode);
  const savedListLimit = clampNumber(source.savedListLimit, DEFAULT_SETTINGS.savedListLimit, 10, 200);
  const requestTimeoutMs = clampNumber(source.requestTimeoutMs, DEFAULT_SETTINGS.requestTimeoutMs, 3000, 60000);

  return {
    serverUrl: activeProfile.serverUrl,
    token: activeProfile.token,
    profiles,
    activeProfileId: activeProfile.id,
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

export async function getServerProfileState(): Promise<ServerProfileState> {
  const settings = await getSettings();
  return {
    profiles: settings.profiles,
    activeProfileId: settings.activeProfileId
  };
}

export async function saveServerProfileState(state: ServerProfileState): Promise<ServerProfileState> {
  const normalized = normalizeProfileState(state);
  await chrome.storage.local.set({
    [SERVER_PROFILES_KEY]: normalized.profiles,
    [ACTIVE_SERVER_PROFILE_KEY]: normalized.activeProfileId
  });
  return normalized;
}

export async function setActiveServerProfile(profileId: string): Promise<ServerProfileState> {
  const state = await getServerProfileState();
  if (!state.profiles.some((profile) => profile.id === profileId)) {
    throw new Error("Server profile not found");
  }
  return saveServerProfileState({ ...state, activeProfileId: profileId });
}

export function createServerProfile(input: Pick<ServerProfile, "name" | "serverUrl" | "token">): ServerProfile {
  return normalizeProfile({
    id: globalThis.crypto.randomUUID(),
    ...input
  });
}

export function encodeServerProfileState(state: ServerProfileState): string {
  const normalized = normalizeProfileState(state);
  const payload: ServerProfileExportPayload = {
    schemaVersion: 1,
    activeProfileId: normalized.activeProfileId,
    profiles: normalized.profiles
  };
  const json = JSON.stringify(payload);
  return SERVER_PROFILE_EXPORT_PREFIX + bytesToBase64Url(new TextEncoder().encode(json));
}

export function decodeServerProfileString(value: string): ServerProfileState {
  const input = value.trim();
  if (!input.startsWith(SERVER_PROFILE_EXPORT_PREFIX)) {
    throw new Error("Invalid Knowledge Suite profile string");
  }
  const encoded = input.slice(SERVER_PROFILE_EXPORT_PREFIX.length);
  if (!encoded || encoded.length > MAX_PROFILE_EXPORT_LENGTH || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error("Invalid profile encoding");
  }

  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(base64UrlToBytes(encoded));
  } catch {
    throw new Error("Invalid profile encoding");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new Error("Invalid profile payload");
  }
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== 1 ||
    !Array.isArray(parsed.profiles) ||
    typeof parsed.activeProfileId !== "string"
  ) {
    throw new Error("Unsupported profile version");
  }
  const profiles: ServerProfile[] = [];
  for (const candidate of parsed.profiles) {
    const profile = normalizeProfile(candidate);
    if (profiles.some((existing) => existing.id === profile.id)) {
      throw new Error("Duplicate server profile id");
    }
    profiles.push(profile);
  }
  if (profiles.length === 0 || !profiles.some((profile) => profile.id === parsed.activeProfileId)) {
    throw new Error("Invalid active server profile");
  }
  return { profiles, activeProfileId: parsed.activeProfileId };
}

export function sanitizeSettingsForDiagnostics(settings: ExtensionSettings): Omit<ExtensionSettings, "token" | "profiles"> & {
  token: string;
  profiles: Array<Omit<ServerProfile, "token"> & { token: string }>;
} {
  return {
    ...settings,
    token: settings.token ? "********" : "",
    profiles: settings.profiles.map((profile) => ({
      ...profile,
      token: profile.token ? "********" : ""
    }))
  };
}

function normalizeProfiles(value: unknown): ServerProfile[] {
  if (!Array.isArray(value)) return [{ ...DEFAULT_SERVER_PROFILE }];
  const profiles: ServerProfile[] = [];
  for (const candidate of value) {
    try {
      const profile = normalizeProfile(candidate);
      if (!profiles.some((existing) => existing.id === profile.id)) profiles.push(profile);
    } catch {
      // Ignore invalid stored profiles and keep valid entries.
    }
  }
  return profiles.length > 0 ? profiles : [{ ...DEFAULT_SERVER_PROFILE }];
}

function normalizeProfileState(value: ServerProfileState): ServerProfileState {
  const profiles = normalizeProfiles(value.profiles);
  const requestedId = stringValue(value.activeProfileId);
  const activeProfileId = profiles.some((profile) => profile.id === requestedId)
    ? requestedId!
    : profiles[0].id;
  return { profiles, activeProfileId };
}

function normalizeProfile(value: unknown): ServerProfile {
  if (!isRecord(value)) throw new Error("Invalid server profile");
  const id = stringValue(value.id);
  const name = stringValue(value.name);
  const token = typeof value.token === "string" ? value.token : undefined;
  if (!id || id.length > 128 || !name || name.length > 100 || token === undefined || token.length > 4096) {
    throw new Error("Invalid server profile");
  }
  return {
    id,
    name,
    serverUrl: normalizeServerUrl(value.serverUrl),
    token
  };
}

function normalizeServerUrl(value: unknown): string {
  const url = String(value ?? "").trim().replace(/\/+$/, "");
  if (!url) throw new Error("Invalid server URL");
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

function asInputMode(value: unknown, fallback: InputMode): InputMode {
  return value === "server_fetch" || value === "browser_html" ? value : fallback;
}

function asPanelView(value: unknown, fallback: PanelView): PanelView {
  return value === "preview" || value === "json" || value === "rawdoc" || value === "parser" || value === "saved" || value === "batch"
    ? value
    : fallback;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numberValue)));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
