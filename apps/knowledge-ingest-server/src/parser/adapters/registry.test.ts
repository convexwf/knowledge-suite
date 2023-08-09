import { describe, expect, it } from "vitest";
import { matchSiteAdapters, siteAdapters, validateSiteAdapters } from "./index.js";
import type { SiteAdapter } from "./types.js";

describe("site adapter registry", () => {
  it("loads config adapters with stable types", () => {
    expect(siteAdapters.map((adapter) => adapter.id)).toEqual([
      "arxiv_html",
      "freedium",
      "medium"
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
