export type MarkdownSourceMode = "file" | "folder";

export interface MarkdownImportDocument {
  file: File;
  sourceUri: string;
  relativePath?: string;
  assets: Array<{ file: File; relativePath: string }>;
  referencedAssets: number;
  matchedAssets: number;
  missingAssets: number;
  warnings: string[];
}

export interface MarkdownImportScan {
  documents: MarkdownImportDocument[];
  markdownCount: number;
  ignoredCount: number;
  referencedAssetCount: number;
  matchedAssetCount: number;
  missingAssetCount: number;
  warnings: string[];
}

export interface MarkdownDirectoryHandle {
  name: string;
  values(): AsyncIterable<MarkdownDirectoryEntryHandle>;
}

interface MarkdownDirectoryEntryHandle {
  kind: "file" | "directory";
  name: string;
  values?: () => AsyncIterable<MarkdownDirectoryEntryHandle>;
  getFile?: () => Promise<File>;
}

export interface MarkdownDirectoryFiles {
  files: File[];
  relativePaths: Map<File, string>;
}

interface IndexedFile {
  file: File;
  relativePath: string;
}

export async function scanMarkdownImport(params: {
  mode: MarkdownSourceMode;
  sourceFiles: File[];
  resourceFiles: File[];
  sourceRelativePaths?: ReadonlyMap<File, string>;
  resourceRelativePaths?: ReadonlyMap<File, string>;
  onProgress?: (current: number, total: number) => void;
}): Promise<MarkdownImportScan> {
  const sourceFiles = params.mode === "file"
    ? params.sourceFiles.slice(0, 1)
    : params.sourceFiles;
  const markdownSources = sourceFiles.filter((file) => isMarkdownFile(file));
  const resources = params.resourceFiles.length > 0
    ? indexFiles(params.resourceFiles, params.resourceRelativePaths)
    : params.mode === "folder"
      ? indexFiles(sourceFiles, params.sourceRelativePaths)
      : new Map<string, IndexedFile>();
  const documents: MarkdownImportDocument[] = [];
  const globalWarnings: string[] = [];

  for (let index = 0; index < markdownSources.length; index += 1) {
    const file = markdownSources[index];
    const sourcePath = fileRelativePath(file, params.sourceRelativePaths);
    const relativePath = resources.size > 0
      ? await matchMarkdownPath(file, sourcePath, resources)
      : undefined;
    const warnings: string[] = [];
    const text = await file.text();
    const assets: Array<{ file: File; relativePath: string }> = [];
    const references = extractImageReferences(text);
    const localReferences = uniqueStrings(references.filter((reference) => !isRemoteReference(reference)));

    if (resources.size === 0 && localReferences.length > 0) {
      warnings.push(`No resource folder selected; ${localReferences.length} local image reference(s) will be skipped.`);
    } else if (resources.size > 0 && !relativePath) {
      warnings.push(`Resource folder does not contain the current Markdown: ${file.name}. Local resources were skipped.`);
    } else if (relativePath) {
      const seenAssets = new Set<string>();
      for (const reference of references) {
        if (isRemoteReference(reference)) continue;
        const resolved = resolveRelativePath(relativePath, reference);
        if (!resolved) {
          warnings.push(`Unsafe local image reference skipped: ${reference}`);
          continue;
        }
        const resource = resources.get(resolved);
        if (!resource) {
          warnings.push(`Missing local image: ${reference}`);
          continue;
        }
        if (seenAssets.has(resolved)) continue;
        seenAssets.add(resolved);
        assets.push({ file: resource.file, relativePath: resolved });
      }
    }

    documents.push({
      file,
      sourceUri: sourcePath,
      relativePath,
      assets,
      referencedAssets: localReferences.length,
      matchedAssets: assets.length,
      missingAssets: warnings.filter((warning) => warning.startsWith("Missing local image")).length,
      warnings
    });
    globalWarnings.push(...warnings);
    params.onProgress?.(index + 1, markdownSources.length);
  }

  return {
    documents,
    markdownCount: markdownSources.length,
    ignoredCount: Math.max(0, sourceFiles.length - markdownSources.length),
    referencedAssetCount: documents.reduce((sum, document) => sum + document.referencedAssets, 0),
    matchedAssetCount: documents.reduce((sum, document) => sum + document.matchedAssets, 0),
    missingAssetCount: documents.reduce((sum, document) => sum + document.missingAssets, 0),
    warnings: globalWarnings
  };
}

export function isMarkdownFile(file: File): boolean {
  return /\.(?:md|markdown)$/i.test(file.name);
}

