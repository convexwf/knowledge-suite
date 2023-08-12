import type { SiteAdapter } from "../types.js";

export const juejinAdapter: SiteAdapter = {
  id: "juejin",
  type: "config",
  priority: 72,
  match: {
    hosts: ["juejin.cn", "www.juejin.cn"],
    pathPatterns: ["^/post/"]
  },
  content: {
    selectors: ["#article-root .article-viewer.markdown-body", "#article-root", "article"],
    excludeSelectors: [
      "script",
      "style",
      "button",
      "form",
      "aside",
      "[class*='recommend']",
      "[class*='comment']",
      "[class*='share']",
      "[class*='sidebar']"
    ],
    requireTextLength: 120
  },
  metadata: {
    title: ["meta[itemprop='headline']", "h1", "meta[property='og:title']", "title"],
    author: ["div[itemprop='author'] meta[itemprop='name']", "meta[name='author']"],
    publishedAt: ["meta[itemprop='datePublished']", "meta[property='article:published_time']", "time[datetime]"],
    image: ["meta[property='og:image']", "#article-root img"]
  },
  cleanup: {
    removeSelectors: ["script", "style", "button", "form", "aside", "[class*='recommend']", "[class*='comment']", "[class*='share']"],
    normalizeImageAttributes: true,
    normalizeRelativeUrls: true
  },
  hints: {
    defuddleRootSelectors: ["#article-root .article-viewer.markdown-body", "#article-root"],
    fallbackCleanup: true
  },
  quality: {
    minScoreBonus: 18,
    preferOverGeneric: true
  }
};
