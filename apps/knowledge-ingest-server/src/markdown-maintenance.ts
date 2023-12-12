import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { KnowledgeDocument } from "@uknowledge/knowledge-schema";
import { documentToMarkdown } from "./markdown.js";

export type MarkdownMaintenanceStatus =
  | "clean"
  | "rewritable"
  | "created"
  | "missing_document"
  | "missing_markdown"
  | "failed";

export interface MarkdownMaintenanceEntry {
  docId: string;
  status: MarkdownMaintenanceStatus;
  error?: string;
}

export interface MarkdownMaintenanceReport {
  storeRoot: string;
  write: boolean;
  documents: number;
  markdownFiles: number;
  clean: number;
  skipped: number;
  rewritable: number;
  rewritten: number;
  missingDocument: number;
  missingMarkdown: number;
  failed: number;
  entries: MarkdownMaintenanceEntry[];
}

export async function rewriteMarkdownDerivatives(
  storeRoot: string,
  options: { write?: boolean } = {}
): Promise<MarkdownMaintenanceReport> {
  const write = options.write === true;
  const documentsDir = join(storeRoot, "documents");
  const markdownDir = join(storeRoot, "markdown");
  const documentIds = await listIds(documentsDir, ".json");
  const markdownIds = await listIds(markdownDir, ".md");
  const allIds = [...new Set([...documentIds, ...markdownIds])].sort();
  const entries: MarkdownMaintenanceEntry[] = [];
  let clean = 0;
  let skipped = 0;
  let rewritable = 0;
  let rewritten = 0;
  let missingDocument = 0;
  let missingMarkdown = 0;
  let failed = 0;

  for (const docId of allIds) {
    const documentPath = join(documentsDir, `${docId}.json`);
    const markdownPath = join(markdownDir, `${docId}.md`);
    const hasDocument = documentIds.includes(docId);
    const hasMarkdown = markdownIds.includes(docId);

    if (!hasDocument) {
      missingDocument += 1;
      entries.push({ docId, status: "missing_document" });
      continue;
    }
    if (!hasMarkdown && !write) {
      missingMarkdown += 1;
      entries.push({ docId, status: "missing_markdown" });
      continue;
    }

    try {
      const document = JSON.parse(await readFile(documentPath, "utf8")) as KnowledgeDocument;
      const expectedMarkdown = documentToMarkdown(document);
      const currentMarkdown = hasMarkdown ? await readFile(markdownPath, "utf8") : undefined;

      if (currentMarkdown === expectedMarkdown) {
        clean += 1;
        skipped += 1;
        entries.push({ docId, status: "clean" });
        continue;
      }

      rewritable += 1;
      if (write) {
        await writeFile(markdownPath, expectedMarkdown, "utf8");
        rewritten += 1;
        entries.push({ docId, status: hasMarkdown ? "rewritable" : "created" });
      } else {
        entries.push({ docId, status: hasMarkdown ? "rewritable" : "missing_markdown" });
      }
    } catch (error) {
      failed += 1;
      entries.push({
        docId,
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  if (write) {
    missingMarkdown = allIds.filter((docId) => entries.find((entry) => entry.docId === docId)?.status === "missing_markdown").length;
  }

  return {
    storeRoot,
    write,
    documents: documentIds.length,
    markdownFiles: markdownIds.length,
    clean,
    skipped,
    rewritable,
    rewritten,
    missingDocument,
    missingMarkdown,
    failed,
    entries
  };
}

async function listIds(directory: string, extension: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingPath(error)) return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => entry.name.slice(0, -extension.length));
}

function isMissingPath(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
