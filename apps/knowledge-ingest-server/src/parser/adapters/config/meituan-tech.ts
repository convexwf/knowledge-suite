import type { SiteAdapter } from "../types.js";

export const meituanTechAdapter: SiteAdapter = {
  id: "meituan_tech",
  type: "config",
  priority: 85,
  match: {
    hosts: ["tech.meituan.com", "www.tech.meituan.com"]
  },
  content: {
    selectors: ["div.post-content div.content", "article div.content", "main"],
    excludeSelectors: [
      "script",
      "style",
      "button",
      "form",
      "aside",
      ".qrcode",
      "[class*='qr']",
      "[class*='share']",
      "[class*='recommend']",
      "[class*='related']"
    ],
    requireTextLength: 180
  },
  metadata: {
    title: ["h1.post-title a", "h1.post-title", "meta[property='og:title']", "title"],
    author: ["div.post-container > div.meta-box:not(.post-bottom-meta-box) .m-post-nick", "meta[name='author']"],
    publishedAt: [
      "meta[property='article:published_time']",
      "div.post-container > div.meta-box:not(.post-bottom-meta-box) .m-post-date"
    ],
    image: ["meta[property='og:image']", "div.post-content div.content img"]
  },
  cleanup: {
    removeSelectors: ["script", "style", "button", "form", "aside", ".qrcode", "[class*='share']"],
    normalizeImageAttributes: true,
    normalizeRelativeUrls: true
  },
  hints: {
    defuddleRootSelectors: ["div.post-content div.content"],
    fallbackCleanup: true
  },
  quality: {
    minScoreBonus: 30,
    preferOverGeneric: true
  }
};
