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

export function resolveCanonicalUrl(originalUrl: string, pageCanonicalUrl?: string): string {
  for (const adapter of siteAdapters) {
    const canonicalUrl = adapter.urlTransforms?.canonicalUrl?.(originalUrl);
    if (canonicalUrl) {
      return canonicalUrl;
    }
  }
  return pageCanonicalUrl || originalUrl;
}

export function resolveFetchUrl(inputUrl: string): string {
  for (const adapter of siteAdapters) {
    const fetchUrl = adapter.urlTransforms?.fetchUrl?.(inputUrl);
    if (fetchUrl) {
      return fetchUrl;
    }
  }
  return inputUrl;
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
  const matched = candidateUrls(input)
    .map((candidate) => matchAdapterUrl(adapter, candidate.value, candidate.label))
    .filter((match): match is Omit<MatchedAdapter, "adapter"> => Boolean(match))
    .sort((left, right) => right.matchScore - left.matchScore)[0];

  if (!matched) {
    return undefined;
  }

  return {
    adapter,
    matchScore: matched.matchScore + adapter.priority / 10,
    matchReason: matched.matchReason
  };
}

function candidateUrls(input: ResolvedInput): Array<{ label: string; value: string }> {
  const candidates = [
    { label: "url", value: input.url },
    { label: "originalUrl", value: input.originalUrl }
  ];
  return candidates.filter((candidate, index) =>
    candidate.value && candidates.findIndex((other) => other.value === candidate.value) === index
  );
}

function matchAdapterUrl(
  adapter: SiteAdapter,
  value: string,
  label: string
): Omit<MatchedAdapter, "adapter"> | undefined {
  const url = safeUrl(value);
  if (!url) {
    return undefined;
  }

  const reasons: string[] = [];
  let score = 0;

  if (adapter.match.hosts?.includes(url.hostname)) {
    score += 100;
    reasons.push(`${label}:host:${url.hostname}`);
  }

  for (const suffix of adapter.match.hostSuffixes ?? []) {
    if (url.hostname.endsWith(suffix)) {
      score += 80;
      reasons.push(`${label}:hostSuffix:${suffix}`);
    }
  }

  for (const pattern of adapter.match.pathPatterns ?? []) {
    if (new RegExp(pattern).test(url.pathname)) {
      score += 50;
      reasons.push(`${label}:path:${pattern}`);
    }
  }

  for (const pattern of adapter.match.urlPatterns ?? []) {
    if (new RegExp(pattern).test(value)) {
      score += 40;
      reasons.push(`${label}:url:${pattern}`);
    }
  }

  if (score === 0) {
    return undefined;
  }

  return {
    matchScore: score,
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
