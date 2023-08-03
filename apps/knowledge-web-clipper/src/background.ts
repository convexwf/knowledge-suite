import { createKnowledgeApiClient } from "./api-client.js";
import { getSettings } from "./settings.js";

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void refreshBadge(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete" || changeInfo.url) {
    void refreshBadge(tabId);
  }
});

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (isRefreshBadgeMessage(message)) {
    void refreshBadge(message.tabId);
  }
});

export async function refreshBadge(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url;
    if (!url || url.startsWith("chrome://") || url.startsWith("edge://")) {
      await setBadge(tabId, "", "#808995");
      return;
    }

    const settings = await getSettings();
    const status = await createKnowledgeApiClient(settings).status(url);
    await setBadge(tabId, status.saved ? "OK" : "", status.saved ? "#1f7a4d" : "#808995");
  } catch (error) {
    if (isMissingTabError(error)) {
      return;
    }
    await setBadge(tabId, "OFF", "#808995").catch((badgeError) => {
      if (!isMissingTabError(badgeError)) {
        console.warn("Failed to update Knowledge Web Clipper badge", badgeError);
      }
    });
  }
}

async function setBadge(tabId: number, text: string, color: string): Promise<void> {
  await chrome.action.setBadgeText({ tabId, text });
  await chrome.action.setBadgeBackgroundColor({ tabId, color });
}

function isRefreshBadgeMessage(message: unknown): message is { type: "knowledge.refreshBadge"; tabId: number } {
  return Boolean(
    message &&
    typeof message === "object" &&
    (message as { type?: unknown }).type === "knowledge.refreshBadge" &&
    typeof (message as { tabId?: unknown }).tabId === "number"
  );
}

export function isMissingTabError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("No tab with id") || message.includes("Tabs cannot be edited right now");
}
