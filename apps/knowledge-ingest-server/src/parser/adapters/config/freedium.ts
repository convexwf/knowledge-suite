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
    removeLinkCards: true,
    normalizeRelativeUrls: true
  },
  hints: {
    defuddleRootSelectors: ["article", ".main-content", "main"],
    fallbackCleanup: true
  },
  urlTransforms: {
    canonicalUrl: sourceUrlFromFreediumPath
  },
  quality: {
    minScoreBonus: 30,
    preferOverGeneric: true
  }
};

function sourceUrlFromFreediumPath(input: string): string | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }

  if (url.hostname !== "freedium-mirror.cfd") {
    return undefined;
  }

  const path = url.pathname.startsWith("/") ? url.pathname.slice(1) : url.pathname;
  const embeddedUrl = decodeURIComponent(path);
  if (!/^https?:\/\//i.test(embeddedUrl)) {
    return undefined;
  }

  try {
    return new URL(embeddedUrl).toString();
  } catch {
    return undefined;
  }
}
