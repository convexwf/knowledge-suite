import type { SiteAdapter } from "../types.js";

export const mediumAdapter: SiteAdapter = {
  id: "medium",
  type: "config",
  priority: 70,
  match: {
    hosts: ["medium.com"],
    hostSuffixes: [".medium.com"]
  },
  content: {
    selectors: ["article", "main article", "main"],
    excludeSelectors: [
      "nav",
      "header",
      "footer",
      "aside",
      "[aria-label*='clap' i]",
      "[class*='meter']",
      "[class*='recommend']",
      "[class*='related']"
    ],
    requireTextLength: 120
  },
  metadata: {
    title: ["h1", "meta[property='og:title']", "title"],
    author: ["a[rel='author']", "a[href*='/@']", "meta[name='author']"],
    publishedAt: ["time[datetime]", "meta[property='article:published_time']"],
    image: ["meta[property='og:image']", "article img"]
  },
  cleanup: {
    removeSelectors: ["script", "style", "button", "form", "aside"],
    normalizeImageAttributes: true,
    normalizeRelativeUrls: true
  },
  hints: {
    defuddleRootSelectors: ["article", "main article", "main"],
    fallbackCleanup: true
  },
  quality: {
    minScoreBonus: 20
  }
};
