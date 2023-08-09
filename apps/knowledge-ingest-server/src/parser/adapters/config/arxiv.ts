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
  urlTransforms: {
    fetchUrl: arxivHtmlFetchUrl
  },
  enrich: {
    tags: arxivTags,
    references: extractArxivReferences
  },
  quality: {
    minScoreBonus: 45,
    preferOverGeneric: true
  }
};

function arxivTags(url: string): string[] {
  const arxivId = arxivIdFromUrl(url);
  return unique([
    arxivId ? `paper:work_id:arxiv:${arxivId}` : "",
    "paper:variant:preprint"
  ]);
}

function arxivHtmlFetchUrl(input: string): string | undefined {
  const arxivId = arxivIdFromUrl(input);
  return arxivId ? `https://arxiv.org/html/${arxivId}` : undefined;
}

function arxivIdFromUrl(input: string): string | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (url.hostname !== "arxiv.org" && url.hostname !== "www.arxiv.org") {
    return undefined;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] && ["abs", "html", "pdf"].includes(parts[0].toLowerCase())) {
    parts.shift();
  }
  let tail = parts.join("/");
  if (tail.toLowerCase().endsWith(".pdf")) {
    tail = tail.slice(0, -4);
  }
  return /^(\d{4}\.\d{4,5}|[a-z][a-z0-9-]*(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?$/i.test(tail)
    ? tail
    : undefined;
}

function extractArxivReferences(root: Element): Array<{ ref_id: string; label?: string; text: string; blocks?: string[] }> {
  const references: Array<{ ref_id: string; label?: string; text: string; blocks?: string[] }> = [];
  const bibliography = root.querySelector(".ltx_bibliography, section.ltx_bibliography, [id^='bib']");
  if (!bibliography) {
    return references;
  }
  for (const item of bibliography.querySelectorAll("li[id], .ltx_bibitem[id]")) {
    const refId = item.getAttribute("id");
    const text = normalizeText(item.textContent ?? "");
    if (!refId || !text) {
      continue;
    }
    references.push({
      ref_id: refId,
      label: item.querySelector(".ltx_tag")?.textContent?.trim() || undefined,
      text
    });
  }
  return references;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
