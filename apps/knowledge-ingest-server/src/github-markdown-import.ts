import { createHash } from "node:crypto";
import MarkdownIt from "markdown-it";
import { GitHubClient, GitHubClientError, GitHubTreeEntry, type GitHubBlobResult } from "./github-client.js";
import type { MarkdownRemoteAssetInput } from "./markdown-import.js";

export interface GitHubMarkdownRequest {
  owner: string;
  repo: string;
  ref: string;
  path: string;
  tags?: string[];
}

export interface GitHubImageAsset {
  path: string;
  blobSha?: string;
  size?: number;
  mediaType: string;
  sourceReferences: string[];
  assetRef: string;
}

export interface GitHubMarkdownDocument {
  path: string;
  blobSha: string;
  size: number;
  content: Buffer;
  assets: GitHubImageAsset[];
  warnings: string[];
}

export interface GitHubMarkdownFetchResult {
  owner: string;
  repo: string;
  ref: string;
  path: string;
  commitSha: string;
  private: boolean;
  documents: GitHubMarkdownDocument[];
  warnings: string[];
}

export interface GitHubMarkdownFetchLimits {
  maxFiles: number;
  maxMarkdownBytes: number;
  maxAssetReferences: number;
}

export interface GitHubMarkdownFetchOptions {
  commitSha?: string;
  private?: boolean;
  directContent?: GitHubBlobResult;
}

const MARKDOWN_EXTENSIONS = /\.(?:md|markdown)$/i;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"]);

export function parseGitHubMarkdownRequest(body: unknown): GitHubMarkdownRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new GitHubClientError("github_invalid_request", 400);
  }
  const record = body as Record<string, unknown>;
  const owner = requiredField(record.owner, "owner");
  const repo = requiredField(record.repo, "repo");
  const ref = requiredField(record.ref, "ref");
  const path = requiredField(record.path, "path");
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) {
    throw new GitHubClientError("github_invalid_repository", 400);
  }
  if (ref.length > 256 || ref.startsWith("/") || /[\u0000-\u001f]/.test(ref)) {
    throw new GitHubClientError("github_invalid_ref", 400);
  }
  if (
    path.length > 1024 ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    /^(?:https?:)?\/\//i.test(path) ||
    /[\u0000-\u001f]/.test(path)
  ) {
    throw new GitHubClientError("github_invalid_path", 400);
  }
  const normalizedPath = normalizeRepoPath(path);
  if (!normalizedPath) {
    throw new GitHubClientError("github_invalid_path", 400);
  }
  const tags = Array.isArray(record.tags)
    ? record.tags.map(String).map((tag) => tag.trim()).filter(Boolean)
    : undefined;
  return { owner, repo, ref, path: normalizedPath, tags };
}

