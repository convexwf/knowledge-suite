import { CollectionSummary, KnowledgeItem, KnowledgeSourceType } from "./types.js";

export type SourceFilter = KnowledgeSourceType | "collection" | "all";

export interface ReaderListCollection extends CollectionSummary {
  kind: "collection";
}

export interface ReaderListSelection {
  itemId?: string;
  collectionId?: string;
}

export interface BatchDeleteCollectionTarget {
  collectionId: string;
  itemIds: string[];
}

export interface BatchDeletePlan {
  itemIds: string[];
  collectionTargets: BatchDeleteCollectionTarget[];
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

export function buildBatchDeletePlan(
  selections: ReaderListSelection[],
  collectionItemsById: Record<string, string[]>
): BatchDeletePlan {
  const itemIds = new Set<string>();
  const collectionTargets: BatchDeleteCollectionTarget[] = [];
  const seenCollections = new Set<string>();

  for (const selection of selections) {
    if (selection.itemId) {
      itemIds.add(selection.itemId);
    }
    if (!selection.collectionId || seenCollections.has(selection.collectionId)) {
      continue;
    }
    seenCollections.add(selection.collectionId);
    const collectionItemIds = [...new Set(collectionItemsById[selection.collectionId] ?? [])];
    for (const itemId of collectionItemIds) {
      itemIds.add(itemId);
    }
    collectionTargets.push({
      collectionId: selection.collectionId,
      itemIds: collectionItemIds
    });
  }

  return {
    itemIds: [...itemIds],
    collectionTargets
  };
}

export function resolveCollectionShellsToDelete(
  collectionTargets: BatchDeleteCollectionTarget[],
  successfulItemIds: Iterable<string>
): string[] {
  const successful = new Set(successfulItemIds);
  return collectionTargets
    .filter((target) => target.itemIds.every((itemId) => successful.has(itemId)))
    .map((target) => target.collectionId);
}

function sortEntries(entries: ReaderListEntry[]): ReaderListEntry[] {
  return [...entries].sort((left, right) => {
    const rightTime = Date.parse(right.updatedAt);
    const leftTime = Date.parse(left.updatedAt);
    return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
  });
}
