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
