import { createKnowledgeApiClient } from "./api-client.js";
import { getSettings } from "./settings.js";

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await refreshBadge(tabId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status === "complete" || changeInfo.url) {
    await refreshBadge(tabId);
  }
});

async function refreshBadge(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url;
    if (!url || url.startsWith("chrome://") || url.startsWith("edge://")) {
      await setBadge(tabId, "", "#808995");
      return;
    }

    const settings = await getSettings();
    const status = await createKnowledgeApiClient(settings).status(url);
    await setBadge(tabId, status.saved ? "OK" : "NEW", status.saved ? "#1f7a4d" : "#40566f");
  } catch {
    await setBadge(tabId, "OFF", "#808995");
  }
}

async function setBadge(tabId: number, text: string, color: string): Promise<void> {
  await chrome.action.setBadgeText({ tabId, text });
  await chrome.action.setBadgeBackgroundColor({ tabId, color });
}
