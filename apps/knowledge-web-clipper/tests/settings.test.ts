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

    expect(sanitizeSettingsForDiagnostics({
      ...DEFAULT_SETTINGS,
      token: "secret-token",
      profiles: [{ ...DEFAULT_SETTINGS.profiles[0], token: "profile-secret" }]
    })).toMatchObject({
      token: "********",
      profiles: [{ token: "********" }]
    });
  });

  it("uses the default profile when no profile store exists", async () => {
    vi.stubGlobal("chrome", {
      storage: { local: { get: vi.fn(async () => ({ serverUrl: "http://old.example", token: "old-token" })) } }
    });
    const { getSettings } = await import("../src/settings.js");

    await expect(getSettings()).resolves.toMatchObject({
      serverUrl: "http://127.0.0.1:18765",
      token: "dev-token",
      activeProfileId: "default",
      profiles: [{ id: "default" }]
    });
  });

  it("round-trips profiles through one portable string", async () => {
    const { decodeServerProfileString, encodeServerProfileState } = await import("../src/settings.js");
    const state = {
      activeProfileId: "remote",
      profiles: [
        { id: "local", name: "本地书库", serverUrl: "http://127.0.0.1:18765", token: "本地-token?&" },
        { id: "remote", name: "Remote / 研发", serverUrl: "https://knowledge.example/a?b=中文", token: "remote-token/特殊" }
      ]
    };

    expect(decodeServerProfileString(encodeServerProfileState(state))).toEqual(state);
  });
});
