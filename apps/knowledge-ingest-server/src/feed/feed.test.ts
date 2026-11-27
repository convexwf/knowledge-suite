import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FeedCandidates, FeedEntry, KnowledgeDocument } from "@uknowledge/knowledge-schema";
import { defaultFeedConfig } from "../config.js";
import { buildServer } from "../server.js";
import { composeBriefing } from "./compose.js";
import type { FeedLlm, FeedLlmRequest } from "./llm.js";
import { estimateTokens, parseJsonObject } from "./llm.js";
import { buildExtractionInput, verifyCitation } from "./points.js";
import { runRetention } from "./retention.js";
import { selectEntries } from "./score.js";
import { feedUrlHash, limitEntries, parseFeedXml, parseListing } from "./sources.js";
import { addDays, FeedStore, type FeedPointRow } from "./store.js";

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Example Feed</title>
    <item>
      <title>Alpha release notes</title>
      <link>https://news.example/alpha?utm_source=rss</link>
      <description><![CDATA[<p>Alpha ships a <b>faster</b> parser.</p>]]></description>
      <dc:creator>Ada</dc:creator>
      <pubDate>Mon, 02 Nov 2026 10:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Beta benchmark results</title>
      <link>https://news.example/beta</link>
      <description>Beta doubles throughput.</description>
      <pubDate>Tue, 03 Nov 2026 10:00:00 GMT</pubDate>
    </item>
    <item>
      <title>LOW value hiring post</title>
      <link>https://news.example/jobs</link>
      <description>We are hiring.</description>
    </item>
    <item>
      <title>No link here</title>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Feed</title>
  <entry>
    <title type="html">Gamma &amp; Delta</title>
    <link rel="self" href="https://atom.example/self"/>
    <link rel="alternate" href="/posts/gamma"/>
    <summary>Summary text</summary>
    <updated>2026-11-01T00:00:00Z</updated>
    <author><name>Grace</name></author>
  </entry>
