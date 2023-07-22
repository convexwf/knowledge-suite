export type InputMode = "browser_html" | "server_fetch";

export interface PageSnapshot {
  pageUrl: string;
  canonicalUrl?: string;
  title?: string;
  html: string;
  text?: string;
  capturedAt: string;
  meta: Record<string, string>;
  selectionHtml?: string;
}

export interface ExtensionSettings {
  serverUrl: string;
  token: string;
  inputMode: InputMode;
}

export type ClipRequestBody =
  | { inputMode: "browser_html"; snapshot: PageSnapshot }
  | { inputMode: "server_fetch"; url: string };

export interface ActiveTabInfo {
  tabId: number;
  url: string;
  title?: string;
  isFileUrl: boolean;
}

export interface PreviewResult {
  markdown: string;
  document: unknown;
  status: {
    saved: boolean;
    title?: string;
  };
}

export interface ClipStatusResult {
  normalizedUrl: string;
  urlHash: string;
  saved: boolean;
  savedAt?: string;
  title?: string;
  docId?: string;
  markdownPath?: string;
  documentPath?: string;
}

export interface HealthResult {
  ok: boolean;
  service: string;
  version: string;
  storeRoot: string;
  store: {
    type: string;
    indexPath: string;
  };
  limits: {
    fetchTimeoutMs: number;
    maxHtmlBytes: number;
  };
}
