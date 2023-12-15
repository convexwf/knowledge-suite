import { createHash } from "node:crypto";
import type { KnowledgeDocument } from "@uknowledge/knowledge-schema";

export const PACKAGE_SCHEMA_VERSION = 1;

export interface PackageEntry {
  path: string;
  bytes: Buffer;
}

export interface PackageManifestAsset {
  assetId: string;
  path: string;
  mediaType: string;
  size: number;
}

export interface PackageManifestFile {
  path: string;
  sha256: string;
  size: number;
}

export interface PackageManifest {
  schemaVersion: number;
  itemId: string;
  docId: string;
  contentHash: string;
  generatedAt: string;
  sourceType: string;
  title: string;
  documentBytes: number;
  sections: number;
  files: PackageManifestFile[];
  assets: PackageManifestAsset[];
  warnings: string[];
}

export function sha256Buffer(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256Text(value: string): string {
  return sha256Buffer(Buffer.from(value, "utf8"));
}

/**
 * Canonical JSON: object keys sorted recursively, `undefined` values dropped.
 * The package contract hashes this exact byte sequence, so serialization must
 * stay stable across runs and platforms.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const next = record[key];
      if (next === undefined) continue;
      sorted[key] = sortValue(next);
    }
    return sorted;
  }
  return value;
}

export function serializeDocumentFile(document: KnowledgeDocument): Buffer {
  return Buffer.from(`${canonicalJson(document)}\n`, "utf8");
}

export function serializeMarkdownFile(markdown: string): Buffer {
  const normalized = markdown.replace(/\r\n/g, "\n");
  return Buffer.from(normalized.endsWith("\n") ? normalized : `${normalized}\n`, "utf8");
}

export function sortEntries(entries: PackageEntry[]): PackageEntry[] {
  return [...entries].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

/**
 * Content hash defined by the offline package contract: sort entries by path,
 * hash each file, then hash the `"<path>\0<sha256>\n"` manifest string. The zip
 * container bytes are intentionally excluded so compression choices cannot
 * change the fingerprint.
 */
export function packageContentHash(entries: PackageEntry[]): string {
  const manifestText = sortEntries(entries)
    .map((entry) => `${entry.path}\u0000${sha256Buffer(entry.bytes)}\n`)
    .join("");
  return sha256Buffer(Buffer.from(manifestText, "utf8"));
}

export function packageContentBytes(entries: PackageEntry[]): number {
  return entries.reduce((total, entry) => total + entry.bytes.byteLength, 0);
}

export function buildPackageManifest(params: {
  itemId: string;
  docId: string;
  sourceType: string;
  title: string;
  contentHash: string;
  generatedAt: string;
  sections: number;
  entries: PackageEntry[];
  assets: PackageManifestAsset[];
  warnings?: string[];
}): PackageManifest {
  const sorted = sortEntries(params.entries);
  const documentEntry = sorted.find((entry) => entry.path === "document.json");
  return {
    schemaVersion: PACKAGE_SCHEMA_VERSION,
    itemId: params.itemId,
    docId: params.docId,
    contentHash: params.contentHash,
    generatedAt: params.generatedAt,
    sourceType: params.sourceType,
    title: params.title,
    documentBytes: documentEntry?.bytes.byteLength ?? 0,
    sections: params.sections,
    files: sorted.map((entry) => ({
      path: entry.path,
      sha256: sha256Buffer(entry.bytes),
      size: entry.bytes.byteLength
    })),
    assets: params.assets,
    warnings: params.warnings ?? []
  };
}
