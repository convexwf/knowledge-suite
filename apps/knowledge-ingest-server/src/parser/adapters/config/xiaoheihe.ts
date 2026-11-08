import type { SiteAdapter } from "../types.js";

export const xiaoheiheAdapter: SiteAdapter = {
  id: "xiaoheihe",
  type: "config",
  priority: 70,
  match: {
    hosts: ["xiaoheihe.cn", "www.xiaoheihe.cn"],
    pathPatterns: ["^/app/bbs/link/"]
  },
  content: {
    selectors: [
      ".hb-bbs-post .post__content",
      ".hb-bbs-image-text",
      ".hb-article",
      ".post__content"
    ],
    excludeSelectors: [
      "script",
      "style",
      "button",
      "form",
      "nav",
      "aside",
      ".link-comment",
      ".link-section-user",
      ".link-section-tags",
      ".header-image__hover-container",
      ".header-image-pagination",
      "[class*='comment']",
      "[class*='download']",
      "[class*='app-promo']"
    ],
    requireTextLength: 80
  },
  metadata: {
    title: [
      ".link-section-title .section-title__content",
      ".link-section-title",
      "meta[property='og:title']",
      "title"
    ],
    author: [".link-user__username", "meta[name='author']"],
    publishedAt: [".link-data__time", "time[datetime]"],
    image: ["meta[property='og:image']", ".hb-article img"]
  },
  cleanup: {
    removeSelectors: [
      "script",
      "style",
      "button",
      "form",
      "nav",
      "aside",
      ".link-section-user",
      ".link-section-tags",
      ".header-image__hover-container",
      ".header-image-pagination",
      "[class*='download']",
      "[class*='app-promo']"
    ],
    normalizeImageAttributes: true,
    normalizeRelativeUrls: true
  },
  hints: {
    defuddleRootSelectors: [".hb-bbs-post .post__content", ".hb-article"],
    fallbackCleanup: true
  },
  quality: {
    minScoreBonus: 80,
    preferOverGeneric: true
  }
};
