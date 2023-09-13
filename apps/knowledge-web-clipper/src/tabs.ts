const READER_PAGE = "reader.html";
const ITEMS_PAGE = "items.html";
const REUSABLE_PAGES = [READER_PAGE, ITEMS_PAGE];

export async function openKnowledgePage(path: string): Promise<void> {
  const url = chrome.runtime.getURL(path);
  const reusableTab = await findReusableKnowledgeTab();
  if (reusableTab?.id !== undefined) {
    await chrome.tabs.update(reusableTab.id, { active: true, url });
    return;
  }
  await chrome.tabs.create({ url });
}

async function findReusableKnowledgeTab(): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return tabs.find((tab) => {
    const url = tab.url ?? "";
    return REUSABLE_PAGES.some((page) => url.startsWith(chrome.runtime.getURL(page)));
  });
}

