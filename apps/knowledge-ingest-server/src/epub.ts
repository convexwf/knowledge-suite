import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, posix } from "node:path";
import { promisify } from "node:util";
import { DOMParser } from "linkedom";
import {
  assignDeterministicSectionIds,
  deterministicSectionId,
  DocumentSection,
  KnowledgeDocument,
  makeId,
  nowIso,
  RawDoc
} from "@uknowledge/knowledge-schema";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const AdmZip = require("adm-zip") as new (input: Buffer) => {
  getEntries(): Array<{ entryName: string; isDirectory: boolean; getData(): Buffer }>;
  getEntry(entryName: string): { getData(): Buffer } | null;
};
const PARSER_VERSION = "knowledge-ingest-server/epub-0.2:pandoc_epub";

export interface ParsedEpub {
  itemId: string;
  identityHash: string;
  rawdoc: RawDoc;
  document: KnowledgeDocument;
  epubMetadata: EpubMetadataSupplement;
  cleanup: () => Promise<void>;
}

export interface CalibreMetadata {
  id?: string;
  uuid?: string;
  isbn?: string;
  douban?: string;
  title?: string;
  titleSort?: string;
  creators: string[];
  publisher?: string;
  publishedAt?: string;
  language?: string;
  subjects: string[];
  description?: string;
  pages?: number;
  wordCount?: number;
  userMetadata?: Record<string, unknown>;
}

export interface EpubMetadataSupplement {
  isbn?: string;
  publisher?: string;
  publishedAt?: string;
  identifiers?: Record<string, string>;
  coverAssetId?: string;
  chapterCount?: number;
  metadata?: Record<string, unknown>;
}

export interface TocEntry {
  level: number;
  title: string;
  src?: string;
}

export interface ParseEpubOptions {
  rawdocId?: string;
  docId?: string;
  sourceUri?: string;
  titleHint?: string;
  tags?: string[];
  metadataOpf?: Buffer | string;
  calibreMetadata?: CalibreMetadata;
  cover?: {
    bytes: Buffer;
    filename?: string;
  };
  pandocRunner?: PandocRunner;
  toc?: TocEntry[];
}

export type PandocRunner = (params: {
  inputPath: string;
  outputPath: string;
  mediaDir: string;
  logPath: string;
}) => Promise<{ version?: string; warnings?: string[] }>;

