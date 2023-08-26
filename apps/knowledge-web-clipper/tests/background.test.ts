import { beforeEach, describe, expect, it, vi } from "vitest";

function installChromeMock(overrides: {
  getTab?: (tabId: number) => Promise<{ url?: string }>;
  setBadgeText?: (details: { tabId: number; text: string }) => Promise<void>;
  setBadgeBackgroundColor?: (details: { tabId: number; color: string }) => Promise<void>;
} = {}) {
  const setBadgeText = vi.fn(overrides.setBadgeText ?? (async () => undefined));
  const setBadgeBackgroundColor = vi.fn(overrides.setBadgeBackgroundColor ?? (async () => undefined));
  const contextMenuCreate = vi.fn();
  const contextMenuRemoveAll = vi.fn((callback?: () => void) => {
    callback?.();
  });

  vi.stubGlobal("chrome", {
    action: {
      setBadgeText,
      setBadgeBackgroundColor
    },
    contextMenus: {
      create: contextMenuCreate,
      removeAll: contextMenuRemoveAll,
      onClicked: { addListener: vi.fn() }
    },
    runtime: {
      getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
      onInstalled: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn() }
    },
    sidePanel: {
      setPanelBehavior: vi.fn(async () => undefined)
    },
    storage: {
      local: {
        get: vi.fn(async (defaults) => defaults)
      }
    },
    tabs: {
      create: vi.fn(async () => undefined),
      get: vi.fn(overrides.getTab ?? (async () => ({ url: "https://example.com/article" }))),
      onActivated: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() }
    }
  });

  return { contextMenuCreate, contextMenuRemoveAll, setBadgeBackgroundColor, setBadgeText };
}

describe("background badge refresh", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("ignores badge refreshes for tabs that no longer exist", async () => {
    const chromeMock = installChromeMock({
      getTab: async () => {
        throw new Error("No tab with id: 1946472716.");
      }
    });
    const { refreshBadge } = await import("../src/background.js");

    await expect(refreshBadge(1946472716)).resolves.toBeUndefined();
    expect(chromeMock.setBadgeText).not.toHaveBeenCalled();
    expect(chromeMock.setBadgeBackgroundColor).not.toHaveBeenCalled();
  });

  it("does not reject when the tab disappears while setting the fallback badge", async () => {
    installChromeMock({
      setBadgeText: async () => {
        throw new Error("No tab with id: 1946472716.");
      }
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("offline", { status: 503 })));
    const { refreshBadge } = await import("../src/background.js");

    await expect(refreshBadge(1946472716)).resolves.toBeUndefined();
  });

  it("registers a reader entry on the action context menu", async () => {
    const chromeMock = installChromeMock();
    const { createActionMenuItems } = await import("../src/background.js");

    createActionMenuItems();

    expect(chromeMock.contextMenuRemoveAll).toHaveBeenCalledWith(expect.any(Function));
    expect(chromeMock.contextMenuCreate).toHaveBeenCalledWith({
      id: "knowledge-open-reader",
      title: "Knowledge Reader",
      contexts: ["action"]
    });
  });
});
