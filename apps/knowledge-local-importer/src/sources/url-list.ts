import { readFile } from "node:fs/promises";
import { UrlCandidate } from "../types.js";

export async function scanUrlList(file: string): Promise<{ scanned: number; candidates: UrlCandidate[] }> {
  const text = await readFile(file, "utf8");
  const seen = new Set<string>();
  const candidates: UrlCandidate[] = [];
  let scanned = 0;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    scanned += 1;
    if (seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    candidates.push({ type: "url", url: trimmed });
  }

  return { scanned, candidates };
}