export async function fetchGitHubMarkdown(
  client: GitHubClient,
  request: GitHubMarkdownRequest,
  limits: GitHubMarkdownFetchLimits,
  options: GitHubMarkdownFetchOptions = {}
): Promise<GitHubMarkdownFetchResult> {
  const source = parseGitHubMarkdownRequest(request);
  const repository = options.private == null
    ? await client.repository(source.owner, source.repo)
    : { private: options.private };
  const commitSha = options.commitSha ?? await client.resolveRef(source.owner, source.repo, source.ref);
  const directContent = options.directContent ?? (MARKDOWN_EXTENSIONS.test(source.path)
    ? await client.contentFile(source.owner, source.repo, source.path, commitSha, limits.maxMarkdownBytes)
    : undefined);
  const treeResult = directContent ? undefined : await client.tree(source.owner, source.repo, commitSha);
  const entries = directContent
    ? [{ path: source.path, type: "blob" as const, sha: directContent.sha, size: directContent.size }]
    : treeResult?.truncated
      ? await client.contents(source.owner, source.repo, source.path, commitSha)
      : treeResult?.entries ?? [];
  const selected = selectMarkdownEntries(entries, source.path);
  if (selected.length === 0) {
    throw new GitHubClientError("github_no_markdown_files", 400);
  }
  if (selected.length > limits.maxFiles) {
    throw new GitHubClientError("github_file_limit_exceeded", 413);
  }

  const allEntries = new Map<string, GitHubTreeEntry>();
  for (const entry of entries) allEntries.set(entry.path, entry);
  const documents: GitHubMarkdownDocument[] = [];
  const warnings: string[] = [];
  let totalMarkdownBytes = 0;
  let totalAssetReferences = 0;

  for (const entry of selected) {
    if (entry.size != null && totalMarkdownBytes + entry.size > limits.maxMarkdownBytes) {
      throw new GitHubClientError("github_markdown_limit_exceeded", 413);
    }
    const blob = directContent && entry.path === source.path
      ? directContent
      : await client.blob(source.owner, source.repo, entry.sha, limits.maxMarkdownBytes);
    totalMarkdownBytes += blob.bytes.length;
    if (totalMarkdownBytes > limits.maxMarkdownBytes) {
      throw new GitHubClientError("github_markdown_limit_exceeded", 413);
    }

    const documentWarnings: string[] = [];
    const assetsByPath = new Map<string, GitHubImageAsset>();
    const references = extractImageReferences(blob.bytes.toString("utf8"));
    for (const reference of references) {
      if (isUnsupportedRemoteReference(reference)) continue;
      const assetPath = resolveGitHubAssetPath(source.owner, source.repo, entry.path, reference);
      if (!assetPath) continue;
      totalAssetReferences += 1;
      if (totalAssetReferences > limits.maxAssetReferences) {
        throw new GitHubClientError("github_asset_reference_limit_exceeded", 413);
      }
      const assetEntry = allEntries.get(assetPath);
      if (!isSupportedImagePath(assetPath)) {
        documentWarnings.push(`Unsupported GitHub image type skipped: ${reference}`);
        continue;
      }
      const existing = assetsByPath.get(assetPath);
      if (existing) {
        existing.sourceReferences.push(reference);
        continue;
      }
      assetsByPath.set(assetPath, {
        path: assetPath,
        ...(assetEntry?.type === "blob" ? { blobSha: assetEntry.sha, size: assetEntry.size } : {}),
        mediaType: contentTypeForPath(assetPath),
        sourceReferences: [reference],
        assetRef: githubAssetRef(assetPath, commitSha)
      });
    }

    const document = {
      path: entry.path,
      blobSha: entry.sha,
      size: blob.bytes.length,
      content: blob.bytes,
      assets: [...assetsByPath.values()],
      warnings: documentWarnings
    };
    documents.push(document);
    warnings.push(...documentWarnings.map((warning) => `${entry.path}: ${warning}`));
  }

  return {
    ...source,
    commitSha,
    private: repository.private,
    documents,
    warnings
  };
}

export function githubSourceKey(owner: string, repo: string, ref: string, path: string): string {
  return `github.com/${owner}/${repo}@${ref}:${path}`;
}

export function githubItemId(owner: string, repo: string, ref: string, path: string): string {
  const sourceKey = githubSourceKey(owner, repo, ref, path);
  const hash = createHash("sha256").update(sourceKey, "utf8").digest("hex");
  return `github:sha256:${hash}`;
}

export function githubBlobUrl(owner: string, repo: string, commitSha: string, path: string): string {
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/blob/${encodeURIComponent(commitSha)}/${encodePath(path)}`;
}

export function githubRawUrl(owner: string, repo: string, commitSha: string, path: string): string {
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(commitSha)}/${encodePath(path)}`;
}

export function githubAssetRef(path: string, commitSha: string): string {
  return Buffer.from(`${commitSha}:${path}`, "utf8").toString("base64url");
}