</feed>`;

function articleHtml(title: string, sentences: string[]): string {
  return `<!doctype html><html lang="en"><head><title>${title} - Example News</title></head><body><article>
    <h1>${title}</h1>
    ${sentences.map((sentence) => `<p>${sentence}</p>`).join("\n")}
  </article></body></html>`;
}

const ARTICLES: Record<string, string> = {
  "https://news.example/alpha?utm_source=rss": articleHtml("Alpha release notes", [
    "The alpha release ships a parser that is three times faster than the previous version on large documents.",
    "Memory use dropped by forty percent because sections are now streamed instead of buffered in full."
  ]),
  "https://news.example/beta": articleHtml("Beta benchmark results", [
    "The beta build doubles throughput on the standard benchmark while keeping latency flat for every tested workload.",
    "The team attributes the gain to batching writes and removing a lock from the hot path of the scheduler."
  ]),
  "https://news.example/jobs": articleHtml("LOW value hiring post", [
    "We are hiring engineers for several teams and the application form is open until the end of the quarter.",
    "Candidates should send a short introduction together with links to work they are proud of having shipped."
  ])
};

/** Deterministic stand-in for the summary model. */
class FakeLlm implements FeedLlm {
  readonly model = "fake-summary";
  calls: FeedLlmRequest[] = [];
  failScoring = false;
  failPoints = false;
  /** When set, quotes are replaced by text that is not in the article. */
  inventQuotes = false;

  async completeJson(request: FeedLlmRequest): Promise<unknown> {
    this.calls.push(request);
    if (request.system.includes("coarse filter")) {
      if (this.failScoring) throw new Error("model offline");
      const results = [...request.user.matchAll(/id: (e\d+)\n.*\ntitle: (.*)/g)].map((match) => ({
        id: match[1],
        score: match[2].includes("LOW") ? 10 : 80,
        reason: "test reason",
        topics: ["testing"]
      }));
      return { results };
    }
    if (this.failPoints) throw new Error("model offline");
    const body = [...request.user.matchAll(/^\[(s\d+)\] (?!# )(.+)$/gm)];
    return {
      points: body.slice(0, 2).map((match) => ({
        text: `Point about ${match[2].slice(0, 20)}`,
        section: match[1],
        quote: this.inventQuotes ? "this sentence never appears anywhere in the page" : match[2].slice(0, 48)
      }))
    };
  }
}

describe("feed parsing and selection", () => {
  it("parses RSS items and skips entries without a link", () => {
    const entries = parseFeedXml(RSS, "https://news.example/feed.xml");
    expect(entries.map((entry) => entry.title)).toEqual([
      "Alpha release notes", "Beta benchmark results", "LOW value hiring post"
    ]);
    expect(entries[0]).toMatchObject({
      url: "https://news.example/alpha?utm_source=rss",
      summary: "Alpha ships a faster parser.",
      author: "Ada",
      publishedAt: "2026-11-02T10:00:00.000Z"
    });
  });

  it("parses namespaced Atom and resolves the alternate link", () => {
    const entries = parseFeedXml(ATOM, "https://atom.example/feed");
    expect(entries).toEqual([{
      url: "https://atom.example/posts/gamma",
      title: "Gamma & Delta",
      summary: "Summary text",
      author: "Grace",
      publishedAt: "2026-11-01T00:00:00.000Z"
    }]);
  });

  it("rejects documents that are not feeds", () => {
    expect(() => parseFeedXml("<html><body>nope</body></html>", "https://x.example/")).toThrow(/not an RSS or Atom feed/);
  });

  it("extracts same-origin listing links matching the pattern", () => {
    const html = `<html><body>
      <a href="/blog/first-post"><img alt=""></a>
      <a href="/blog/first-post">First post headline</a>
      <a href="/blog/second-post#comments">Second post</a>
      <a href="/about">About</a>
      <a href="https://other.example/blog/third">Elsewhere</a>
      <a href="javascript:void(0)">Script</a>
    </body></html>`;
    const entries = parseListing(html, "https://site.example/blog", "/blog/[^/]+$");
    expect(entries).toEqual([
      { url: "https://site.example/blog/first-post", title: "First post headline" },
      { url: "https://site.example/blog/second-post", title: "Second post" }
    ]);
  });

  it("orders by publish date and applies the per-source limit", () => {
    const entries = limitEntries(parseFeedXml(RSS, "https://news.example/feed.xml"), 2);
    expect(entries.map((entry) => entry.title)).toEqual(["Beta benchmark results", "Alpha release notes"]);
  });

  it("ignores tracking parameters when hashing URLs", () => {
    expect(feedUrlHash("https://news.example/alpha?utm_source=rss")).toBe(feedUrlHash("https://news.example/alpha"));
  });

  it("reserves an exploration quota for rarely selected sources", () => {
    const candidates = [
      ...Array.from({ length: 12 }, (_, index) => ({
        entryId: `main-${String(index).padStart(2, "0")}`,
        sourceId: "busy",
        effectiveScore: 90 - index
      })),
      { entryId: "quiet-mid", sourceId: "quiet", effectiveScore: 25 },
      { entryId: "quiet-low", sourceId: "quiet", effectiveScore: 10 }
    ];
    const selection = selectEntries(candidates, {
      minScore: 40,
      maxSelected: 10,
      recentSelectedBySource: new Map([["busy", 50]])
    });
    expect(selection).toHaveLength(10);
    expect(selection.filter((choice) => !choice.exploration)).toHaveLength(9);
    // 25 >= minScore / 2 qualifies for exploration; 10 does not.
    expect(selection.find((choice) => choice.exploration)).toEqual({ entryId: "quiet-mid", exploration: true });
  });

  it("never selects entries from a zero-weight source", () => {
    const selection = selectEntries(
      [{ entryId: "muted", sourceId: "muted", effectiveScore: 0 }],
      { minScore: 40, maxSelected: 10, recentSelectedBySource: new Map() }
    );
    expect(selection).toEqual([]);
  });
});

describe("feed summary model helpers", () => {
  it("parses JSON wrapped in prose or a code fence", () => {
    expect(parseJsonObject("```json\n{\"a\":1}\n```")).toEqual({ a: 1 });
    expect(parseJsonObject("Sure: {\"a\":2} done")).toEqual({ a: 2 });
    expect(() => parseJsonObject("[1,2]")).toThrow();
  });

  it("counts CJK characters as one token each", () => {
    expect(estimateTokens("知识库简报")).toBe(5);
    expect(estimateTokens("abcdefgh")).toBe(2);
  });
});

