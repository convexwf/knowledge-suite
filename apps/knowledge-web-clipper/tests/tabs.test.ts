import { beforeEach, describe, expect, it, vi } from "vitest";

function installChromeMock(tabs: Array<{ id?: number; url?: string }>) {
  const create = vi.fn(async () => undefined);
  const update = vi.fn(async () => undefined);
  const query = vi.fn(async () => tabs);

  vi.stubGlobal("chrome", {
    runtime: {
      getURL: vi.fn((path: string) => `chrome-extension://test/${path}`)
    },
    tabs: {
      create,
      query,
      update
    }
  });

  return { create, query, update };
}

describe("extension tab navigation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("reuses an existing reader or items tab", async () => {
    const chromeMock = installChromeMock([{ id: 7, url: "chrome-extension://test/items.html" }]);
    const { openKnowledgePage } = await import("../src/tabs.js");

    await openKnowledgePage("reader.html?itemId=abc");

    expect(chromeMock.query).toHaveBeenCalledWith({ currentWindow: true });
    expect(chromeMock.update).toHaveBeenCalledWith(7, {
      active: true,
      url: "chrome-extension://test/reader.html?itemId=abc"
    });
    expect(chromeMock.create).not.toHaveBeenCalled();
  });

  it("creates a tab when no reader or items tab exists", async () => {
    const chromeMock = installChromeMock([{ id: 8, url: "https://example.com" }]);
    const { openKnowledgePage } = await import("../src/tabs.js");

    await openKnowledgePage("items.html");

    expect(chromeMock.create).toHaveBeenCalledWith({ url: "chrome-extension://test/items.html" });
    expect(chromeMock.update).not.toHaveBeenCalled();
  });
});

