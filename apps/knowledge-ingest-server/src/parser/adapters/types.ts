import type { ResolvedInput } from "../../input.js";

export type SiteAdapterType = "config" | "code" | "generic";

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

export interface AdapterHintsConfig {
  defuddleRootSelectors?: string[];
  fallbackCleanup?: boolean;
}

export interface SiteAdapter {
  id: string;
  type: SiteAdapterType;
  priority: number;
  match: AdapterMatchConfig;
  content: AdapterContentConfig;
  metadata?: AdapterMetadataConfig;
  cleanup?: AdapterCleanupConfig;
  hints?: AdapterHintsConfig;
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

export type AdapterMatcher = (input: ResolvedInput) => MatchedAdapter[];
