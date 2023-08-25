import type { SiteAdapter } from "../types.js";

export const fernDocsAdapter: SiteAdapter = {
  id: "fern_docs",
  type: "config",
  priority: 80,
  match: {
    hosts: ["docs.cohere.com"],
    hostSuffixes: [".docs.buildwithfern.com"],
    pathPatterns: ["^/(docs|reference|v[0-9]+)/"]
  },
  content: {
    selectors: ["main article", "article", "main .fern-layout-page", "main"],
    excludeSelectors: [
      "#fern-sidebar",
      "#fern-sidebar-spacer",
      "#fern-toc",
      "#fern-footer",
      ".fern-header-content",
      "#fern-search-button",
      "#fern-ask-ai-button",
      "[data-testid='search-button']"
    ],
    requireTextLength: 120
  },
  metadata: {
    title: ["h1", "meta[property='og:title']", "title"],
    publishedAt: ["time[datetime]", "meta[property='article:published_time']"],
    image: ["meta[property='og:image']", "article img", "main img"]
  },
  cleanup: {
    removeSelectors: ["script", "style", "button", "form", "aside", "nav", "header", "footer"],
    normalizeImageAttributes: true,
    normalizeRelativeUrls: true
  },
  hints: {
    defuddleRootSelectors: ["main article", "article", "main .fern-layout-page", "main"]
  },
  enrich: {
    tags: () => ["docs-platform:fern"]
  },
  quality: {
    minScoreBonus: 25
  }
};
