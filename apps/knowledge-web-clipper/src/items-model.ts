import { CollectionSummary, KnowledgeItem, KnowledgeSourceType } from "./types.js";

export type StructureFilter = "all" | "collections" | "standalone";
export type SourceFilter = KnowledgeSourceType | "all";

export interface ReaderListCollection extends CollectionSummary {
  kind: "collection";
}

export interface ReaderListStandalone extends KnowledgeItem {
  kind: "standalone";
}

export type ReaderListEntry = ReaderListCollection | ReaderListStandalone;

export function normalizeStructureFilter(value: string | null | undefined): StructureFilter {
  return value === "collections" || value === "standalone" ? value : "all";
}

export function normalizeSourceFilter(value: string | null | undefined): SourceFilter {
  return value === "url" || value === "epub" || value === "pdf" || value === "singlefile_html" ? value : "all";
}

export function buildReaderListEntries(params: {
  items: KnowledgeItem[];
  collections: CollectionSummary[];
  structureFilter: StructureFilter;
  sourceFilter: SourceFilter;
}): ReaderListEntry[] {
  const { items, collections, structureFilter, sourceFilter } = params;
  const standaloneItems = items.filter((item) => (item.collectionIds?.length ?? 0) === 0);

  const standaloneEntries = standaloneItems
    .filter((item) => sourceFilter === "all" || item.sourceType === sourceFilter)
    .map((item) => ({ ...item, kind: "standalone" as const }));

  const collectionEntries = collections
    .filter((collection) => sourceFilter === "all" || collection.sourceType === sourceFilter)
    .map((collection) => ({ ...collection, kind: "collection" as const }));

  if (structureFilter === "collections") {
    return sortEntries(collectionEntries);
  }
  if (structureFilter === "standalone") {
    return sortEntries(standaloneEntries);
  }
  return sortEntries([...collectionEntries, ...standaloneEntries]);
}

function sortEntries(entries: ReaderListEntry[]): ReaderListEntry[] {
  return [...entries].sort((left, right) => {
    const rightTime = Date.parse(entryUpdatedAt(right));
    const leftTime = Date.parse(entryUpdatedAt(left));
    return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
  });
}

function entryUpdatedAt(entry: ReaderListEntry): string {
  return entry.kind === "collection" ? entry.updatedAt : entry.updatedAt;
}
