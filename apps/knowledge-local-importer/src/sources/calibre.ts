import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { CalibreBookCandidate, SourceScan } from "../types.js";

const COVER_PATTERN = /^cover\.(jpe?g|png|webp)$/i;
const IMAGE_PATTERN = /\.(jpe?g|png|webp)$/i;

export async function scanCalibre(root: string): Promise<SourceScan> {
  const candidates: CalibreBookCandidate[] = [];
  const skipped: SourceScan["skipped"] = [];
  let scanned = 0;

  async function visit(directoryPath: string): Promise<void> {
    scanned += 1;
    const entries = await readdir(directoryPath, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile());
    const epubPaths = files
      .filter((entry) => entry.name.toLowerCase().endsWith(".epub"))
      .map((entry) => join(directoryPath, entry.name));
    const opf = files.find((entry) => entry.name.toLowerCase() === "metadata.opf");
    const cover = files.find((entry) => COVER_PATTERN.test(entry.name)) ??
      files.find((entry) => IMAGE_PATTERN.test(entry.name));
    const tocJson = files.find((entry) => entry.name.toLowerCase() === "toc.json");

    if (epubPaths.length > 0 && opf) {
      candidates.push({
        type: "calibre_book",
        directoryPath,
        epubPaths,
        opfPath: join(directoryPath, opf.name),
        coverPath: cover ? join(directoryPath, cover.name) : undefined,
        tocPath: tocJson ? join(directoryPath, tocJson.name) : undefined
      });
      return;
    }

    if (epubPaths.length > 0 || opf) {
      skipped.push({
        type: "calibre_book",
        inputPath: directoryPath,
        state: "skipped",
        errorCode: epubPaths.length > 0 ? "missing_opf" : "missing_epub",
        errorMessage: epubPaths.length > 0
          ? "Directory contains EPUB files but no metadata.opf"
          : "Directory contains metadata.opf but no EPUB file"
      });
    }

    await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => visit(join(directoryPath, entry.name))));
  }

  await visit(root);
  return { scanned, candidates, skipped };
}
