import { afterEach, describe, expect, it, vi } from "vitest";
import { createFeedApiClient, FeedApiError, feedReaderPath, formatScore, safeExternalUrl } from "../src/feed-client.js";
import type { ExtensionSettings } from "../src/types.js";

const settings = {
  serverUrl: "http://127.0.0.1:18765/",
  token: "secret",
  requestTimeoutMs: 1000,
  annotatorName: "reader"
} as ExtensionSettings;

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("feed reader links", () => {
  it("includes the section only for passage-level citations", () => {
    expect(feedReaderPath("e 1", "s-1")).toBe("reader.html?feedEntryId=e+1&sectionId=s-1");
    expect(feedReaderPath("e1")).toBe("reader.html?feedEntryId=e1");
  });

  it("only turns http and https URLs into link targets", () => {
    expect(safeExternalUrl("https://news.example/a")).toBe("https://news.example/a");
    expect(safeExternalUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeExternalUrl("data:text/html,x")).toBeUndefined();
    expect(safeExternalUrl("not a url")).toBeUndefined();
    expect(safeExternalUrl(undefined)).toBeUndefined();
  });

  it("formats missing scores as a dash", () => {
    expect(formatScore(79.6)).toBe("80");
    expect(formatScore(undefined)).toBe("–");
  });
});

describe("feed API client", () => {
  it("sends the token and records the reader as author of changes", async () => {
    const fetchMock = vi.fn(async () => respond(200, { source: { sourceId: "s1" } }));
    vi.stubGlobal("fetch", fetchMock);
    await createFeedApiClient(settings).updateSource("s/1", { weight: 0.5 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:18765/api/feed/sources/s%2F1");
    expect(init.method).toBe("PATCH");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret");
    expect(JSON.parse(String(init.body))).toEqual({ weight: 0.5, updatedBy: "reader" });
  });

  it("exposes the status and body of failed requests", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(410, {
      error: "feed_entry_expired", url: "https://news.example/a", promotedItemId: "item-1"
    })));
    const failure = await createFeedApiClient(settings).entryDocument("e1").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FeedApiError);
    expect((failure as FeedApiError).status).toBe(410);
    expect((failure as FeedApiError).code).toBe("feed_entry_expired");
    expect((failure as FeedApiError).body.promotedItemId).toBe("item-1");
  });
});
