import type { SiteAdapter } from "../types.js";

export const blogGoogleAdapter: SiteAdapter = {
  id: "blog_google",
  type: "config",
  priority: 80,
  match: {
    hosts: ["blog.google", "www.blog.google"]
  },
  content: {
    selectors: ["div.rich-text", "article div.rich-text", "main div.rich-text"],
    excludeSelectors: [
      "script",
      "style",
      "button",
      "form",
      "aside",
      "[class*='newsletter']",
      "[class*='share']",
      "[class*='related']"
    ],
    requireTextLength: 140
  },
  metadata: {
    title: ["meta[property='og:title']", "h1", "title"],
    author: ["meta[name='authors']", "meta[name='article-author']", "meta[name='author']"],
    publishedAt: ["meta[name='published_time']", "meta[property='article:published_time']", "time[datetime]"],
    image: ["meta[property='og:image']", "div.rich-text img"]
  },
  cleanup: {
    removeSelectors: ["script", "style", "button", "form", "aside", "[class*='newsletter']", "[class*='share']"],
    normalizeImageAttributes: true,
    normalizeRelativeUrls: true
  },
  hints: {
    defuddleRootSelectors: ["div.rich-text"],
    fallbackCleanup: true
  },
  quality: {
    minScoreBonus: 25,
    preferOverGeneric: true
  }
};
