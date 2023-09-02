import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ImportOptions, ImportReport, ReportItem, SourceScan } from "./types.js";

export function createReport(options: ImportOptions, scan: SourceScan): ImportReport {
  return {
    source: {
      type: options.sourceType,
      root: options.root,
      file: options.file
    },
    options: {
      dryRun: options.dryRun,
      skipExisting: options.skipExisting,
      concurrency: options.concurrency,
      tags: options.tags
    },
    startedAt: new Date().toISOString(),
    summary: {
      scanned: scan.scanned,
      candidates: scan.candidates.length,
      imported: 0,
      skipped: scan.skipped.length,
      failed: 0
    },
    items: scan.skipped
  };
}

export function addReportItem(report: ImportReport, item: ReportItem): void {
  report.items.push(item);
  if (item.state === "imported") {
    report.summary.imported += 1;
  } else if (item.state === "skipped") {
    report.summary.skipped += 1;
  } else if (item.state === "failed") {
    report.summary.failed += 1;
  }
}

export async function writeReport(report: ImportReport, reportDir: string): Promise<string> {
  report.finishedAt = new Date().toISOString();
  await mkdir(reportDir, { recursive: true });
  const timestamp = report.startedAt.replace(/[:.]/g, "-");
  const path = join(reportDir, `${timestamp}.${report.source.type}.json`);
  await writeFile(path, JSON.stringify(report, null, 2) + "\n", "utf8");
  return path;
}

export function printSummary(report: ImportReport, path: string): void {
  const summary = report.summary;
  console.log([
    `Local import ${report.source.type} complete`,
    `  scanned: ${summary.scanned}`,
    `  candidates: ${summary.candidates}`,
    `  imported: ${summary.imported}`,
    `  skipped: ${summary.skipped}`,
    `  failed: ${summary.failed}`,
    `  report: ${path}`
  ].join("\n"));
}