describe("feed citation verification", () => {
  const document: KnowledgeDocument = {
    doc_id: "d1",
    meta: { title: "T", source: { type: "html" }, ingested_at: "2026-11-27T00:00:00Z" },
    sections: [
      { section_id: "s-head", type: "heading", level: 1, content: "Release" },
      { section_id: "s-one", type: "paragraph", content: "The parser is “three times”  faster\nthan before." },
      { section_id: "s-two", type: "list", items: ["Memory use dropped by forty percent", { text: "Nested", items: ["deep item text"] }] }
    ]
  };
  const { aliases } = buildExtractionInput(document);

  it("lays out sections with stable aliases", () => {
    expect([...aliases.entries()]).toEqual([["s1", "s-head"], ["s2", "s-one"], ["s3", "s-two"]]);
  });

  it("accepts a quote found in the cited section after normalisation", () => {
    expect(verifyCitation(document, aliases, { section: "s2", quote: "parser is \"three times\" faster than" }))
      .toEqual({ sectionId: "s-one", quote: "parser is \"three times\" faster than" });
  });

  it("moves the citation to the section that really contains the quote", () => {
    expect(verifyCitation(document, aliases, { section: "s2", quote: "Memory use dropped by forty percent" }))
      .toMatchObject({ sectionId: "s-two" });
  });

  it("downgrades to an entry-level citation when the quote is not in the document", () => {
    expect(verifyCitation(document, aliases, { section: "s2", quote: "an invented sentence that is absent" })).toEqual({});
  });

  it("matches and stores quotes without Markdown markup or URLs", () => {
    const linked: KnowledgeDocument = {
      ...document,
      sections: [{
        section_id: "s-link",
        type: "paragraph",
        content: "It gained integration with [Datasette Agent](https://agent.datasette.io/), so **now** you can ask `chat` for a chart."
      }]
    };
    const input = buildExtractionInput(linked);
    expect(input.prompt).toBe("[s1] It gained integration with Datasette Agent, so now you can ask chat for a chart.");
    expect(verifyCitation(linked, input.aliases, {
      section: "s1",
      quote: "integration with [Datasette Agent](https://agent.datasette.io/), so now you can ask"
    })).toEqual({ sectionId: "s-link", quote: "integration with Datasette Agent, so now you can ask" });
  });

  it("downgrades when the alias is unknown and the quote is absent", () => {
    expect(verifyCitation(document, aliases, { section: "s99", quote: "nothing like this exists here" })).toEqual({});
  });

  it("keeps headings but drops body text beyond the token budget", () => {
    const long: KnowledgeDocument = {
      ...document,
      sections: [
        { section_id: "a", type: "paragraph", content: "x".repeat(400) },
        { section_id: "b", type: "paragraph", content: "y".repeat(400) },
        { section_id: "c", type: "heading", level: 2, content: "Later heading" }
      ]
    };
    const input = buildExtractionInput(long, 110);
    expect([...input.aliases.values()]).toEqual(["a", "c"]);
    expect(input.prompt).toContain("omitted");
  });
});

describe("feed briefing submission", () => {
  const point = (pointId: string, entryId: string, text: string): FeedPointRow => ({
    pointId, briefingId: "b1", entryId, sourceId: "src", text,
    sectionId: `sec-${pointId}`, quote: `quote ${pointId}`,
    entryTitle: `Title ${entryId}`, entryUrl: `https://news.example/${entryId}`,
    used: false, createdAt: "2026-11-27T00:00:00Z"
  });
  const points = [point("p-1", "e1", "First point"), point("p-2", "e2", "Second point")];
  const context = { date: "2026-11-27", scored: 10, selected: 2 };

  it("expands point ids into verified citations", () => {
    const result = composeBriefing({
      composer: "main-agent",
      summary: "Today in short.",
      topics: [{
        title: "Releases",
        items: [
          { pointIds: ["p-1"] },
          { pointIds: ["p-1", "p-2"], text: "Both improved. See https://evil.example/ for more." }
        ]
      }]
    }, points, context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usedPointIds.sort()).toEqual(["p-1", "p-2"]);
    const [first, second] = result.content.topics[0].items;
    expect(first).toEqual({
      text: "First point",
      rewritten: false,
      refs: [{
        pointId: "p-1", entryId: "e1", sectionId: "sec-p-1", quote: "quote p-1",
        title: "Title e1", url: "https://news.example/e1"
      }]
    });
    expect(second.rewritten).toBe(true);
    // Citation URLs come from stored points only, whatever the composer wrote.
    expect(second.refs.map((ref) => ref.url)).toEqual(["https://news.example/e1", "https://news.example/e2"]);
    expect(result.content.stats).toEqual({ scored: 10, selected: 2, candidatePoints: 2, usedPoints: 2 });
  });

  it("reports every problem with its path", () => {
    const result = composeBriefing({
      composer: "main-agent",
      topics: [{
        title: " ",
        items: [
          { pointIds: [] },
          { pointIds: ["p-1", "p-404"] },
          { pointIds: ["p-1", "p-2"] }
        ]
      }]
    }, points, context);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.path)).toEqual([
      "topics[0].title",
      "topics[0].items[0].pointIds",
      "topics[0].items[1].pointIds",
      "topics[0].items[1].text",
      "topics[0].items[2].text"
    ]);
    expect(result.errors[2].message).toContain("p-404");
  });

  it("rejects a submission without topics", () => {
    const result = composeBriefing({ composer: "a", topics: [] }, points, context);
    expect(result.ok).toBe(false);
  });
});