export function githubRemoteAssetsForItem(
  itemId: string,
  source: Pick<GitHubMarkdownFetchResult, "owner" | "repo" | "commitSha" | "private">,
  assets: GitHubImageAsset[]
): {
  inputs: MarkdownRemoteAssetInput[];
  metadata: Array<Record<string, unknown>>;
} {
  const inputs: MarkdownRemoteAssetInput[] = [];
  const metadata: Array<Record<string, unknown>> = [];
  for (const asset of assets) {
    const sourceUrl = source.private
      ? `/api/items/${encodeURIComponent(itemId)}/github-asset/${encodeURIComponent(asset.assetRef)}`
      : githubRawUrl(source.owner, source.repo, source.commitSha, asset.path);
    for (const sourceReference of asset.sourceReferences) {
      inputs.push({ relativePath: asset.path, source: sourceReference, sourceUrl });
    }
    metadata.push({
      path: asset.path,
      ...(asset.blobSha ? { blobSha: asset.blobSha } : {}),
      ...(asset.size != null ? { size: asset.size } : {}),
      mediaType: asset.mediaType,
      delivery: source.private ? "proxy" : "raw",
      assetRef: asset.assetRef,
      sourceUrl
    });
  }
  return { inputs, metadata };
}

function selectMarkdownEntries(entries: GitHubTreeEntry[], path: string): GitHubTreeEntry[] {
  const exact = entries.find((entry) => entry.path === path);
  if (exact) {
    if (exact.type === "blob") {
      return MARKDOWN_EXTENSIONS.test(exact.path) ? [exact] : [];
    }
  }
  const prefix = `${path}/`;
  return entries
    .filter((entry) => entry.type === "blob" && entry.path.startsWith(prefix) && MARKDOWN_EXTENSIONS.test(entry.path))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function extractImageReferences(markdown: string): string[] {
  const parser = new MarkdownIt({ html: false, linkify: false, typographer: false });
  const references: string[] = [];
  for (const token of parser.parse(markdown, {})) {
    for (const child of token.children ?? []) {
      if (child.type === "image") {
        const source = child.attrGet("src");
        if (source) references.push(source);
      }
    }
  }
  return [...new Set(references)];
}

function resolveGitHubAssetPath(owner: string, repo: string, markdownPath: string, reference: string): string | undefined {
  const decoded = decodeReference(reference);
  if (!decoded) return undefined;
  if (isRemoteReference(decoded)) {
    return githubPathFromUrl(owner, repo, decoded);
  }
  if (decoded.startsWith("/")) return undefined;
  return normalizeRepoPath(joinRepoPath(dirnameRepoPath(markdownPath), decoded));
}

function githubPathFromUrl(owner: string, repo: string, reference: string): string | undefined {
  let url: URL;
  try {
    url = new URL(reference);
  } catch {
    return undefined;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (url.hostname === "raw.githubusercontent.com") {
    if (segments.length < 4 || !sameSegment(segments[0], owner) || !sameSegment(segments[1], repo)) return undefined;
    const rest = stripGitHubRefSegments(segments.slice(2));
    return normalizeRepoPath(rest.join("/"));
  }
  if (url.hostname !== "github.com" || segments.length < 5) return undefined;
  if (!sameSegment(segments[0], owner) || !sameSegment(segments[1], repo) || segments[2] !== "blob") return undefined;
  return normalizeRepoPath(segments.slice(4).join("/"));
}

function stripGitHubRefSegments(segments: string[]): string[] {
  if (segments[0] === "refs" && (segments[1] === "heads" || segments[1] === "tags")) {
    return segments.slice(3);
  }
  return segments.slice(1);
}

function decodeReference(reference: string): string | undefined {
  try {
    return decodeURIComponent(reference).split(/[?#]/, 1)[0] || undefined;
  } catch {
    return undefined;
  }
}

function isRemoteReference(value: string): boolean {
  return /^(?:https?:)?\/\//i.test(value);
}

function isUnsupportedRemoteReference(value: string): boolean {
  return /^(?:data|blob):/i.test(value);
}

function normalizeRepoPath(value: string): string | undefined {
  const parts: string[] = [];
  for (const part of value.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.length > 0 ? parts.join("/") : undefined;
}

function joinRepoPath(base: string, reference: string): string {
  return [base, reference].filter(Boolean).join("/");
}

function dirnameRepoPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function encodePath(path: string): string {
  return path.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function sameSegment(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function isSupportedImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && IMAGE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

function contentTypeForPath(path: string): string {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  return {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".avif": "image/avif"
  }[extension] ?? "application/octet-stream";
}

function requiredField(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new GitHubClientError(`github_${name}_required`, 400);
  }
  return value.trim();
}
