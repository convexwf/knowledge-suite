import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { HtmlFileCandidate, SourceScan } from "../types.js";

const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build"]);

export async function scanHtmlDirectory(root: string): Promise<SourceScan> {
  const candidates: HtmlFileCandidate[] = [];
  let scanned = 0;

  async function visit(directoryPath: string): Promise<void> {
    scanned += 1;
    const entries = await readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || IGNORED_DIRECTORIES.has(entry.name)) {
          continue;
        }
        await visit(path);
      } else if (entry.isFile() && isHtmlFile(entry.name)) {
        candidates.push({ type: "html_file", filePath: path });
      }
    }
  }

  await visit(root);
  return { scanned, candidates, skipped: [] };
}

function isHtmlFile(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized.endsWith(".html") || normalized.endsWith(".htm");
}
