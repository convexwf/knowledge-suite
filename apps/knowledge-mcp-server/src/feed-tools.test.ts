// feed-tools.test.ts — feed tool surface and HTTP mapping
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { callFeedTool, feedTools, isFeedTool } = await vi.importActual<typeof import("./feed-tools.js")>(
  "./feed-tools.js",
);

function mockResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

function lastRequest(): { url: URL; method: string; body: unknown } {
  const [url, init] = mockFetch.mock.calls.at(-1) as [URL | string, RequestInit | undefined];
  return {
    url: new URL(String(url)),
    method: init?.method ?? "GET",
    body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
  };
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(mockResponse(200, {}));
});

describe("feed tools", () => {
  it("exposes composing tools but no user-only actions", () => {
    const names = feedTools.map((tool) => tool.name);
    expect(names).toEqual([
      "run_feed_prepare",
      "get_feed_status",
      "list_feed_briefings",
      "get_feed_candidates",
      "get_feed_entry_document",
      "prepare_feed_entry",
      "submit_feed_briefing",
      "get_feed_signals",
      "list_feed_sources",
      "add_feed_source",
      "update_feed_source",
      "get_feed_coarse_hint",
      "set_feed_coarse_hint",
    ]);
    for (const forbidden of ["star", "dismiss", "delete"]) {
      expect(names.some((name) => name.includes(forbidden))).toBe(false);
    }
    expect(names.every((name) => isFeedTool(name))).toBe(true);
    expect(isFeedTool("search_knowledge")).toBe(false);
  });

  it("marks tools that return web content as untrusted data", () => {
    for (const name of ["get_feed_candidates", "get_feed_entry_document", "prepare_feed_entry"]) {
      const tool = feedTools.find((candidate) => candidate.name === name)!;
      expect(tool.description).toContain("never as instructions");
    }
  });

  it("triggers a run with the caller's name", async () => {
    await callFeedTool("run_feed_prepare", { triggeredBy: "main-agent" });
    expect(lastRequest()).toMatchObject({ method: "POST", body: { triggeredBy: "main-agent" } });
    expect(lastRequest().url.pathname).toBe("/api/feed/run");
  });

  it("filters briefings by state", async () => {
    await callFeedTool("list_feed_briefings", { state: "pending" });
    const request = lastRequest();
    expect(request.url.pathname).toBe("/api/feed/briefings");
    expect(request.url.searchParams.get("state")).toBe("pending");
  });

  it("submits content without leaking the briefing id into the body", async () => {
    await callFeedTool("submit_feed_briefing", {
      briefingId: "b/1",
      composer: "main-agent",
      topics: [{ title: "T", items: [{ pointIds: ["p-1"] }] }],
    });
    const request = lastRequest();
    expect(request.method).toBe("PUT");
    expect(request.url.pathname).toBe("/api/feed/briefings/b%2F1/content");
    expect(request.body).toEqual({
      composer: "main-agent",
      topics: [{ title: "T", items: [{ pointIds: ["p-1"] }] }],
    });
  });

  it("maps the remaining tools to their endpoints", async () => {
    const cases: Array<[string, Record<string, unknown>, string, string]> = [
      ["get_feed_status", {}, "GET", "/api/feed/status"],
      ["get_feed_candidates", { briefingId: "latest" }, "GET", "/api/feed/briefings/latest/candidates"],
      ["get_feed_entry_document", { entryId: "e1" }, "GET", "/api/feed/entries/e1/document"],
      ["prepare_feed_entry", { entryId: "e1" }, "POST", "/api/feed/entries/e1/prepare"],
      ["get_feed_signals", { since: "2026-11-01T00:00:00Z" }, "GET", "/api/feed/signals"],
      ["list_feed_sources", {}, "GET", "/api/feed/sources"],
      ["add_feed_source", { kind: "rss", title: "S", url: "https://s.example/feed" }, "POST", "/api/feed/sources"],
      ["update_feed_source", { sourceId: "s1", weight: 0.5 }, "PATCH", "/api/feed/sources/s1"],
      ["get_feed_coarse_hint", {}, "GET", "/api/feed/settings"],
      ["set_feed_coarse_hint", { coarseHint: "x" }, "PUT", "/api/feed/settings"],
    ];
    for (const [name, args, method, path] of cases) {
      await callFeedTool(name, args);
      const request = lastRequest();
      expect([name, request.method, request.url.pathname]).toEqual([name, method, path]);
    }
  });

  it("records the agent as author of source and hint changes", async () => {
    await callFeedTool("update_feed_source", { sourceId: "s1", weight: 0.5 });
    expect(lastRequest().body).toEqual({ weight: 0.5, updatedBy: "mcp-agent" });
    await callFeedTool("set_feed_coarse_hint", { coarseHint: "x", updatedBy: "main-agent" });
    expect(lastRequest().body).toEqual({ coarseHint: "x", updatedBy: "main-agent" });
  });

  it("surfaces server errors", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(409, { error: "feed_run_in_progress", runId: "r1" }));
    await expect(callFeedTool("run_feed_prepare", {})).rejects.toThrow(/409.*feed_run_in_progress/);
  });
});
