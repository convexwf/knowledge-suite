import type { SiteAdapter } from "../types.js";

export const allThingsDistributedAdapter: SiteAdapter = {
  id: "allthings_distributed",
  type: "config",
  priority: 76,
  match: {
    hosts: ["www.allthingsdistributed.com", "allthingsdistributed.com"]
  },
  content: {
    selectors: ["span[itemprop='articleBody']", "main section span[itemprop='articleBody']", "main section"],
    excludeSelectors: [
      "script",
      "style",
      "button",
      "form",
      "aside",
      "nav",
      "footer",
      "[class*='recommended']",
      "[class*='related']",
      "[class*='share']"
    ],
    requireTextLength: 160
  },
  metadata: {
    title: ["meta[property='og:title']", "main section > h2", "title"],
    author: ["meta[name='author']"],
    publishedAt: ["meta[property='article:published_time']", "p.meta time[datetime]", "time[datetime]"],
    image: ["meta[property='og:image']", "span[itemprop='articleBody'] img"]
  },
  cleanup: {
    removeSelectors: ["script", "style", "button", "form", "aside", "nav", "footer", "[class*='recommended']", "[class*='share']"],
    normalizeImageAttributes: true,
    normalizeRelativeUrls: true
  },
  hints: {
    defuddleRootSelectors: ["span[itemprop='articleBody']"],
    fallbackCleanup: true
  },
  quality: {
    minScoreBonus: 22,
    preferOverGeneric: true
  }
};
