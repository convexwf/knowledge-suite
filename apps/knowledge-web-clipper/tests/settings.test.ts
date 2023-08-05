import { beforeEach, describe, expect, it, vi } from "vitest";

describe("extension settings", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("normalizes defaults and legacy inputMode values", async () => {
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async () => ({
            inputMode: "server_fetch",
            requestTimeoutMs: 999999,
            savedListLimit: 3
          }))
        }
      }
    });
    const { getSettings } = await import("../src/settings.js");

    await expect(getSettings()).resolves.toMatchObject({
      defaultInputMode: "server_fetch",
      allowServerFetch: true,
      requestTimeoutMs: 60000,
      savedListLimit: 10
    });
  });

  it("redacts tokens in diagnostics", async () => {
    const { DEFAULT_SETTINGS, sanitizeSettingsForDiagnostics } = await import("../src/settings.js");

    expect(sanitizeSettingsForDiagnostics({ ...DEFAULT_SETTINGS, token: "secret-token" })).toMatchObject({
      token: "********"
    });
  });
});
