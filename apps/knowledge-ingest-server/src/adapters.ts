import { ResolvedInput } from "./input.js";

export interface AdapterMatchConfig {
  hosts?: string[];
  hostSuffixes?: string[];
  urlPatterns?: string[];
  pathPatterns?: string[];
}

export interface AdapterContentConfig {
  selectors: string[];
  excludeSelectors?: string[];
  requireTextLength?: number;
}

export interface AdapterCleanupConfig {
  removeSelectors?: string[];
  unwrapSelectors?: string[];
  normalizeImageAttributes?: boolean;
  normalizeRelativeUrls?: boolean;
}

export interface AdapterMetadataConfig {
  title?: string[];
  author?: string[];
  publishedAt?: string[];
  image?: string[];
}

export interface SiteAdapter {
  id: string;
  priority: number;
  match: AdapterMatchConfig;
  content: AdapterContentConfig;
  metadata?: AdapterMetadataConfig;
  cleanup?: AdapterCleanupConfig;
  quality?: {
    minScoreBonus?: number;
    preferOverGeneric?: boolean;
  };
}

export interface MatchedAdapter {
  adapter: SiteAdapter;
  matchScore: number;
  matchReason: string;
}

export const siteAdapters: SiteAdapter[] = [
  {
    id: "freedium",
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
      normalizeRelativeUrls: true
    },
    quality: {
      minScoreBonus: 30,
      preferOverGeneric: true
    }
  },
  {
    id: "medium",
    priority: 70,
    match: {
      hosts: ["medium.com"],
      hostSuffixes: [".medium.com"]
    },
    content: {
      selectors: ["article", "main article", "main"],
      excludeSelectors: [
        "nav",
        "header",
        "footer",
        "aside",
        "[aria-label*='clap' i]",
        "[class*='meter']",
        "[class*='recommend']",
        "[class*='related']"
      ],
      requireTextLength: 120
    },
    metadata: {
      title: ["h1", "meta[property='og:title']", "title"],
      author: ["a[rel='author']", "a[href*='/@']", "meta[name='author']"],
      publishedAt: ["time[datetime]", "meta[property='article:published_time']"],
      image: ["meta[property='og:image']", "article img"]
    },
    cleanup: {
      removeSelectors: ["script", "style", "button", "form", "aside"],
      normalizeImageAttributes: true,
      normalizeRelativeUrls: true
    },
    quality: {
      minScoreBonus: 20
    }
  }
];

export function matchSiteAdapters(input: ResolvedInput): MatchedAdapter[] {
  return siteAdapters
    .map((adapter) => matchAdapter(adapter, input))
    .filter((match): match is MatchedAdapter => Boolean(match))
    .sort((left, right) => {
      if (right.matchScore !== left.matchScore) {
        return right.matchScore - left.matchScore;
      }
      return right.adapter.priority - left.adapter.priority;
    });
}

function matchAdapter(adapter: SiteAdapter, input: ResolvedInput): MatchedAdapter | undefined {
  const url = safeUrl(input.url);
  if (!url) {
    return undefined;
  }

  const reasons: string[] = [];
  let score = 0;

  if (adapter.match.hosts?.includes(url.hostname)) {
    score += 100;
    reasons.push(`host:${url.hostname}`);
  }

  for (const suffix of adapter.match.hostSuffixes ?? []) {
    if (url.hostname.endsWith(suffix)) {
      score += 80;
      reasons.push(`hostSuffix:${suffix}`);
    }
  }

  for (const pattern of adapter.match.pathPatterns ?? []) {
    if (new RegExp(pattern).test(url.pathname)) {
      score += 50;
      reasons.push(`path:${pattern}`);
    }
  }

  for (const pattern of adapter.match.urlPatterns ?? []) {
    if (new RegExp(pattern).test(input.url)) {
      score += 40;
      reasons.push(`url:${pattern}`);
    }
  }

  if (score === 0) {
    return undefined;
  }

  return {
    adapter,
    matchScore: score + adapter.priority / 10,
    matchReason: reasons.join(", ")
  };
}

function safeUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}
