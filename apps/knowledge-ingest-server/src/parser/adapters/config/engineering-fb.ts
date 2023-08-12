import type { SiteAdapter } from "../types.js";

export const engineeringFbAdapter: SiteAdapter = {
  id: "engineering_fb",
  type: "config",
  priority: 82,
  match: {
    hosts: ["engineering.fb.com", "www.engineering.fb.com"]
  },
  content: {
    selectors: ["main#main article.hentry div.entry-content", "main article.type-post div.entry-content", "article.post div.entry-content"],
    excludeSelectors: [
      "script",
      "style",
      "button",
      "form",
      "aside",
      ".robots-nocontent",
      ".sharedaddy",
      "[class*='jetpack']",
      "[class*='share']",
      "[class*='related']"
    ],
    requireTextLength: 160
  },
  metadata: {
    title: ["main#main article.hentry .entry-title", "main article.type-post .entry-title", "meta[property='og:title']", "title"],
    author: ["main#main article.hentry .entry-authors a.author", "meta[name='twitter:data1']", "meta[name='author']"],
    publishedAt: ["meta[property='article:published_time']", "time[datetime]"],
    image: ["meta[property='og:image']", "article img"]
  },
  cleanup: {
    removeSelectors: ["script", "style", "button", "form", "aside", ".robots-nocontent", ".sharedaddy", "[class*='jetpack']"],
    normalizeImageAttributes: true,
    normalizeRelativeUrls: true
  },
  hints: {
    defuddleRootSelectors: ["main#main article.hentry div.entry-content", "main article.type-post div.entry-content"],
    fallbackCleanup: true
  },
  quality: {
    minScoreBonus: 28,
    preferOverGeneric: true
  }
};