export async function readMarkdownDirectory(handle: MarkdownDirectoryHandle): Promise<MarkdownDirectoryFiles> {
  const files: File[] = [];
  const relativePaths = new Map<File, string>();

  async function visit(directory: MarkdownDirectoryHandle, prefix: string): Promise<void> {
    for await (const entry of directory.values()) {
      const relativePath = normalizePath(prefix ? `${prefix}/${entry.name}` : entry.name);
      if (entry.kind === "directory" && entry.values) {
        await visit(entry as MarkdownDirectoryHandle, relativePath);
      } else if (entry.kind === "file" && entry.getFile) {
        const file = await entry.getFile();
        files.push(file);
        relativePaths.set(file, relativePath);
      }
    }
  }

  await visit(handle, "");
  return { files, relativePaths };
}

export function fileRelativePath(file: File, relativePaths?: ReadonlyMap<File, string>): string {
  const mappedPath = relativePaths?.get(file);
  if (mappedPath) return normalizePath(mappedPath);
  const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return normalizePath(relativePath || file.name);
}

function indexFiles(files: File[], relativePaths?: ReadonlyMap<File, string>): Map<string, IndexedFile> {
  const index = new Map<string, IndexedFile>();
  for (const file of files) {
    const relativePath = fileRelativePath(file, relativePaths);
    if (relativePath && !index.has(relativePath)) {
      index.set(relativePath, { file, relativePath });
    }
  }
  return index;
}

async function matchMarkdownPath(
  sourceFile: File,
  sourcePath: string,
  resources: Map<string, IndexedFile>
): Promise<string | undefined> {
  const candidates = [...resources.values()].filter((entry) => isMarkdownFile(entry.file));
  if (candidates.length === 0) return undefined;

  const suffix = candidates.filter((entry) => entry.relativePath === sourcePath || entry.relativePath.endsWith(`/${sourcePath}`));
  const exact = await uniqueMatchingCandidate(sourceFile, suffix);
  if (exact) return exact.relativePath;

  const sameName = candidates.filter((entry) => entry.file.name === sourceFile.name);
  const metadataMatch = sameName.filter((entry) => sameFileMetadata(sourceFile, entry.file));
  const metadataCandidate = await uniqueMatchingCandidate(sourceFile, metadataMatch);
  if (metadataCandidate) return metadataCandidate.relativePath;

  const hashCandidate = await uniqueHashCandidate(sourceFile, sameName);
  return hashCandidate?.relativePath;
}

async function uniqueMatchingCandidate(sourceFile: File, candidates: IndexedFile[]): Promise<IndexedFile | undefined> {
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) return undefined;
  return unique(await matchingByHash(sourceFile, candidates));
}

async function uniqueHashCandidate(sourceFile: File, candidates: IndexedFile[]): Promise<IndexedFile | undefined> {
  if (candidates.length === 0) return undefined;
  return unique(await matchingByHash(sourceFile, candidates));
}

async function matchingByHash(sourceFile: File, candidates: IndexedFile[]): Promise<IndexedFile[]> {
  const sourceHash = await fileHash(sourceFile);
  const matches: IndexedFile[] = [];
  for (const candidate of candidates) {
    if (sourceHash === await fileHash(candidate.file)) matches.push(candidate);
  }
  return matches;
}

function unique<T>(values: T[]): T | undefined {
  return values.length === 1 ? values[0] : undefined;
}

function sameFileMetadata(left: File, right: File): boolean {
  return left.name === right.name && left.size === right.size && left.lastModified === right.lastModified;
}

async function fileHash(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function extractImageReferences(markdown: string): string[] {
  const references: string[] = [];
  const pattern = /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
  for (const match of markdown.matchAll(pattern)) {
    const reference = match[1] || match[2];
    if (reference) references.push(reference);
  }
  return references;
}

function isRemoteReference(reference: string): boolean {
  return /^(?:https?:)?\/\//i.test(reference) || /^(?:data|blob):/i.test(reference);
}

function resolveRelativePath(markdownPath: string, reference: string): string | undefined {
  let decoded = reference;
  try {
    decoded = decodeURIComponent(reference);
  } catch {
    return undefined;
  }
  decoded = decoded.split(/[?#]/, 1)[0];
  if (!decoded || decoded.startsWith("/")) return undefined;
  const base = markdownPath.split("/").slice(0, -1);
  const parts = [...base, ...decoded.replaceAll("\\", "/").split("/")];
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (normalized.length === 0) return undefined;
      normalized.pop();
      continue;
    }
    normalized.push(part);
  }
  return normalized.join("/") || undefined;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
