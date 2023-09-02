import {
  KnowledgeStore,
  loadConfig,
  type ServerConfig
} from "@uknowledge/knowledge-ingest-server/local-import-api.js";
import { importCalibreBook } from "./importers/epub.js";
import { importHtmlFile } from "./importers/html.js";
import { importUrl } from "./importers/url.js";
import { createReport, addReportItem, printSummary, writeReport } from "./report.js";
import { scanCalibre } from "./sources/calibre.js";
import { scanHtmlDirectory } from "./sources/html-directory.js";
import { scanUrlList } from "./sources/url-list.js";
import { ImportCandidate, ImportOptions, ReportItem, SourceScan } from "./types.js";

export async function runImport(options: ImportOptions): Promise<string> {
  const config = { ...loadConfig(), storeRoot: options.storeRoot };
  const scan = await scanSource(options);
  const report = createReport(options, scan);
  if (options.dryRun) {
    await runCandidates(scan.candidates, options, config, async (candidate) => {
      const item = await runCandidate(undefined, candidate, options, config).catch((error) =>
        failedItem(candidate, error)
      );
      addReportItem(report, item);
    });
    const reportPath = await writeReport(report, options.reportDir);
    printSummary(report, reportPath);
    return reportPath;
  }

  const store = new KnowledgeStore(options.storeRoot);
  await store.ensure();

  try {
    await runCandidates(scan.candidates, options, config, async (candidate) => {
      const item = await runCandidate(store, candidate, options, config).catch((error) =>
        failedItem(candidate, error)
      );
      addReportItem(report, item);
    });
  } finally {
    store.close();
  }

  const reportPath = await writeReport(report, options.reportDir);
  printSummary(report, reportPath);
  return reportPath;
}

async function scanSource(options: ImportOptions): Promise<SourceScan> {
  if (options.sourceType === "calibre") {
    return scanCalibre(options.root!);
  }
  if (options.sourceType === "html") {
    return scanHtmlDirectory(options.root!);
  }
  const urls = await scanUrlList(options.file!);
  return {
    scanned: urls.scanned,
    candidates: urls.candidates,
    skipped: []
  };
}

async function runCandidates(
  candidates: ImportCandidate[],
  options: ImportOptions,
  _config: ServerConfig,
  onItem: (candidate: ImportCandidate) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const workerCount = Math.min(options.concurrency, Math.max(candidates.length, 1));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < candidates.length) {
      const candidate = candidates[cursor];
      cursor += 1;
      await onItem(candidate);
    }
  }));
}

async function runCandidate(
  store: KnowledgeStore | undefined,
  candidate: ImportCandidate,
  options: ImportOptions,
  config: ServerConfig
): Promise<ReportItem> {
  switch (candidate.type) {
    case "calibre_book":
      return importCalibreBook(store, candidate, options);
    case "html_file":
      return importHtmlFile(store, candidate, options);
    case "url":
      return importUrl(store, candidate, options, config);
  }
}

function failedItem(candidate: ImportCandidate, error: unknown): ReportItem {
  return {
    type: candidate.type,
    inputPath: candidate.type === "calibre_book"
      ? candidate.directoryPath
      : candidate.type === "html_file"
        ? candidate.filePath
        : undefined,
    url: candidate.type === "url" ? candidate.url : undefined,
    state: "failed",
    errorCode: errorCode(error),
    errorMessage: error instanceof Error ? error.message : String(error)
  };
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("fetch")) {
    return "fetch_failed";
  }
  if (message.includes("parse_failed") || message.includes("pandoc")) {
    return "parse_failed";
  }
  if (message.includes("SQLITE") || message.includes("Path escapes")) {
    return "save_failed";
  }
  return "import_failed";
}
