import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanCalibre } from "./sources/calibre.js";
import { scanHtmlDirectory } from "./sources/html-directory.js";
import { scanUrlList } from "./sources/url-list.js";

describe("local importer source scanners", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "knowledge-local-importer-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("recursively finds Calibre directories with EPUB and metadata.opf", async () => {
    const library = join(root, "library");
    const book = join(library, "魔鬼家书 (883)");
    const missingOpf = join(library, "Missing Opf");
    const missingEpub = join(library, "Missing Epub");
    await mkdir(book, { recursive: true });
    await mkdir(missingOpf, { recursive: true });
    await mkdir(missingEpub, { recursive: true });
    await writeFile(join(book, "metadata.opf"), "<package />");
    await writeFile(join(book, "folder-image.png"), "cover");
    await writeFile(join(book, "book.epub"), "epub");
    await writeFile(join(missingOpf, "book.epub"), "epub");
    await writeFile(join(missingEpub, "metadata.opf"), "<package />");

    const scan = await scanCalibre(library);

    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0]).toMatchObject({
      type: "calibre_book",
      directoryPath: book,
      opfPath: join(book, "metadata.opf"),
      coverPath: join(book, "folder-image.png")
    });
    expect(scan.candidates[0].epubPaths).toEqual([join(book, "book.epub")]);
    expect(scan.skipped.map((item) => item.errorCode).sort()).toEqual(["missing_epub", "missing_opf"]);
  });

  it("surfaces unreadable Calibre roots instead of returning an empty scan", async () => {
    await expect(scanCalibre(join(root, "missing"))).rejects.toThrow();
  });

  it("finds HTML files and ignores hidden/build directories", async () => {
    await mkdir(join(root, "docs", "nested"), { recursive: true });
    await mkdir(join(root, ".cache"), { recursive: true });
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "index.html"), "<html></html>");
    await writeFile(join(root, "docs", "nested", "page.htm"), "<html></html>");
    await writeFile(join(root, ".cache", "ignored.html"), "<html></html>");
    await writeFile(join(root, "dist", "ignored.html"), "<html></html>");

    const scan = await scanHtmlDirectory(root);

    expect(scan.candidates.map((item) => item.filePath).sort()).toEqual([
      join(root, "docs", "nested", "page.htm"),
      join(root, "index.html")
    ].sort());
  });

  it("parses URL txt files with comments and dedupe", async () => {
    const file = join(root, "urls.txt");
    await writeFile(file, [
      "https://example.com/a",
      "",
      "# comment",
      "https://example.com/a",
      "https://example.com/b"
    ].join("\n"));

    const scan = await scanUrlList(file);

    expect(scan.scanned).toBe(3);
    expect(scan.candidates).toEqual([
      { type: "url", url: "https://example.com/a" },
      { type: "url", url: "https://example.com/b" }
    ]);
  });
});
