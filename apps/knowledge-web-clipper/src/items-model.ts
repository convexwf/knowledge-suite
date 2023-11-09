import { CollectionSummary, KnowledgeItem, KnowledgeSourceType } from "./types.js";

export type SourceFilter = KnowledgeSourceType | "collection" | "all";

export interface ReaderListCollection extends CollectionSummary {
  kind: "collection";
}

export interface ReaderListStandalone extends KnowledgeItem {
  kind: "standalone";
}

export type ReaderListEntry = ReaderListCollection | ReaderListStandalone;

export function normalizeSourceFilter(value: string | null | undefined): SourceFilter {
  return value === "url" || value === "epub" || value === "pdf" || value === "singlefile_html" || value === "collection"
    ? value
    : "all";
}

export function buildReaderListEntries(params: {
  items: KnowledgeItem[];
  collections: CollectionSummary[];
  sourceFilter: SourceFilter;
}): ReaderListEntry[] {
  const { items, collections, sourceFilter } = params;
  const standaloneItems = items.filter((item) => (item.collectionIds?.length ?? 0) === 0);

  const standaloneEntries = standaloneItems
    .filter((item) => sourceFilter === "all" || sourceFilter === item.sourceType)
    .map((item) => ({ ...item, kind: "standalone" as const }));

  const collectionEntries = collections
    .filter(() => sourceFilter === "all" || sourceFilter === "collection")
    .map((collection) => ({ ...collection, kind: "collection" as const }));

  return sortEntries([...collectionEntries, ...standaloneEntries]);
}

function sortEntries(entries: ReaderListEntry[]): ReaderListEntry[] {
  return [...entries].sort((left, right) => {
    const rightTime = Date.parse(right.updatedAt);
    const leftTime = Date.parse(left.updatedAt);
    return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
  });
}
