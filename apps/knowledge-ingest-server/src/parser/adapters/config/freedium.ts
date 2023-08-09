import type { SiteAdapter } from "../types.js";

export const freediumAdapter: SiteAdapter = {
  id: "freedium",
  type: "config",
  priority: 90,
  match: {
    hosts: ["freedium-mirror.cfd"],
    urlPatterns: ["^https?://freedium-mirror\\.cfd/https?://medium\\.com/"]
  },
  content: {
    selectors: [
      "article",
      ".main-content",
      "main",
      ".container"
    ],
    excludeSelectors: [
      "nav",
      "header",
      "footer",
      "#problemModal",
      ".storage-notification-container",
      "[class*='notification']",
      "[class*='subscribe']",
      "[class*='recommend']",
      "[class*='related']"
    ],
    requireTextLength: 120
  },
  metadata: {
    title: ["h1", "meta[property='og:title']", "title"],
    author: ["a[href*='medium.com/@']", "[rel='author']", "meta[name='author']"],
    publishedAt: ["time[datetime]", "meta[property='article:published_time']", "[class*='date']"],
    image: ["meta[property='og:image']", "article img", ".main-content img"]
  },
  cleanup: {
    removeSelectors: ["script", "style", "button", "form", "aside"],
    unwrapSelectors: [".main-content > div"],
    normalizeImageAttributes: true,
    normalizeRelativeUrls: true
  },
  hints: {
    defuddleRootSelectors: ["article", ".main-content", "main"],
    fallbackCleanup: true
  },
  quality: {
    minScoreBonus: 30,
    preferOverGeneric: true
  }
};
