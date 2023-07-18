import { PageSnapshot } from "./types.js";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "knowledge.collectSnapshot") {
    return false;
  }

  sendResponse(collectSnapshot());
  return true;
});

function collectSnapshot(): PageSnapshot {
  return {
    pageUrl: location.href,
    canonicalUrl: document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href,
    title: document.title,
    html: document.documentElement.outerHTML,
    text: document.body?.innerText,
    capturedAt: new Date().toISOString(),
    meta: collectMeta(),
    selectionHtml: collectSelectionHtml()
  };
}

function collectMeta(): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const item of Array.from(document.querySelectorAll<HTMLMetaElement>("meta"))) {
    const key = item.name || item.getAttribute("property") || item.getAttribute("http-equiv");
    const content = item.content;
    if (key && content) {
      meta[key] = content;
    }
  }
  return meta;
}

function collectSelectionHtml(): string | undefined {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return undefined;
  }

  const container = document.createElement("div");
  for (let index = 0; index < selection.rangeCount; index += 1) {
    container.append(selection.getRangeAt(index).cloneContents());
  }
  return container.innerHTML || undefined;
}
