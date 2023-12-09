import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, extname } from "node:path";
import AdmZip from "adm-zip";

interface TocEntry {
  level: number;
  title: string;
  src: string;
}

function parseNcx(xml: string): TocEntry[] {
  const entries: TocEntry[] = [];
  const tagRegex = /<\/?navPoint[^>]*>|<text>([^<]*)<\/text>|<content[^>]*src="([^"]*)"/gi;
  const stack: Array<{ text?: string; src?: string }> = [];
  let depth = 0;

  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(xml)) !== null) {
    if (match[0].startsWith("</navPoint")) {
      const pending = stack.pop();
      if (pending?.text) {
        entries.push({ level: depth, title: pending.text, src: pending.src ?? "" });
      }
      depth--;
    } else if (match[0].startsWith("<navPoint")) {
      depth++;
      stack.push({});
    } else if (match[1] !== undefined) {
      const top = stack[depth - 1];
      if (top) top.text = match[1].trim();
    } else if (match[2] !== undefined) {
      const top = stack[depth - 1];
      if (top) top.src = match[2];
    }
  }

  return entries;
}

async function extractToc(epubPath: string): Promise<TocEntry[]> {
  const zip = new AdmZip(epubPath);
  const entries = zip.getEntries();

  for (const entry of entries) {
    if (entry.entryName.toLowerCase().endsWith(".ncx") && !entry.isDirectory) {
      const xml = entry.getData().toString("utf8");
      const toc = parseNcx(xml);
      if (toc.length > 0) return toc;
    }
  }

  return [];
}

async function main() {
  const storeRoot = process.argv[2];
  if (!storeRoot) {
    console.error("Usage: tsx index.ts <store-root>");
    process.exit(1);
  }

  const rawdocsDir = join(storeRoot, "rawdocs");
  let files: string[];
  try {
    files = await readdir(rawdocsDir);
  } catch {
    console.error(`Directory not found: ${rawdocsDir}`);
    process.exit(1);
  }

  const epubFiles = files.filter((f) => f.toLowerCase().endsWith(".epub"));
  if (epubFiles.length === 0) {
    console.log("No EPUB files found in", rawdocsDir);
    process.exit(0);
  }

  console.log(`Found ${epubFiles.length} EPUB file(s) in ${rawdocsDir}\n`);

  for (const epubFile of epubFiles) {
    const epubPath = join(rawdocsDir, epubFile);
    const baseName = epubFile.slice(0, -extname(epubFile).length);
    const tocPath = join(rawdocsDir, `${baseName}.toc.json`);

    try {
      const toc = await extractToc(epubPath);
      if (toc.length > 0) {
        await writeFile(tocPath, JSON.stringify(toc, null, 2), "utf8");
        console.log(`OK  ${epubFile} → ${toc.length} entries`);
      } else {
        console.log(`SKIP ${epubFile} (no TOC found)`);
      }
    } catch (err) {
      console.error(`ERR ${epubFile}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
