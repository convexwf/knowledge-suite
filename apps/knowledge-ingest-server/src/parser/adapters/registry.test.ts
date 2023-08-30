import { describe, expect, it } from "vitest";
import { matchSiteAdapters, siteAdapters, validateSiteAdapters } from "./index.js";
import type { SiteAdapter } from "./types.js";

describe("site adapter registry", () => {
  it("loads config adapters with stable types", () => {
    expect(siteAdapters.map((adapter) => adapter.id)).toEqual([
      "allthings_distributed",
      "arxiv_html",
      "blog_google",
      "brendan_gregg_blog",
      "engineering_fb",
      "fern_docs",
      "freedium",
      "juejin",
      "medium",
      "meituan_tech",
      "reddit",
      "smashing_magazine"
    ]);
    expect(siteAdapters.every((adapter) => adapter.type === "config")).toBe(true);
  });

  it("matches adapters with type and reasons", () => {
    const [match] = matchSiteAdapters({
      inputMode: "browser_html",
      url: "https://medium.com/in-fitness-and-in-health/example",
      originalUrl: "https://freedium-mirror.cfd/https://medium.com/in-fitness-and-in-health/example",
      canonicalUrl: "https://medium.com/in-fitness-and-in-health/example",
      normalizedUrl: "https://medium.com/in-fitness-and-in-health/example",
      title: "Example",
      html: "<html><body><main>Example</main></body></html>",
      meta: {},
      capturedAt: "2026-05-12T00:00:00.000Z"
    });

    expect(match.adapter).toMatchObject({
      id: "freedium",
      type: "config"
    });
    expect(match.matchReason).toContain("originalUrl:host:freedium-mirror.cfd");
  });

  it.each([
    ["meituan_tech", "https://tech.meituan.com/2026/03/20/example.html"],
    ["engineering_fb", "https://engineering.fb.com/2026/01/01/example/"],
    ["blog_google", "https://blog.google/technology/ai/example/"],
    ["fern_docs", "https://docs.cohere.com/docs/rerank-overview"],
    ["smashing_magazine", "https://www.smashingmagazine.com/2026/01/example/"],
    ["allthings_distributed", "https://www.allthingsdistributed.com/2026/02/example.html"],
    ["brendan_gregg_blog", "https://www.brendangregg.com/blog/2026-02-07/example.html"],
    ["juejin", "https://juejin.cn/post/7350000000000000000"],
    ["reddit", "https://www.reddit.com/r/AI_Agents/comments/1lpj771/example/"]
  ])("matches migrated adapter %s", (adapterId, url) => {
    const matches = matchSiteAdapters({
      inputMode: "browser_html",
      url,
      originalUrl: url,
      canonicalUrl: url,
      normalizedUrl: url,
      title: "Example",
      html: "<html><body><main>Example</main></body></html>",
      meta: {},
      capturedAt: "2026-05-19T00:00:00.000Z"
    });

    expect(matches[0].adapter).toMatchObject({
      id: adapterId,
      type: "config"
    });
  });

  it("rejects duplicate adapter ids", () => {
    const adapter: SiteAdapter = {
      id: "duplicate",
      type: "config",
      priority: 1,
      match: {
        hosts: ["example.com"]
      },
      content: {
        selectors: ["main"]
      }
    };

    expect(() => validateSiteAdapters([adapter, { ...adapter }])).toThrow("Duplicate site adapter id: duplicate");
  });
});
