import type { SiteAdapter } from "../types.js";

export const brendanGreggBlogAdapter: SiteAdapter = {
  id: "brendan_gregg_blog",
  type: "config",
  priority: 74,
  match: {
    hosts: ["www.brendangregg.com", "brendangregg.com"]
  },
  content: {
    selectors: ["div.site div.post", "div.post", "main"],
    excludeSelectors: [
      "script",
      "style",
      "button",
      "form",
      "aside",
      "nav",
      "footer",
      "[class*='sidebar']",
      "[class*='related']"
    ],
    requireTextLength: 140
  },
  metadata: {
    title: ["div.site h2.big", "h1", "meta[property='og:title']", "title"],
    author: ["meta[name='author']"],
    publishedAt: ["div.site p.meta", "time[datetime]", "meta[property='article:published_time']"],
    image: ["meta[property='og:image']", "div.site div.post img"]
  },
  cleanup: {
    removeSelectors: ["script", "style", "button", "form", "aside", "nav", "footer", "[class*='sidebar']"],
    normalizeImageAttributes: true,
    normalizeRelativeUrls: true
  },
  hints: {
    defuddleRootSelectors: ["div.site div.post", "div.post"],
    fallbackCleanup: true
  },
  quality: {
    minScoreBonus: 20,
    preferOverGeneric: true
  }
};
