import type { SiteAdapter } from "../types.js";

export const redditAdapter: SiteAdapter = {
  id: "reddit",
  type: "config",
  priority: 85,
  match: {
    hosts: ["www.reddit.com", "reddit.com", "old.reddit.com"],
    pathPatterns: ["^/r/[^/]+/comments/"]
  },
  content: {
    selectors: [
      "shreddit-post [property='schema:articleBody']",
      "shreddit-post [slot='text-body']",
      "shreddit-post",
      ".thing.link .usertext-body .md"
    ],
    excludeSelectors: [
      "nav",
      "header",
      "footer",
      "aside",
      "shreddit-comment",
      "[slot='comment']",
      "[data-testid='reddit-chat-client']",
      "[class*='sidebar' i]",
      "[class*='recommend' i]",
      "[class*='related' i]"
    ],
    requireTextLength: 80
  },
  metadata: {
    title: ["shreddit-post[post-title]", "h1", "a.title", "title"],
    author: ["shreddit-post[author]", ".thing.link[data-author]", "[slot='credit-bar'] a[href*='/user/']"],
    publishedAt: ["shreddit-post[created-timestamp]", "time[datetime]"]
  },
  cleanup: {
    removeSelectors: ["script", "style", "button", "form", "nav", "header", "footer", "aside"],
    normalizeImageAttributes: true,
    normalizeRelativeUrls: true
  },
  hints: {
    defuddleRootSelectors: ["shreddit-post", ".thing.link"],
    fallbackCleanup: false
  },
  quality: {
    minScoreBonus: 25,
    preferOverGeneric: true
  }
};
