import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  documentToMarkdown,
  KnowledgeStore,
  parsePage,
  type ResolvedInput
} from "@uknowledge/knowledge-ingest-server/local-import-api.js";
import { normalizeUrlForKnowledge, nowIso, urlHash } from "@uknowledge/knowledge-schema";
import { extractHtmlMetadata, isHttpUrl } from "../html-metadata.js";
import { sha256Text } from "../hash.js";
import { HtmlFileCandidate, ImportOptions, ReportItem } from "../types.js";

export async function importHtmlFile(
  store: KnowledgeStore | undefined,
  candidate: HtmlFileCandidate,
  options: ImportOptions
): Promise<ReportItem> {
  const html = await readFile(candidate.filePath, "utf8");
  const metadata = extractHtmlMetadata(html);
  const sourceUrl = isHttpUrl(metadata.canonicalUrl)
    ? metadata.canonicalUrl
    : isHttpUrl(metadata.originalUrl)
      ? metadata.originalUrl
      : undefined;

  if (sourceUrl) {
    return importUrlBackedHtml(store, candidate, html, sourceUrl, metadata.title, options);
  }
  return importLocalHtml(store, candidate, html, metadata.title, metadata.author, options);
}

async function importUrlBackedHtml(
  store: KnowledgeStore | undefined,
  candidate: HtmlFileCandidate,
  html: string,
  sourceUrl: string,
  title: string | undefined,
  options: ImportOptions
): Promise<ReportItem> {
  const normalizedUrl = normalizeUrlForKnowledge(sourceUrl);
  const identityHash = urlHash(normalizedUrl);
  const itemId = `url:sha256:${identityHash}`;
  if (options.dryRun) {
    return {
      type: "html_file",
      inputPath: candidate.filePath,
      state: "candidate",
      itemId,
      identityHash,
      url: normalizedUrl
    };
  }
  if (!store) {
    throw new Error("Knowledge store is required for import");
  }
  if (options.skipExisting && (await store.status(normalizedUrl)).state === "parsed") {
    return {
      type: "html_file",
      inputPath: candidate.filePath,
      state: "skipped",
      itemId,
      identityHash,
      errorCode: "already_exists",
      errorMessage: "URL item already exists and is parsed"
    };
  }

  const resolved = resolvedHtmlInput({
    url: normalizedUrl,
    originalUrl: pathToFileURL(candidate.filePath).href,
    canonicalUrl: normalizedUrl,
    normalizedUrl,
    html,
    title
  });
  const parsed = await parsePage(resolved);
  parsed.rawdoc.metadata = {
    ...parsed.rawdoc.metadata,
    localHtmlPath: candidate.filePath,
    localImportSource: "html_directory",
    tags: options.tags
  };
  parsed.document.meta.tags = [...new Set([...(parsed.document.meta.tags ?? []), ...options.tags])];
  const markdown = documentToMarkdown(parsed.document);
  const paths = await store.save({
    normalizedUrl,
    html,
    rawdoc: parsed.rawdoc,
    document: parsed.document,
    markdown
  });
  return {
    type: "html_file",
    inputPath: candidate.filePath,
    state: "imported",
    itemId,
    identityHash,
    url: normalizedUrl,
    rawdocId: parsed.rawdoc.rawdoc_id,
    docId: parsed.document.doc_id,
    paths
  };
}

async function importLocalHtml(
  store: KnowledgeStore | undefined,
  candidate: HtmlFileCandidate,
  html: string,
  title: string | undefined,
  author: string | undefined,
  options: ImportOptions
): Promise<ReportItem> {
  const identityHash = sha256Text(html);
  const itemId = `singlefile_html:sha256:${identityHash}`;
  const fileUrl = pathToFileURL(candidate.filePath).href;
  if (options.dryRun) {
    return {
      type: "html_file",
      inputPath: candidate.filePath,
      state: "candidate",
      itemId,
      identityHash
    };
  }
  if (!store) {
    throw new Error("Knowledge store is required for import");
  }
  if (options.skipExisting && await isParsed(store, itemId)) {
    return {
      type: "html_file",
      inputPath: candidate.filePath,
      state: "skipped",
      itemId,
      identityHash,
      errorCode: "already_exists",
      errorMessage: "Local HTML item already exists and is parsed"
    };
  }

  const resolved = resolvedHtmlInput({
    url: fileUrl,
    originalUrl: fileUrl,
    normalizedUrl: fileUrl,
    html,
    title,
    meta: author ? { author } : {}
  });
  const parsed = await parsePage(resolved);
  parsed.rawdoc.metadata = {
    ...parsed.rawdoc.metadata,
    localHtmlPath: candidate.filePath,
    localImportSource: "html_directory",
    htmlHash: identityHash,
    tags: options.tags
  };
  parsed.document.meta.tags = [...new Set([...(parsed.document.meta.tags ?? []), ...options.tags])];
  const markdown = documentToMarkdown(parsed.document);
  const paths = await store.saveImportItem({
    itemId,
    identityHash,
    rawContent: Buffer.from(html, "utf8"),
    rawdoc: parsed.rawdoc,
    document: parsed.document,
    markdown,
    contentExt: "html"
  });
  return {
    type: "html_file",
    inputPath: candidate.filePath,
    state: "imported",
    itemId,
    identityHash,
    rawdocId: parsed.rawdoc.rawdoc_id,
    docId: parsed.document.doc_id,
    paths
  };
}

function resolvedHtmlInput(params: {
  url: string;
  originalUrl: string;
  canonicalUrl?: string;
  normalizedUrl: string;
  html: string;
  title?: string;
  meta?: Record<string, string>;
}): ResolvedInput {
  return {
    inputMode: "browser_html",
    url: params.url,
    originalUrl: params.originalUrl,
    canonicalUrl: params.canonicalUrl,
    normalizedUrl: params.normalizedUrl,
    html: params.html,
    pageTitle: params.title,
    title: params.title,
    meta: params.meta ?? {},
    capturedAt: nowIso()
  };
}

async function isParsed(store: KnowledgeStore, itemId: string): Promise<boolean> {
  const item = await store.loadItem(itemId).catch(() => undefined);
  return item?.state === "parsed";
}
