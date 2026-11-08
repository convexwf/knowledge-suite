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

  async catalog(): Promise<RemoteCatalogItem[]> {
    const body = await this.json<{ items: RemoteCatalogItem[] }>("/api/sync/catalog");
    return body.items ?? [];
  }

  async itemMeta(itemId: string): Promise<RemoteItemMeta> {
    return this.json<RemoteItemMeta>(`/api/sync/items/${encodeURIComponent(itemId)}/meta`);
  }

  async itemPackage(itemId: string): Promise<Buffer> {
    const response = await this.request(`/api/items/${encodeURIComponent(itemId)}/package`);
    return Buffer.from(await response.arrayBuffer());
  }

  async itemRawdoc(itemId: string): Promise<RemoteRawdoc> {
    const response = await this.request(`/api/sync/items/${encodeURIComponent(itemId)}/rawdoc`);
    return {
      contentExt: response.headers.get("x-content-ext") ?? "html",
      contentType: response.headers.get("x-content-type"),
      etag: response.headers.get("etag"),
      bytes: Buffer.from(await response.arrayBuffer())
    };
  }

  async collections(): Promise<RemoteCollection[]> {
    const body = await this.json<{ collections: RemoteCollection[] }>("/api/sync/collections");
    return body.collections ?? [];
  }

  private async json<T>(path: string): Promise<T> {
    const response = await this.request(path);
    return (await response.json()) as T;
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
