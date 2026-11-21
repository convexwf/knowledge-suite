import type {
  Annotation,
  CollectionSummary,
  KnowledgeItem,
  RawDoc,
  ReadingProgressSnapshot
} from "@uknowledge/knowledge-schema";

export interface RemoteCatalogItem {
  itemId: string;
  docId: string | null;
  title: string;
  sourceType: string;
  state: string;
  updatedAt: string;
  parsedAt: string | null;
  contentHash: string | null;
  packageBytes: number | null;
  assetCount: number | null;
  sectionCount: number | null;
  sourceUrl: string | null;
}

export interface RemoteItemMeta {
  schemaVersion: number;
  item: KnowledgeItem;
  documentId: string | null;
  rawdoc?: RawDoc | null;
  annotations: Annotation[];
  readingProgress: ReadingProgressSnapshot | null;
  collections: string[];
}

export interface RemoteCollectionMember {
  membershipId: string;
  memberItemId: string;
  orderIndex: number;
  depth: number;
  parentMembershipId: string | null;
  inclusionMode: string;
  inclusionReason: string | null;
  sourceRuleId: string | null;
}

export interface RemoteCollection {
  collection: CollectionSummary;
  members: RemoteCollectionMember[];
}

export interface RemoteRawdoc {
  contentExt: string;
  contentType: string | null;
  etag: string | null;
  bytes: Buffer;
}

export interface RemoteSuiteClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

export class RemoteSuiteError extends Error {
  constructor(message: string, readonly statusCode?: number) {
    super(message);
    this.name = "RemoteSuiteError";
  }
}

export class RemoteSuiteClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(options: RemoteSuiteClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async categories(): Promise<string[]> {
    const body = await this.json<{ categories: string[] }>("/api/categories");
    return body.categories ?? [];
  }

  async catalog(category = "default"): Promise<RemoteCatalogItem[]> {
    const body = await this.json<{ items: RemoteCatalogItem[] }>(this.categoryPath("/api/sync/catalog", category));
    return body.items ?? [];
  }

  async itemMeta(itemId: string, category = "default"): Promise<RemoteItemMeta> {
    return this.json<RemoteItemMeta>(this.categoryPath(`/api/sync/items/${encodeURIComponent(itemId)}/meta`, category));
  }

  async itemPackage(itemId: string, category = "default"): Promise<Buffer> {
    const response = await this.request(this.categoryPath(`/api/items/${encodeURIComponent(itemId)}/package`, category));
    return Buffer.from(await response.arrayBuffer());
  }

  async itemRawdoc(itemId: string, category = "default"): Promise<RemoteRawdoc> {
    const response = await this.request(this.categoryPath(`/api/sync/items/${encodeURIComponent(itemId)}/rawdoc`, category));
    return {
      contentExt: response.headers.get("x-content-ext") ?? "html",
      contentType: response.headers.get("x-content-type"),
      etag: response.headers.get("etag"),
      bytes: Buffer.from(await response.arrayBuffer())
    };
  }

  async collections(category = "default"): Promise<RemoteCollection[]> {
    const body = await this.json<{ collections: RemoteCollection[] }>(this.categoryPath("/api/sync/collections", category));
    return body.collections ?? [];
  }

  private async json<T>(path: string): Promise<T> {
    const response = await this.request(path);
    return (await response.json()) as T;
  }

  private categoryPath(path: string, category: string): string {
    return `${path}${path.includes("?") ? "&" : "?"}category=${encodeURIComponent(category)}`;
  }

  private async request(path: string): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(this.timeoutMs)
    }).catch((error: unknown) => {
      throw new RemoteSuiteError(`sync source unreachable: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (!response.ok) {
      throw new RemoteSuiteError(`sync source returned ${response.status} for ${path}`, response.status);
    }
    return response;
  }
}