describe("feed retention", () => {
  let storeRoot: string;
  let store: FeedStore;

  beforeEach(async () => {
    storeRoot = await mkdtemp(join(tmpdir(), "feed-store-test-"));
    store = new FeedStore(storeRoot);
  });

  afterEach(async () => {
    store.close();
    await rm(storeRoot, { recursive: true, force: true });
  });

  it("replaces expired entries with tombstones and removes their files", async () => {
    const config = defaultFeedConfig({ enabled: true });
    const now = new Date("2026-11-27T08:00:00Z");
    const source = store.createSource({ kind: "rss", title: "S", url: "https://s.example/feed", now: now.toISOString() });
    const urlHash = feedUrlHash("https://s.example/a");
    const entryId = store.insertEntry({
      sourceId: source.sourceId, url: "https://s.example/a", urlHash, title: "A",
      discoveredAt: now.toISOString(), expiresAt: addDays(now, 3).toISOString()
    });
    const keptId = store.insertEntry({
      sourceId: source.sourceId, url: "https://s.example/b", urlHash: feedUrlHash("https://s.example/b"), title: "B",
      discoveredAt: now.toISOString(), expiresAt: addDays(now, 14).toISOString()
    });
    await store.writeDocument(entryId, { doc_id: "d", meta: { title: "A", source: { type: "html" }, ingested_at: now.toISOString() }, sections: [] });
    await store.writeRawHtml(entryId, "<html>raw</html>");
    expect(await store.readRawHtml(entryId)).toBe("<html>raw</html>");
    store.markPromoted(entryId, "item-1", now.toISOString());

    expect(await runRetention(store, config, addDays(now, 2))).toBe(0);
    expect(await runRetention(store, config, addDays(now, 4))).toBe(1);

    expect(store.getEntry(entryId)).toBeUndefined();
    expect(store.getEntry(keptId)).toBeDefined();
    expect(await store.readDocument(entryId)).toBeUndefined();
    expect(await store.readRawHtml(entryId)).toBeUndefined();
    expect(store.getTombstoneByEntry(entryId)).toMatchObject({ url: "https://s.example/a", promotedItemId: "item-1" });
    // The tombstone keeps the URL from being collected again.
    expect(store.isUrlHashKnown(urlHash)).toBe(true);

    await runRetention(store, config, addDays(now, 4 + config.tombstoneDays + 1));
    expect(store.isUrlHashKnown(urlHash)).toBe(false);
  });

  it("deletes briefings and their points together after the retention window", async () => {
    const config = defaultFeedConfig({ enabled: true, briefingRetentionDays: 5, tombstoneDays: 5 });
    const now = new Date("2026-11-27T08:00:00Z");
    const source = store.createSource({ kind: "rss", title: "S", url: "https://s.example/feed", now: now.toISOString() });
    const entryId = store.insertEntry({
      sourceId: source.sourceId, url: "https://s.example/a", urlHash: feedUrlHash("https://s.example/a"), title: "A",
      discoveredAt: now.toISOString(), expiresAt: addDays(now, 30).toISOString()
    });
    const { briefingId } = store.attachEntryToBriefing({
      date: "2026-11-27", runId: "r1", entry: store.getEntry(entryId)!, points: [{ text: "P" }], now: now.toISOString()
    });
    expect(store.pointsForBriefing(briefingId)).toHaveLength(1);
    await runRetention(store, config, addDays(now, 10));
    expect(store.getBriefing(briefingId)).toBeUndefined();
    expect(store.pointsForBriefing(briefingId)).toHaveLength(0);
  });

  it("marks runs left running by a previous process as failed", () => {
    const run = store.createRun("test", "2026-11-27T00:00:00Z");
    expect(store.failStaleRuns("2026-11-27T01:00:00Z")).toBe(1);
    expect(store.getRun(run.runId)).toMatchObject({ state: "failed", finishedAt: "2026-11-27T01:00:00Z" });
  });
});