export async function parseEpub(bytes: Buffer, options: ParseEpubOptions = {}): Promise<ParsedEpub> {
  if (bytes.length === 0) {
    throw new Error("unsupported_file_type: EPUB file is empty");
  }

  const identityHash = sha256(bytes);
  const rawdocId = options.rawdocId ?? makeId();
  const docId = options.docId ?? makeId();
  const itemId = `epub:sha256:${identityHash}`;
  const fetchTime = nowIso();
  const tempDir = await mkdtemp(join(tmpdir(), "knowledge-epub-"));
  try {
  const calibre = options.metadataOpf ? parseCalibreMetadata(options.metadataOpf) : options.calibreMetadata;

  const inputPath = join(tempDir, "book.epub");
  const outputPath = join(tempDir, "book.json");
  const mediaDir = join(tempDir, "media");
  const logPath = join(tempDir, "pandoc.log.json");
  await writeFile(inputPath, bytes);

  const runner = options.pandocRunner ?? runPandoc;
  const run = await runner({ inputPath, outputPath, mediaDir, logPath });
  const ast = JSON.parse(await readFile(outputPath, "utf8")) as PandocDocument;
  const title = firstNonEmpty(
    options.titleHint,
    calibre?.title,
    metaString(ast.meta?.title),
    "Untitled EPUB"
  );
  const authors = firstNonEmptyList(calibre?.creators, metaStringList(ast.meta?.author));
  const language = normalizeLanguage(firstNonEmpty(calibre?.language, metaString(ast.meta?.lang), metaString(ast.meta?.language)));
  const tags = unique([...(options.tags ?? []), ...(calibre?.subjects ?? [])]);
  let sections = pandocBlocksToSections(ast.blocks ?? [], tempDir);
  const embeddedToc = extractEpubToc(bytes);
  const toc = embeddedToc.length > 0 ? embeddedToc : normalizeTocEntries(options.toc ?? []);
  if (toc.length > 0) applyTocEntries(sections, toc, title);
  sections = withoutLeadingTitleHeading(sections, title);
  if (options.cover?.bytes.length) {
    const coverPath = join(tempDir, `calibre-cover.${sanitizeExtension(extname(options.cover.filename ?? "")) || "jpg"}`);
    await writeFile(coverPath, options.cover.bytes);
    sections.unshift({
      section_id: "cover",
      type: "figure",
      assets: [{ path: coverPath, caption: "Cover" }]
    });
  }

  const rawdoc: RawDoc = {
    rawdoc_id: rawdocId,
    source_type: "epub",
    source_uri: options.sourceUri ?? itemId,
    fetch_time: fetchTime,
    content_type: "application/epub+zip",
    content_length: bytes.byteLength,
    metadata: {
      title,
      parserMethod: "pandoc_epub",
      parserProfile: "epub",
      parserBackend: "pandoc",
      pandocVersion: run.version,
      pandocWarnings: run.warnings ?? [],
      blockCount: ast.blocks?.length ?? 0,
      headingCount: sections.filter((section) => section.type === "heading").length,
      tocCount: toc.length,
      tocSource: embeddedToc.length > 0 ? "epub_navigation" : options.toc?.length ? "toc_sidecar" : undefined,
      tags,
      importMode: calibre ? "calibre_directory" : "epub_file",
      epubHash: identityHash,
      metadataOpfHash: options.metadataOpf ? sha256(toBuffer(options.metadataOpf)) : undefined,
      externalCoverHash: options.cover?.bytes ? sha256(options.cover.bytes) : undefined,
      calibre,
      identifiers: identifiersFor(calibre),
      book: bookMetadataFor(calibre)
    }
  };

  const document: KnowledgeDocument = {
    doc_id: docId,
    meta: {
      title,
      source: {
        type: "epub",
        url: options.sourceUri ?? itemId,
        rawdoc_id: rawdocId
      },
      authors,
      ingested_at: fetchTime,
      language,
      tags,
      published_at: calibre?.publishedAt,
      parser_version: PARSER_VERSION
    },
    sections: sections.length > 0
      ? sections
      : [{ section_id: makeId(), type: "paragraph", content: title }]
  };

  return {
    itemId,
    identityHash,
    rawdoc,
    document,
    epubMetadata: epubMetadataFor(calibre, sections),
    cleanup: () => rm(tempDir, { recursive: true, force: true })
  };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

export function pandocBlocksToSections(blocks: PandocBlock[], imageBaseDir?: string): DocumentSection[] {
  const sections = pandocBlocksToSectionsWithoutIds(blocks, imageBaseDir);
  const withIds = sections.map((section) => ({
    ...section,
    section_id: section.section_id ?? deterministicSectionId(section)
  }));
  assignDeterministicSectionIds(withIds);
  return withIds;
}

function withoutLeadingTitleHeading(
  sections: DocumentSection[],
  title: string,
): DocumentSection[] {
  const normalizedTitle = normalizeEpubTitle(title);
  if (!normalizedTitle) return sections;

  const firstHeading = sections.find((section) => section.type === "heading" && section.content?.trim());
  if (!firstHeading || normalizeEpubTitle(firstHeading.content ?? "") !== normalizedTitle) {
    return sections;
  }
  return sections.filter((section) => section !== firstHeading);
}

function normalizeEpubTitle(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function pandocBlocksToSectionsWithoutIds(blocks: PandocBlock[], imageBaseDir?: string): DocumentSection[] {
  const sections: DocumentSection[] = [];
  for (const block of blocks) {
    sections.push(...pandocBlockToSections(block, imageBaseDir));
  }
  return sections;
}

async function runPandoc(params: {
  inputPath: string;
  outputPath: string;
  mediaDir: string;
  logPath: string;
}): Promise<{ version?: string; warnings?: string[] }> {
  let version: string | undefined;
  try {
    const versionResult = await execFileAsync("pandoc", ["--version"], { timeout: 3000 });
    version = versionResult.stdout.split(/\r?\n/)[0]?.trim();
  } catch {
    throw new Error("pandoc_missing: Pandoc is required to import EPUB files");
  }

  try {
    const result = await execFileAsync("pandoc", [
      params.inputPath,
      "-f",
      "epub",
      "-t",
      "json",
      `--extract-media=${params.mediaDir}`,
      `--log=${params.logPath}`,
      "-o",
      params.outputPath
    ], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
    return {
      version,
      warnings: stderrWarnings(result.stderr)
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`parse_failed: Pandoc EPUB import failed: ${message}`);
  }
}

function pandocBlockToSections(block: PandocBlock, imageBaseDir?: string): DocumentSection[] {
  switch (block.t) {
    case "Header": {
      const [level, , inlines] = block.c as [number, unknown, PandocInline[]];
      const content = inlineText(inlines);
      return content ? [{ type: "heading", level, content }] : [];
    }
    case "Para":
    case "Plain": {
      const inlines = block.c as PandocInline[];
      const sections: DocumentSection[] = [];
      const content = inlineText(inlines, { includeImageAlt: false });
      if (content) {
        sections.push({ type: "paragraph", content });
      }
      const assets = inlineImages(inlines, imageBaseDir);
      if (assets.length) {
        sections.push({ type: "figure", assets });
      }
      return sections;
    }
    case "BlockQuote": {
      const content = blocksText(block.c as PandocBlock[]);
      return content ? [{ type: "blockquote", content }] : [];
    }
    case "BulletList":
    case "OrderedList": {
      const items = listItems(block);
      return items.length ? [{ type: "list", items }] : [];
    }
    case "CodeBlock": {
      const [, content] = block.c as [unknown, string];
      return content ? [{ type: "code", content }] : [];
    }
    case "Table": {
      const rows = tableRows(block);
      if (rows.length) {
        return [{ type: "table", rows }];
      }
      const content = blocksText([block]);
      return content ? [{ type: "table", content }] : [];
    }
    case "Div": {
      const [, blocks] = block.c as [unknown, PandocBlock[]];
      return pandocBlocksToSectionsWithoutIds(blocks ?? [], imageBaseDir);
    }
    case "Figure": {
      const blocks = figureBlocks(block);
      const sections = pandocBlocksToSectionsWithoutIds(blocks, imageBaseDir);
      return sections.length ? sections : [];
    }
    case "LineBlock": {
      const lines = block.c as PandocInline[][];
      const content = lines.map((line) => inlineText(line)).filter(Boolean).join("\n");
      return content ? [{ type: "paragraph", content }] : [];
    }
    case "HorizontalRule":
    case "Null":
      return [];
    case "RawBlock": {
      const [, content] = block.c as [string, string];
      return content?.trim() ? [{ type: "paragraph", content: content.trim() }] : [];
    }
    default: {
      const content = blocksText([block]);
      return content ? [{ type: "paragraph", content }] : [];
    }
  }
}

function listItems(block: PandocBlock): string[] {
  const rawItems = block.t === "OrderedList"
    ? (block.c as [unknown, PandocBlock[][]])[1]
    : block.c as PandocBlock[][];
  return rawItems.map((item) => blocksText(item)).filter(Boolean);
}

function blocksText(blocks: PandocBlock[]): string {
  return blocks.map((block) => {
    switch (block.t) {
      case "Header":
        return inlineText((block.c as [number, unknown, PandocInline[]])[2]);
      case "Para":
      case "Plain":
        return inlineText(block.c as PandocInline[]);
      case "CodeBlock":
        return (block.c as [unknown, string])[1] ?? "";
      case "BulletList":
      case "OrderedList":
        return listItems(block).join("\n");
      case "BlockQuote":
        return blocksText(block.c as PandocBlock[]);
      case "Div":
        return blocksText(((block.c as [unknown, PandocBlock[]])?.[1]) ?? []);
      case "Figure":
        return blocksText(figureBlocks(block));
      case "LineBlock":
        return (block.c as PandocInline[][]).map((line) => inlineText(line)).filter(Boolean).join("\n");
      case "Table":
        return tableRows(block).map((row) => row.join(" ")).join("\n");
      default:
        return "";
    }
  }).join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

function inlineText(inlines: PandocInline[] | undefined, options: { includeImageAlt?: boolean } = {}): string {
  if (!inlines) {
    return "";
  }
  const includeImageAlt = options.includeImageAlt ?? true;
  return inlines.map((inline) => {
    switch (inline.t) {
      case "Str":
        return String(inline.c ?? "");
      case "Space":
      case "SoftBreak":
      case "LineBreak":
        return " ";
      case "Emph":
      case "Strong":
      case "Strikeout":
      case "Superscript":
      case "Subscript":
      case "SmallCaps":
        return inlineText(inline.c as PandocInline[], options);
      case "Code":
        return String((inline.c as [unknown, string])?.[1] ?? "");
      case "Span":
        return inlineText((inline.c as [unknown, PandocInline[]])?.[1], options);
      case "Link":
        return inlineText((inline.c as [unknown, PandocInline[], unknown])?.[1], options);
      case "Image":
        return includeImageAlt ? inlineText((inline.c as [unknown, PandocInline[], unknown])?.[1], options) : "";
      case "Quoted":
        return inlineText((inline.c as [unknown, PandocInline[]])?.[1], options);
      case "Math":
        return String((inline.c as [unknown, string])?.[1] ?? "");
      case "Note":
        return blocksText(inline.c as PandocBlock[]);
      default:
        return "";
    }
  }).join("").replace(/[ \t]+/g, " ").trim();
}

function inlineImages(inlines: PandocInline[], imageBaseDir?: string): Array<NonNullable<DocumentSection["assets"]>[number]> {
  const assets: Array<NonNullable<DocumentSection["assets"]>[number]> = [];
  for (const inline of inlines) {
    if (inline.t === "Image") {
      const [, altInlines, target] = inline.c as [unknown, PandocInline[], [string, string]];
      const [rawPath] = target;
      const path = rawPath && imageBaseDir && !isAbsolute(rawPath) ? join(imageBaseDir, rawPath) : rawPath;
      const alt = cleanImageAlt(inlineText(altInlines));
      assets.push({
        path,
        ...(alt ? { alt } : {})
      });
    } else if (Array.isArray(inline.c)) {
      assets.push(...inlineImages(nestedInlineChildren(inline), imageBaseDir));
    }
  }
  return assets;
}

function cleanImageAlt(value: string): string | undefined {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || /^fig(?:ure)?[_\s-]*\d+(?:[_\s-]+\d+)*$/i.test(text)) {
    return undefined;
  }
  return text;
}

function nestedInlineChildren(inline: PandocInline): PandocInline[] {
  switch (inline.t) {
    case "Emph":
    case "Strong":
    case "Strikeout":
    case "Superscript":
    case "Subscript":
    case "SmallCaps":
      return inline.c as PandocInline[];
    case "Span":
      return ((inline.c as [unknown, PandocInline[]])?.[1]) ?? [];
    case "Link":
      return ((inline.c as [unknown, PandocInline[], unknown])?.[1]) ?? [];
    case "Quoted":
      return ((inline.c as [unknown, PandocInline[]])?.[1]) ?? [];
    default:
      return [];
  }
}

function figureBlocks(block: PandocBlock): PandocBlock[] {
  const content = block.c as unknown[];
  const maybeBlocks = content.find((item): item is PandocBlock[] => Array.isArray(item) && item.every(isPandocBlock));
  return maybeBlocks ?? [];
}

function tableRows(block: PandocBlock): string[][] {
  const rows = structuredTableRows(block.c);
  if (rows.length) {
    return rows;
  }
  const fallbackRows = collectTableRows(block.c);
  return normalizeTableRows(fallbackRows);
}

function structuredTableRows(value: unknown): string[][] {
  if (!Array.isArray(value) || value.length < 6) {
    return [];
  }
  const [, , , head, bodies, foot] = value;
  return [
    ...tablePartRows(head),
    ...tableBodyRows(bodies),
    ...tablePartRows(foot)
  ].filter((row) => row.some(Boolean));
}

function tableBodyRows(value: unknown): string[][] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((body) => {
    if (!Array.isArray(body)) {
      return [];
    }
    const intermediateHead = body[2];
    const rows = body[3];
    return [
      ...tablePartRows(intermediateHead),
      ...tableRowGroupRows(rows)
    ];
  });
}

function tablePartRows(value: unknown): string[][] {
  if (!Array.isArray(value)) {
    return [];
  }
  return tableRowGroupRows(value[1]);
}

function tableRowGroupRows(value: unknown): string[][] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(tableRowCells).filter((row) => row.length > 0);
}

function tableRowCells(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const cells = Array.isArray(value[1]) ? value[1] : value;
  return cells.map(tableCellText).map((cell) => cell.trim());
}

function tableCellText(value: unknown): string {
  const blocks = pandocBlocksFromTableCell(value);
  return blocksText(blocks).replace(/\s+/g, " ").trim();
}

function pandocBlocksFromTableCell(value: unknown): PandocBlock[] {
  if (isPandocBlock(value)) {
    return [value];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  const directBlocks = value.find((item): item is PandocBlock[] => Array.isArray(item) && item.every(isPandocBlock));
  if (directBlocks) {
    return directBlocks;
  }
  return value.flatMap(pandocBlocksFromTableCell);
}

function normalizeTableRows(rows: PandocBlock[][][]): string[][] {
  return rows
    .map((row) => row.map((cell) => blocksText(cell)).filter((cell) => cell.length > 0))
    .filter((row) => row.length > 0);
}

function collectTableRows(value: unknown): PandocBlock[][][] {
  if (!Array.isArray(value)) {
    return [];
  }
  if (isTableRow(value)) {
    return [value];
  }
  return value.flatMap(collectTableRows);
}

function isTableRow(value: unknown[]): value is PandocBlock[][] {
  return value.length > 0 && value.every((cell) => Array.isArray(cell) && cell.every(isPandocBlock));
}

function isPandocBlock(value: unknown): value is PandocBlock {
  return Boolean(value && typeof value === "object" && typeof (value as PandocBlock).t === "string");
}

function metaString(value: PandocMetaValue | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value.t === "MetaString") {
    return String(value.c).trim() || undefined;
  }
  if (value.t === "MetaInlines") {
    return inlineText(value.c as PandocInline[]) || undefined;
  }
  if (value.t === "MetaBlocks") {
    return blocksText(value.c as PandocBlock[]) || undefined;
  }
  return undefined;
}

function metaStringList(value: PandocMetaValue | undefined): string[] {
  if (!value) {
    return [];
  }
  if (value.t === "MetaList") {
    return (value.c as PandocMetaValue[]).map(metaString).filter((item): item is string => Boolean(item));
  }
  const single = metaString(value);
  return single ? [single] : [];
}

export function parseCalibreMetadata(input: Buffer | string): CalibreMetadata {
  const xml = Buffer.isBuffer(input) ? input.toString("utf8") : input;
  const identifiers: Record<string, string> = {};
  for (const match of xml.matchAll(/<dc:identifier\b([^>]*)>([\s\S]*?)<\/dc:identifier>/gi)) {
    const attrs = match[1] ?? "";
    const scheme = attrValue(attrs, "opf:scheme")?.toLowerCase() ?? attrValue(attrs, "scheme")?.toLowerCase();
    const id = attrValue(attrs, "id")?.toLowerCase();
    const value = decodeXml(match[2] ?? "").trim();
    if (!value) {
      continue;
    }
    if (scheme === "calibre" || id === "calibre_id") {
      identifiers.calibre = value;
    } else if (scheme === "uuid" || id === "uuid_id") {
      identifiers.uuid = value;
    } else if (scheme === "isbn") {
      identifiers.isbn = value;
    } else if (scheme === "new_douban" || scheme === "douban") {
      identifiers.douban = value;
    }
  }

  const userMetadata: Record<string, unknown> = {};
  for (const match of xml.matchAll(/<meta\b([^>]*?)\/?>/gi)) {
    const attrs = match[1] ?? "";
    const name = attrValue(attrs, "name");
    const content = attrValue(attrs, "content");
    if (!name) {
      continue;
    }
    if (name === "calibre:title_sort" && content) {
      userMetadata.titleSort = decodeXml(content).trim();
    }
    if (name.startsWith("calibre:user_metadata:") && content) {
      const key = name.replace("calibre:user_metadata:", "");
      const decoded = decodeXml(content);
      try {
        userMetadata[key] = JSON.parse(decoded);
      } catch {
        userMetadata[key] = decoded;
      }
    }
  }

  return {
    id: identifiers.calibre,
    uuid: identifiers.uuid,
    isbn: identifiers.isbn,
    douban: identifiers.douban,
    title: first(extractDc(xml, "title")),
    titleSort: typeof userMetadata.titleSort === "string" ? userMetadata.titleSort : undefined,
    creators: extractDc(xml, "creator"),
    publisher: first(extractDc(xml, "publisher")),
    publishedAt: first(extractDc(xml, "date")),
    language: normalizeLanguage(first(extractDc(xml, "language"))),
    subjects: extractDc(xml, "subject"),
    description: stripHtml(first(extractDc(xml, "description")) ?? ""),
    pages: numberUserValue(userMetadata["#pages"]),
    wordCount: numberUserValue(userMetadata["#words"]),
    userMetadata
  };
}

function epubMetadataFor(calibre: CalibreMetadata | undefined, sections: DocumentSection[]): EpubMetadataSupplement {
  return {
    isbn: calibre?.isbn,
    publisher: calibre?.publisher,
    publishedAt: calibre?.publishedAt,
    identifiers: identifiersFor(calibre),
    chapterCount: sections.filter((section) => section.type === "heading").length,
    metadata: calibre ? {
      calibre,
      book: bookMetadataFor(calibre)
    } : {}
  };
}

function identifiersFor(calibre: CalibreMetadata | undefined): Record<string, string> | undefined {
  if (!calibre) {
    return undefined;
  }
  return Object.fromEntries(Object.entries({
    calibre: calibre.id,
    uuid: calibre.uuid,
    isbn: calibre.isbn,
    douban: calibre.douban
  }).filter(([, value]) => Boolean(value))) as Record<string, string>;
}

function bookMetadataFor(calibre: CalibreMetadata | undefined): Record<string, unknown> | undefined {
  if (!calibre) {
    return undefined;
  }
  return {
    publisher: calibre.publisher,
    publishedAt: calibre.publishedAt,
    description: calibre.description,
    pages: calibre.pages,
    wordCount: calibre.wordCount,
    titleSort: calibre.titleSort,
    subjects: calibre.subjects
  };
}

function firstNonEmptyList(...values: Array<string[] | undefined>): string[] {
  for (const value of values) {
    const filtered = (value ?? []).map((item) => item.trim()).filter(Boolean);
    if (filtered.length) {
      return filtered;
    }
  }
  return [];
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

function toBuffer(input: Buffer | string): Buffer {
  return Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
}

function extractDc(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<dc:${tag}\\b[^>]*>([\\s\\S]*?)<\\/dc:${tag}>`, "gi");
  return [...xml.matchAll(pattern)].map((match) => decodeXml(match[1] ?? "").trim()).filter(Boolean);
}

function first(values: string[]): string | undefined {
  return values.find((value) => value.trim());
}

function attrValue(attrs: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}=["']([^"']*)["']`, "i").exec(attrs);
  return match ? decodeXml(match[1]) : undefined;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

function stripHtml(value: string): string | undefined {
  const text = decodeXml(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text || undefined;
}

function numberUserValue(value: unknown): number | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = (value as { "#value#"?: unknown })["#value#"];
  return typeof raw === "number" ? raw : undefined;
}

function normalizeLanguage(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return {
    zho: "zh",
    chi: "zh",
    eng: "en",
    jpn: "ja",
    fre: "fr",
    fra: "fr",
    ger: "de",
    deu: "de"
  }[normalized] ?? normalized;
}

function sanitizeExtension(input: string): string {
  return input.replace(/^\./, "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function stderrWarnings(stderr: string): string[] {
  return stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function normalizeTocEntries(entries: TocEntry[]): TocEntry[] {
  return entries.flatMap((entry) => {
    if (!entry || typeof entry.title !== "string" || !entry.title.trim()) return [];
    const level = Number.isInteger(entry.level) ? Math.max(1, Math.min(entry.level, 5)) : 1;
    return [{ title: entry.title.replace(/\s+/g, " ").trim(), level, ...(entry.src ? { src: entry.src } : {}) }];
  });
}

function extractEpubToc(bytes: Buffer): TocEntry[] {
  try {
    const archive = new AdmZip(bytes);
    const entries = archive.getEntries().filter((entry) => !entry.isDirectory);
    const entriesByPath = new Map(entries.map((entry) => [normalizeArchivePath(entry.entryName).toLowerCase(), entry]));
    const readEntry = (path: string): string | undefined => {
      const entry = entriesByPath.get(normalizeArchivePath(path).toLowerCase());
      return entry?.getData().toString("utf8");
    };
    const container = readEntry("META-INF/container.xml");
    if (!container) return [];

    const containerDocument = parseXmlDocument(container);
    const rootfile = allXmlElements(containerDocument).find((element) => xmlTagName(element) === "rootfile");
    const packagePath = rootfile && xmlAttribute(rootfile, "full-path");
    if (!packagePath) return [];

    const packageDocument = parseXmlDocument(readEntry(packagePath) ?? "");
    const manifest = allXmlElements(packageDocument).filter((element) => xmlTagName(element) === "item");
    const navItem = manifest.find((element) => xmlAttribute(element, "properties")?.split(/\s+/).includes("nav"));
    if (navItem) {
      const navHref = xmlAttribute(navItem, "href");
      const navPath = navHref ? resolveEpubHref(packagePath, navHref) : undefined;
      const navMarkup = navPath ? readEntry(navPath) : undefined;
      if (navMarkup) {
        const toc = extractEpub3Navigation(navMarkup);
        if (toc.length > 0) return toc;
      }
    }

    const ncxItem = manifest.find((element) => xmlAttribute(element, "media-type")?.toLowerCase() === "application/x-dtbncx+xml");
    const ncxHref = ncxItem && xmlAttribute(ncxItem, "href");
    const fallbackNcx = entries.find((entry) => entry.entryName.toLowerCase().endsWith(".ncx"));
    const ncxPath = ncxHref ? resolveEpubHref(packagePath, ncxHref) : fallbackNcx?.entryName;
    const ncxMarkup = ncxPath ? readEntry(ncxPath) : undefined;
    return ncxMarkup ? extractNcxNavigation(ncxMarkup) : [];
  } catch {
    // Invalid or unsupported EPUB navigation must not prevent importing its content.
    return [];
  }
}

function extractEpub3Navigation(markup: string): TocEntry[] {
  const document = parseXmlDocument(markup);
  const navElements = allXmlElements(document).filter((element) => xmlTagName(element) === "nav");
  const nav = navElements.find((element) => {
    const epubType = xmlAttribute(element, "epub:type") ?? xmlAttribute(element, "type") ?? "";
    const role = xmlAttribute(element, "role") ?? "";
    return epubType.split(/\s+/).includes("toc") || role.split(/\s+/).includes("doc-toc");
  }) ?? navElements.find((element) =>
    !xmlAttribute(element, "epub:type") && !xmlAttribute(element, "type") && !xmlAttribute(element, "role")
  );
  if (!nav) return [];

  const rootList = directXmlChildren(nav).find((element) => xmlTagName(element) === "ol") ??
    allXmlElements(nav).find((element) => xmlTagName(element) === "ol");
  if (!rootList) return [];

  const toc: TocEntry[] = [];
  const walkList = (list: Element, level: number): void => {
    for (const listItem of directXmlChildren(list).filter((element) => xmlTagName(element) === "li")) {
      const children = directXmlChildren(listItem);
      const link = children.find((element) => xmlTagName(element) === "a") ??
        allXmlElements(listItem).find((element) => xmlTagName(element) === "a");
      if (link) {
        const title = normalizeXmlText(link.textContent ?? "");
        if (title) {
          const src = xmlAttribute(link, "href");
          toc.push({ title, level, ...(src ? { src } : {}) });
        }
      }
      for (const child of children.filter((element) => xmlTagName(element) === "ol")) {
        walkList(child, level + 1);
      }
    }
  };
  walkList(rootList, 1);
  return toc;
}

function extractNcxNavigation(markup: string): TocEntry[] {
  const document = parseXmlDocument(markup);
  const navMap = allXmlElements(document).find((element) => xmlTagName(element) === "navmap");
  if (!navMap) return [];

  const toc: TocEntry[] = [];
  const walkPoints = (parent: Element, level: number): void => {
    for (const point of directXmlChildren(parent).filter((element) => xmlTagName(element) === "navpoint")) {
      const children = directXmlChildren(point);
      const navLabel = children.find((element) => xmlTagName(element) === "navlabel");
      const label = navLabel && allXmlElements(navLabel).find((element) => xmlTagName(element) === "text");
      const content = children.find((element) => xmlTagName(element) === "content");
      const title = normalizeXmlText(label?.textContent ?? "");
      if (title) {
        const src = content && xmlAttribute(content, "src");
        toc.push({ title, level, ...(src ? { src } : {}) });
      }
      walkPoints(point, level + 1);
    }
  };
  walkPoints(navMap, 1);
  return toc;
}

function parseXmlDocument(markup: string): Document {
  return new DOMParser().parseFromString(markup, "text/xml") as unknown as Document;
}

function allXmlElements(parent: ParentNode): Element[] {
  return Array.from(parent.querySelectorAll("*"));
}

function directXmlChildren(parent: Element): Element[] {
  return Array.from(parent.children).filter((child): child is Element => child.nodeType === 1);
}

function xmlTagName(element: Element): string {
  return (element.localName || element.tagName.split(":").at(-1) || "").toLowerCase();
}

function xmlAttribute(element: Element, name: string): string | undefined {
  const exact = element.getAttribute(name);
  if (exact !== null) return exact;
  const wanted = name.toLowerCase();
  return Array.from(element.attributes).find((attribute) =>
    attribute.name.toLowerCase() === wanted || attribute.localName?.toLowerCase() === wanted.split(":").at(-1)
  )?.value;
}

function normalizeXmlText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeArchivePath(path: string): string {
  return posix.normalize(path.replace(/\\/g, "/")).replace(/^\.\//, "").replace(/^\/+/, "");
}

function resolveEpubHref(packagePath: string, href: string): string {
  const file = href.split(/[?#]/, 1)[0].replace(/\\/g, "/");
  let decoded = file;
  try {
    decoded = decodeURIComponent(file);
  } catch {
    // Keep the literal archive path when href encoding is malformed.
  }
  return normalizeArchivePath(posix.join(posix.dirname(normalizeArchivePath(packagePath)), decoded));
}

function applyTocEntries(sections: DocumentSection[], toc: TocEntry[], documentTitle: string): void {
  if (toc.length === 0) return;
  const listingSections = findTocListingSections(sections, toc);
  const documentTitleKey = normalizeOutlineText(documentTitle);
  const firstTocTitle = toc.find((entry) => normalizeOutlineText(entry.title))?.title;
  const tocLevelOffset = firstTocTitle && normalizeOutlineText(firstTocTitle) === documentTitleKey ? 0 : 1;
  let previousSectionIndex = -1;

  for (const entry of toc) {
    const titleKey = normalizeOutlineText(entry.title);
    if (!titleKey || titleKey === documentTitleKey) continue;
    const canMatch = (section: DocumentSection, index: number): boolean =>
      index > previousSectionIndex &&
      !listingSections.has(index) &&
      (section.type === "heading" || section.type === "paragraph") &&
      normalizeOutlineText(section.content ?? "") === titleKey;
    const headingIndex = sections.findIndex((section, index) => section.type === "heading" && canMatch(section, index));
    const sectionIndex = headingIndex >= 0
      ? headingIndex
      : sections.findIndex((section, index) => section.type === "paragraph" && canMatch(section, index));
    if (sectionIndex < 0) continue;

    const heading = sections[sectionIndex];
    heading.type = "heading";
    heading.level = Math.max(2, Math.min(entry.level + tocLevelOffset, 6));
    previousSectionIndex = sectionIndex;
  }
}

function findTocListingSections(sections: DocumentSection[], toc: TocEntry[]): Set<number> {
  const titleKeys = new Set(toc.map((entry) => normalizeOutlineText(entry.title)).filter(Boolean));
  const excluded = new Set<number>();
  const markers = new Set(["目录", "目次", "目錄", "contents", "tableofcontents", "toc"]);
  const markerIndices = sections.flatMap((section, index) =>
    markers.has(normalizeOutlineText(section.content ?? "")) ? [index] : []
  );

  for (const markerIndex of markerIndices) {
    const matches: number[] = [];
    let misses = 0;
    const scanLimit = Math.min(sections.length, markerIndex + Math.max(toc.length * 2, 32));
    for (let index = markerIndex + 1; index < scanLimit; index += 1) {
      if (sections[index].type === "paragraph" && titleKeys.has(normalizeOutlineText(sections[index].content ?? ""))) {
        matches.push(index);
        misses = 0;
      } else if (matches.length > 0) {
        misses += 1;
        if (misses > 2) break;
      } else if (index - markerIndex > 8) {
        break;
      }
    }
    if (matches.length >= 3) matches.forEach((index) => excluded.add(index));
  }

  const tocPositions = new Map<string, number[]>();
  toc.forEach((entry, index) => {
    const key = normalizeOutlineText(entry.title);
    if (!key) return;
    const positions = tocPositions.get(key) ?? [];
    positions.push(index);
    tocPositions.set(key, positions);
  });

  let cluster: number[] = [];
  let previousSectionIndex = -1;
  let previousTocIndex = -1;
  const saveCluster = (): void => {
    if (cluster.length >= 3) cluster.forEach((index) => excluded.add(index));
    cluster = [];
    previousSectionIndex = -1;
    previousTocIndex = -1;
  };
  for (const [sectionIndex, section] of sections.entries()) {
    if (section.type !== "paragraph") {
      if (cluster.length > 0 && sectionIndex - previousSectionIndex > 2) saveCluster();
      continue;
    }
    const key = normalizeOutlineText(section.content ?? "");
    const positions = tocPositions.get(key);
    if (!positions) {
      if (cluster.length > 0 && sectionIndex - previousSectionIndex > 2) saveCluster();
      continue;
    }
    const tocIndex = positions.find((position) => position > previousTocIndex);
    if (cluster.length > 0 && sectionIndex - previousSectionIndex <= 3 && tocIndex !== undefined) {
      cluster.push(sectionIndex);
      previousSectionIndex = sectionIndex;
      previousTocIndex = tocIndex;
    } else {
      saveCluster();
      const firstPosition = positions[0];
      cluster = [sectionIndex];
      previousSectionIndex = sectionIndex;
      previousTocIndex = firstPosition;
    }
  }
  saveCluster();
  return excluded;
}

function normalizeOutlineText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}_]+/gu, "");
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  return values.find((value) => value?.trim())?.trim() ?? "Untitled EPUB";
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

interface PandocDocument {
  meta?: Record<string, PandocMetaValue>;
  blocks?: PandocBlock[];
}

interface PandocBlock {
  t: string;
  c?: unknown;
}

interface PandocInline {
  t: string;
  c?: unknown;
}

interface PandocMetaValue {
  t: string;
  c?: unknown;
}
