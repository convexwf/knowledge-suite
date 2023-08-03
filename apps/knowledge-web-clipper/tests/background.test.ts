import { beforeEach, describe, expect, it, vi } from "vitest";

function installChromeMock(overrides: {
  getTab?: (tabId: number) => Promise<{ url?: string }>;
  setBadgeText?: (details: { tabId: number; text: string }) => Promise<void>;
  setBadgeBackgroundColor?: (details: { tabId: number; color: string }) => Promise<void>;
} = {}) {
  const setBadgeText = vi.fn(overrides.setBadgeText ?? (async () => undefined));
  const setBadgeBackgroundColor = vi.fn(overrides.setBadgeBackgroundColor ?? (async () => undefined));

  vi.stubGlobal("chrome", {
    action: {
      setBadgeText,
      setBadgeBackgroundColor
    },
    runtime: {
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
      get: vi.fn(overrides.getTab ?? (async () => ({ url: "https://example.com/article" }))),
      onActivated: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() }
    }
  });

  return { setBadgeBackgroundColor, setBadgeText };
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
});
