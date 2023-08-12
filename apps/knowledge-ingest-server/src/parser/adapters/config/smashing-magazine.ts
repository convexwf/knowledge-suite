import type { SiteAdapter } from "../types.js";

export const smashingMagazineAdapter: SiteAdapter = {
  id: "smashing_magazine",
  type: "config",
  priority: 78,
  match: {
    hosts: ["www.smashingmagazine.com", "smashingmagazine.com"]
  },
  content: {
    selectors: ["article.article div.c-garfield-the-cat", "div.c-garfield-the-cat", "article.article"],
    excludeSelectors: [
      "script",
      "style",
      "button",
      "form",
      "aside",
      ".l-author-bio",
      ".article__comments",
      "[class*='ad']",
      "[class*='newsletter']",
      "[class*='related']",
      "[class*='share']"
    ],
    requireTextLength: 180
  },
  metadata: {
    title: [".c-garfield-header h1", "article.article h1", "meta[property='og:title']", "title"],
    author: [".c-garfield-header .author-post__author-title", ".c-garfield-header a[href*='/author/']", "meta[name='author']"],
    publishedAt: ["meta[property='article:published_time']", "time[datetime]"],
    image: ["meta[property='og:image']", "article.article img"]
  },
  cleanup: {
    removeSelectors: ["script", "style", "button", "form", "aside", ".l-author-bio", ".article__comments", "[class*='ad']", "[class*='newsletter']"],
    normalizeImageAttributes: true,
    normalizeRelativeUrls: true
  },
  hints: {
    defuddleRootSelectors: ["article.article div.c-garfield-the-cat", "div.c-garfield-the-cat"],
    fallbackCleanup: true
  },
  quality: {
    minScoreBonus: 24,
    preferOverGeneric: true
  }
};
