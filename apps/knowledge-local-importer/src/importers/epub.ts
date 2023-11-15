import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  documentToMarkdown,
  KnowledgeStore,
  parseEpub
} from "@uknowledge/knowledge-ingest-server/local-import-api.js";
import { CalibreBookCandidate, ImportOptions, ReportItem } from "../types.js";
import { sha256Buffer } from "../hash.js";

export async function importCalibreBook(
  store: KnowledgeStore | undefined,
  candidate: CalibreBookCandidate,
  options: ImportOptions
): Promise<ReportItem> {
  if (candidate.epubPaths.length !== 1) {
    return {
      type: "calibre_book",
      inputPath: candidate.directoryPath,
      state: "failed",
      errorCode: "multiple_epub_files",
      errorMessage: `Expected one EPUB file, found ${candidate.epubPaths.length}`
    };
  }

  const epubPath = candidate.epubPaths[0];
  const epubBytes = await readFile(epubPath);
  const identityHash = sha256Buffer(epubBytes);
  const itemId = `epub:sha256:${identityHash}`;
  if (options.dryRun) {
    return {
      type: "calibre_book",
      inputPath: candidate.directoryPath,
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
      type: "calibre_book",
      inputPath: candidate.directoryPath,
      state: "skipped",
      itemId,
      identityHash,
      errorCode: "already_exists",
      errorMessage: "Knowledge item already exists and is parsed"
    };
  }

  const metadataOpf = await readFile(candidate.opfPath);
  const cover = candidate.coverPath
    ? { bytes: await readFile(candidate.coverPath), filename: candidate.coverPath.split(/[\\/]/).pop() }
    : undefined;
  const parsed = await parseEpub(epubBytes, {
    sourceUri: pathToFileURL(epubPath).href,
    tags: options.tags,
    metadataOpf,
    cover
  });

  try {
    const document = await store.prepareDocumentAssets(parsed.document);
    const markdown = documentToMarkdown(document);
    const result = await store.saveImportItem({
      itemId: parsed.itemId,
      sourceType: "epub",
      sourceUri: epubBytes ? String(epubBytes) : "epub-import",
      rawdocId: parsed.rawdoc.rawdoc_id,
      rawContentPath: epubBytes,
      document,
      markdown,
      pageTitle: parsed.rawdoc.metadata?.pageTitle as string | undefined,
      identityHash: parsed.identityHash,
      content: epubBytes,
      contentExt: "epub"
    });
    return {
      type: "calibre_book",
      inputPath: candidate.directoryPath,
      state: "imported",
      itemId: parsed.itemId,
      identityHash: parsed.identityHash,
      rawdocId: parsed.rawdoc.rawdoc_id,
      docId: document.doc_id,
      paths: result.paths
    };
  } finally {
    await parsed.cleanup();
  }
}

async function isParsed(store: KnowledgeStore, itemId: string): Promise<boolean> {
  const item = await store.loadItem(itemId).catch(() => undefined);
  return item?.state === "parsed";
}