describe("feed API", () => {
  let storeRoot: string;
  let originalFetch: typeof globalThis.fetch;
  let app: FastifyInstance | undefined;
  let llm: FakeLlm;
  let feedXml: string;
  const headers = { authorization: "Bearer test-token" };

  beforeEach(async () => {
    storeRoot = await mkdtemp(join(tmpdir(), "feed-api-test-"));
    originalFetch = globalThis.fetch;
    llm = new FakeLlm();
    feedXml = RSS;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://news.example/feed.xml") {
        return new Response(feedXml, { headers: { "content-type": "application/rss+xml" } });
      }
      const article = ARTICLES[url];
      if (article) return new Response(article, { headers: { "content-type": "text/html; charset=utf-8" } });
      return new Response("not found", { status: 404, statusText: "Not Found" });
    }) as typeof globalThis.fetch;
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    globalThis.fetch = originalFetch;
    await rm(storeRoot, { recursive: true, force: true });
  });

  async function start(overrides: Parameters<typeof defaultFeedConfig>[0] = {}): Promise<FastifyInstance> {
    app = await buildServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      storeRoot,
      fetchTimeoutMs: 1000,
      maxHtmlBytes: 1024 * 1024,
      feed: defaultFeedConfig({ enabled: true, ...overrides }),
      feedLlm: llm
    });
    return app;
  }

  async function call(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) {
    const response = await app!.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
    return { status: response.statusCode, body: response.json() as Record<string, any> };
  }

  async function addSource(): Promise<string> {
    const created = await call("POST", "/api/feed/sources", {
      kind: "rss", title: "Example Feed", url: "https://news.example/feed.xml", createdBy: "tester"
    });
    expect(created.status).toBe(201);
    return created.body.source.sourceId as string;
  }

  async function runToCompletion(triggeredBy = "test"): Promise<Record<string, any>> {
    const started = await call("POST", "/api/feed/run", { triggeredBy });
    expect(started.status).toBe(202);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const status = await call("GET", "/api/feed/status");
      if (!status.body.running && status.body.run?.runId === started.body.runId) return status.body.run;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("feed run did not finish");
  }

  async function pendingCandidates(): Promise<FeedCandidates> {
    const briefings = await call("GET", "/api/feed/briefings?state=pending");
    expect(briefings.body.briefings).toHaveLength(1);
    const candidates = await call("GET", `/api/feed/briefings/${briefings.body.briefings[0].briefingId}/candidates`);
    return candidates.body as unknown as FeedCandidates;
  }

  it("answers feed_disabled and creates no feed directory when switched off", async () => {
    app = await buildServer({
      host: "127.0.0.1", port: 0, token: "test-token", storeRoot, fetchTimeoutMs: 1000, maxHtmlBytes: 2048
    });
    const response = await call("GET", "/api/feed/status");
    expect(response.status).toBe(404);
    expect(response.body.error).toBe("feed_disabled");
    await expect(access(join(storeRoot, "feed"))).rejects.toThrow();
  });

  it("does not start a run on its own", async () => {
    await start();
    await addSource();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const status = await call("GET", "/api/feed/status");
    expect(status.body).toMatchObject({ enabled: true, running: false, pendingBriefings: 0, summaryModel: "fake-summary" });
    expect(status.body.run).toBeUndefined();
  });

  it("validates sources", async () => {
    await start();
    expect((await call("POST", "/api/feed/sources", { kind: "listing", title: "L", url: "https://l.example/" })).status).toBe(400);
    const badPattern = await call("POST", "/api/feed/sources", {
      kind: "listing", title: "L", url: "https://l.example/", linkPattern: "(["
    });
    expect(badPattern.body.error).toBe("invalid_link_pattern");
    await addSource();
    const duplicate = await call("POST", "/api/feed/sources", {
      kind: "rss", title: "Again", url: "https://news.example/feed.xml"
    });
    expect(duplicate.status).toBe(409);
    expect((await call("PATCH", "/api/feed/sources/unknown", { weight: 1 })).status).toBe(404);
  });

  it("prepares candidates with verified citations and leaves the knowledge base untouched", async () => {
    await start();
    const sourceId = await addSource();
    const run = await runToCompletion("main-agent");
    expect(run).toMatchObject({ state: "completed", triggeredBy: "main-agent" });
    expect(run.stats).toMatchObject({ discovered: 3, scored: 3, selected: 2, fetched: 2, points: 4, sourcesOk: 1 });

    const candidates = await pendingCandidates();
    expect(candidates.briefing).toMatchObject({ state: "pending", pointCount: 4, entryCount: 2 });
    expect(candidates.entries.map((entry) => entry.title).sort()).toEqual(["Alpha release notes", "Beta benchmark results"]);
    expect(candidates.skipped.map((entry) => entry.title)).toEqual(["LOW value hiring post"]);
    expect(candidates.rescueRemaining).toBe(10);

    const alpha = candidates.entries.find((entry) => entry.title === "Alpha release notes")!;
    const document = (await call("GET", `/api/feed/entries/${alpha.entryId}/document`)).body.document as KnowledgeDocument;
    for (const point of alpha.points) {
      const section = document.sections.find((candidate) => candidate.section_id === point.sectionId);
      expect(section?.content).toContain(point.quote);
      expect(point.quote).not.toMatch(/https?:/);
    }

    // Nothing reached the knowledge base: no items, no search hits.
    expect((await call("GET", "/api/items")).body.items).toEqual([]);
    expect((await call("GET", "/api/search?q=parser")).body.results).toEqual([]);

    const sources = await call("GET", "/api/feed/sources");
    expect(sources.body.sources[0]).toMatchObject({
      sourceId, createdBy: "tester", stats: { discovered: 3, selected: 2, briefed: 0 }
    });
  });

  it("downgrades invented quotes to entry-level citations", async () => {
    llm.inventQuotes = true;
    await start();
    await addSource();
    await runToCompletion();
    const candidates = await pendingCandidates();
    const points = candidates.entries.flatMap((entry) => entry.points);
    expect(points.length).toBeGreaterThan(0);
    for (const point of points) {
      expect(point.sectionId).toBeUndefined();
      expect(point.quote).toBeUndefined();
    }
  });

  it("accepts a valid submission, rejects foreign point ids, and replaces on resubmit", async () => {
    await start();
    await addSource();
    await runToCompletion();
    const candidates = await pendingCandidates();
    const briefingId = candidates.briefing.briefingId;
    const pointIds = candidates.entries.flatMap((entry) => entry.points.map((point) => point.pointId));

    const rejected = await call("PUT", `/api/feed/briefings/${briefingId}/content`, {
      composer: "main-agent",
      topics: [{ title: "T", items: [{ pointIds: ["p-nope"] }] }]
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe("invalid_briefing");
    expect(rejected.body.errors[0].path).toBe("topics[0].items[0].pointIds");
    expect((await call("GET", `/api/feed/briefings/${briefingId}`)).body.briefing.state).toBe("pending");

    const accepted = await call("PUT", `/api/feed/briefings/${briefingId}/content`, {
      composer: "main-agent",
      summary: "Two releases worth reading.",
      topics: [{
        title: "Releases",
        items: [{ pointIds: [pointIds[0]] }, { pointIds: [pointIds[1], pointIds[2]], text: "Combined statement." }]
      }]
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.briefing).toMatchObject({ state: "composed", composer: "main-agent", revision: 1 });

    const detail = await call("GET", "/api/feed/briefings/latest");
    expect(detail.body.content.topics[0].items).toHaveLength(2);
    expect(detail.body.content.stats).toMatchObject({ scored: 3, selected: 2, candidatePoints: 4, usedPoints: 3 });
    const referenced = detail.body.content.topics[0].items[0].refs[0].entryId as string;
    expect(detail.body.entries[referenced]).toMatchObject({ exists: true, hasDocument: true });

    const after = (await call("GET", `/api/feed/briefings/${briefingId}/candidates`)).body as unknown as FeedCandidates;
    expect(after.entries.flatMap((entry) => entry.points).filter((point) => point.used)).toHaveLength(3);

    const resubmitted = await call("PUT", `/api/feed/briefings/${briefingId}/content`, {
      composer: "main-agent",
      topics: [{ title: "Only one", items: [{ pointIds: [pointIds[3]] }] }]
    });
    expect(resubmitted.body.briefing.revision).toBe(2);
    expect(resubmitted.body.content.stats.usedPoints).toBe(1);
    const sources = await call("GET", "/api/feed/sources");
    expect(sources.body.sources[0].stats.briefed).toBe(1);
  });

  it("merges a second run into the pending briefing and starts a new one after composing", async () => {
    await start();
    await addSource();
    await runToCompletion();
    const first = await pendingCandidates();

    const again = await runToCompletion();
    expect(again.stats).toMatchObject({ discovered: 0, duplicates: 3, points: 0 });
    expect((await call("GET", "/api/feed/briefings")).body.briefings).toHaveLength(1);

    await call("PUT", `/api/feed/briefings/${first.briefing.briefingId}/content`, {
      composer: "main-agent",
      topics: [{ title: "T", items: [{ pointIds: [first.entries[0].points[0].pointId] }] }]
    });
    feedXml = RSS.replace("https://news.example/beta", "https://news.example/beta?edition=2")
      .replace("Beta benchmark results", "Beta benchmark results revisited");
    ARTICLES["https://news.example/beta?edition=2"] = ARTICLES["https://news.example/beta"];
    try {
      const third = await runToCompletion();
      expect(third.stats).toMatchObject({ discovered: 1, selected: 1 });
      const briefings = (await call("GET", "/api/feed/briefings")).body.briefings as Array<{ state: string }>;
      expect(briefings.map((briefing) => briefing.state).sort()).toEqual(["composed", "pending"]);
    } finally {
      delete ARTICLES["https://news.example/beta?edition=2"];
    }
  });

  it("rejects a second trigger while a run is in progress", async () => {
    await start();
    await addSource();
    const first = await call("POST", "/api/feed/run", {});
    const second = await call("POST", "/api/feed/run", {});
    expect(first.status).toBe(202);
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: "feed_run_in_progress", runId: first.body.runId });
    await app!.close();
    app = undefined;
  });

  it("keeps discovered entries and reports a partial run when the summary model is down", async () => {
    llm.failScoring = true;
    await start();
    await addSource();
    const run = await runToCompletion();
    expect(run.state).toBe("partial");
    expect(run.stats).toMatchObject({ discovered: 3, scored: 0, scoreFailed: 3 });
    expect((await call("GET", "/api/feed/briefings")).body.briefings).toEqual([]);

    llm.failScoring = false;
    const retry = await runToCompletion();
    expect(retry.state).toBe("completed");
    expect(retry.stats).toMatchObject({ discovered: 0, scored: 3, selected: 2 });
  });

  it("retries point extraction on the next run", async () => {
    llm.failPoints = true;
    await start();
    await addSource();
    const run = await runToCompletion();
    expect(run.state).toBe("partial");
    expect(run.stats).toMatchObject({ fetched: 2, points: 0, pointsFailed: 2 });

    llm.failPoints = false;
    const retry = await runToCompletion();
    expect(retry.stats).toMatchObject({ fetched: 0, points: 4, pointsFailed: 0 });
  });

  it("prepares a skipped entry on request and enforces the rescue limit", async () => {
    await start({ maxRescuePerBriefing: 1 });
    await addSource();
    await runToCompletion();
    const candidates = await pendingCandidates();
    const skipped = candidates.skipped[0];

    const rescued = await call("POST", `/api/feed/entries/${skipped.entryId}/prepare`, {});
    expect(rescued.status).toBe(200);
    expect(rescued.body.briefingId).toBe(candidates.briefing.briefingId);
    expect(rescued.body.points.length).toBeGreaterThan(0);
    expect(rescued.body.entry).toMatchObject({ selected: true, rescued: true, stage: "fetched" });

    const after = await pendingCandidates();
    expect(after.rescueRemaining).toBe(0);
    expect(after.skipped).toEqual([]);
    expect(after.entries).toHaveLength(3);

    const repeat = await call("POST", `/api/feed/entries/${skipped.entryId}/prepare`, {});
    expect(repeat.status).toBe(409);
    expect(repeat.body.error).toBe("feed_entry_not_skipped");
  });

  it("refuses rescues beyond the per-briefing limit", async () => {
    feedXml = RSS.replace("</channel>", `<item><title>LOW second</title><link>https://news.example/jobs?p=2</link></item></channel>`);
    ARTICLES["https://news.example/jobs?p=2"] = ARTICLES["https://news.example/jobs"];
    try {
      await start({ maxRescuePerBriefing: 1 });
      await addSource();
      await runToCompletion();
      const candidates = await pendingCandidates();
      expect(candidates.skipped).toHaveLength(2);
      expect((await call("POST", `/api/feed/entries/${candidates.skipped[0].entryId}/prepare`, {})).status).toBe(200);
      const refused = await call("POST", `/api/feed/entries/${candidates.skipped[1].entryId}/prepare`, {});
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe("feed_rescue_limit_reached");
    } finally {
      delete ARTICLES["https://news.example/jobs?p=2"];
    }
  });

  it("promotes a starred entry into the default category and skips it on later runs", async () => {
    await start();
    await addSource();
    await runToCompletion();
    const candidates = await pendingCandidates();
    const alpha = candidates.entries.find((entry) => entry.title === "Alpha release notes")!;

    const starred = await call("POST", `/api/feed/entries/${alpha.entryId}/star`);
    expect(starred.status).toBe(200);
    const itemId = starred.body.itemId as string;
    expect(itemId).toBeTruthy();
    expect((await call("POST", `/api/feed/entries/${alpha.entryId}/star`)).body.itemId).toBe(itemId);

    const items = (await call("GET", "/api/items")).body.items as Array<{ itemId: string; category: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ itemId, category: "default" });
    expect((await call("GET", `/api/items/${itemId}`)).body.document.meta.title).toBe("Alpha release notes");

    // An entry that was never fetched is promoted by fetching its URL.
    const skipped = candidates.skipped[0];
    const promotedSkipped = await call("POST", `/api/feed/entries/${skipped.entryId}/star`);
    expect(promotedSkipped.status).toBe(200);
    expect((await call("GET", "/api/items")).body.items).toHaveLength(2);

    const signals = await call("GET", "/api/feed/signals");
    expect((signals.body.signals as Array<{ type: string }>).map((signal) => signal.type)).toEqual(["star", "star"]);
    expect(signals.body.sources[0].stats.starred).toBe(2);
  });

  it("does not collect URLs that already exist in the knowledge base", async () => {
    await start();
    const saved = await call("POST", "/api/ingest/save", { inputMode: "server_fetch", url: "https://news.example/beta" });
    expect(saved.status).toBe(200);
    await addSource();
    const run = await runToCompletion();
    expect(run.stats).toMatchObject({ discovered: 2, duplicates: 1 });
  });

  it("records open and dismiss signals once per action", async () => {
    await start();
    await addSource();
    await runToCompletion();
    const entry = (await pendingCandidates()).entries[0];
    expect((await call("POST", `/api/feed/entries/${entry.entryId}/signals`, { type: "open" })).status).toBe(200);
    expect((await call("POST", `/api/feed/entries/${entry.entryId}/signals`, { type: "star" })).status).toBe(400);
    await call("POST", `/api/feed/entries/${entry.entryId}/dismiss`);
    await call("POST", `/api/feed/entries/${entry.entryId}/dismiss`);
    const signals = (await call("GET", "/api/feed/signals")).body.signals as Array<{ type: string }>;
    expect(signals.map((signal) => signal.type)).toEqual(["open", "dismiss"]);
    const detail = (await call("GET", `/api/feed/entries/${entry.entryId}`)).body.entry as FeedEntry;
    expect(detail.openedAt).toBeTruthy();
    expect(detail.dismissedAt).toBeTruthy();
  });

  it("answers 410 with the original URL after a source and its entries are removed", async () => {
    await start();
    const sourceId = await addSource();
    await runToCompletion();
    const candidates = await pendingCandidates();
    const alpha = candidates.entries.find((entry) => entry.title === "Alpha release notes")!;
    const itemId = (await call("POST", `/api/feed/entries/${alpha.entryId}/star`)).body.itemId as string;

    const removed = await call("DELETE", `/api/feed/sources/${sourceId}`);
    expect(removed.body).toMatchObject({ deleted: true, removedEntries: 3 });

    const gone = await call("GET", `/api/feed/entries/${alpha.entryId}`);
    expect(gone.status).toBe(410);
    expect(gone.body).toEqual({
      error: "feed_entry_expired", url: "https://news.example/alpha?utm_source=rss", promotedItemId: itemId
    });
    expect((await call("GET", "/api/feed/entries/00000000-0000-0000-0000-000000000000")).status).toBe(404);

    // The briefing survives with snapshots, and the promoted item is untouched.
    const after = (await call("GET", `/api/feed/briefings/${candidates.briefing.briefingId}/candidates`)).body as unknown as FeedCandidates;
    const survivor = after.entries.find((entry) => entry.entryId === alpha.entryId)!;
    expect(survivor).toMatchObject({ title: "Alpha release notes", state: { exists: false, promotedItemId: itemId } });
    expect((await call("GET", `/api/items/${itemId}`)).status).toBe(200);
  });

  it("stores the coarse hint with its author and passes it to the summary model", async () => {
    await start();
    await addSource();
    const updated = await call("PUT", "/api/feed/settings", { coarseHint: "Prefer database internals.", updatedBy: "main-agent" });
    expect(updated.body.settings).toMatchObject({ coarseHint: "Prefer database internals.", updatedBy: "main-agent" });
    await runToCompletion();
    const scoring = llm.calls.find((request) => request.system.includes("coarse filter"))!;
    expect(scoring.system).toContain("Prefer database internals.");
  });

  it("applies source weight to the effective score", async () => {
    await start();
    const sourceId = await addSource();
    await call("PATCH", `/api/feed/sources/${sourceId}`, { weight: 0, updatedBy: "main-agent" });
    const run = await runToCompletion();
    expect(run.stats).toMatchObject({ scored: 3, selected: 0 });
    expect((await call("GET", "/api/feed/briefings")).body.briefings).toEqual([]);
    const entries = (await call("GET", "/api/feed/entries")).body.entries as FeedEntry[];
    expect(entries.every((entry) => entry.effectiveScore === 0 && !entry.selected)).toBe(true);
  });
});
