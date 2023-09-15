import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import {
  DocumentSection,
  KnowledgeDocument,
  makeId,
  nowIso,
  RawDoc
} from "@uknowledge/knowledge-schema";

const execFileAsync = promisify(execFile);
const PARSER_VERSION = "knowledge-ingest-server/epub-0.1:pandoc_epub";

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
  const sections = pandocBlocksToSections(ast.blocks ?? [], tempDir);
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
  return sections.map((section, index) => ({
    ...section,
    section_id: section.section_id ?? sectionId(index)
  }));
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

function firstNonEmpty(...values: Array<string | undefined>): string {
  return values.find((value) => value?.trim())?.trim() ?? "Untitled EPUB";
}

function sectionId(index: number): string {
  return `epub-section-${String(index + 1).padStart(5, "0")}`;
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
