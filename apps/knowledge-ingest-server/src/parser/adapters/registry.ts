import type { ResolvedInput } from "../../input.js";
import { codeAdapters } from "./code/index.js";
import { configAdapters } from "./config/index.js";
import type { MatchedAdapter, SiteAdapter } from "./types.js";

export const siteAdapters: SiteAdapter[] = validateSiteAdapters([
  ...configAdapters,
  ...codeAdapters
]);

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

export function validateSiteAdapters(adapters: SiteAdapter[]): SiteAdapter[] {
  const ids = new Set<string>();
  for (const adapter of adapters) {
    if (ids.has(adapter.id)) {
      throw new Error(`Duplicate site adapter id: ${adapter.id}`);
    }
    ids.add(adapter.id);
  }
  return adapters;
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
