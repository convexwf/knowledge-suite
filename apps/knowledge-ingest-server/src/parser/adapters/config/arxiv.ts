import type { SiteAdapter } from "../types.js";

export const arxivHtmlAdapter: SiteAdapter = {
  id: "arxiv_html",
  type: "config",
  priority: 100,
  match: {
    hosts: ["arxiv.org", "www.arxiv.org"],
    pathPatterns: ["^/(abs|html|pdf)/"]
  },
  content: {
    selectors: ["article.ltx_document", "article"],
    excludeSelectors: [
      "nav",
      "header",
      "footer",
      ".ltx_page_footer",
      ".ltx_role_navigation"
    ],
    requireTextLength: 200
  },
  metadata: {
    title: ["h1.ltx_title_document", "meta[name='citation_title']", "meta[property='og:title']", "title"],
    author: [".ltx_authors .ltx_personname", "meta[name='citation_author']"],
    publishedAt: ["meta[name='citation_publication_date']", "meta[name='citation_online_date']"],
    image: ["meta[property='og:image']", "article.ltx_document img.ltx_graphics"]
  },
  cleanup: {
    removeSelectors: ["script", "style", "button", "form", "nav", "header", "footer"],
    normalizeImageAttributes: true,
    normalizeRelativeUrls: true
  },
  hints: {
    defuddleRootSelectors: ["article.ltx_document", "article"],
    fallbackCleanup: true
  },
  quality: {
    minScoreBonus: 45,
    preferOverGeneric: true
  }
};
