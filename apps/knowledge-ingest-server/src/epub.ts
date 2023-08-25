import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
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
  cleanup: () => Promise<void>;
}

export interface ParseEpubOptions {
  rawdocId?: string;
  docId?: string;
  sourceUri?: string;
  titleHint?: string;
  tags?: string[];
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
    metaString(ast.meta?.title),
    "Untitled EPUB"
  );
  const authors = metaStringList(ast.meta?.author);
  const language = metaString(ast.meta?.lang) ?? metaString(ast.meta?.language);
  const sections = pandocBlocksToSections(ast.blocks ?? [], tempDir);

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
      tags: options.tags ?? []
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
      tags: options.tags,
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
    cleanup: () => rm(tempDir, { recursive: true, force: true })
  };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

export function pandocBlocksToSections(blocks: PandocBlock[], imageBaseDir?: string): DocumentSection[] {
  const sections: DocumentSection[] = [];
  let index = 0;
  for (const block of blocks) {
    const section = pandocBlockToSection(block, index, imageBaseDir);
    if (section) {
      sections.push(section);
      index += 1;
    }
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

function pandocBlockToSection(block: PandocBlock, index: number, imageBaseDir?: string): DocumentSection | undefined {
  switch (block.t) {
    case "Header": {
      const [level, , inlines] = block.c as [number, unknown, PandocInline[]];
      const content = inlineText(inlines);
      return content ? { section_id: sectionId(index), type: "heading", level, content } : undefined;
    }
    case "Para":
    case "Plain": {
      const inlines = block.c as PandocInline[];
      const image = firstImage(inlines, imageBaseDir);
      if (image) {
        return {
          section_id: sectionId(index),
          type: "figure",
          assets: [image]
        };
      }
      const content = inlineText(inlines);
      return content ? { section_id: sectionId(index), type: "paragraph", content } : undefined;
    }
    case "BlockQuote": {
      const content = blocksText(block.c as PandocBlock[]);
      return content ? { section_id: sectionId(index), type: "blockquote", content } : undefined;
    }
    case "BulletList":
    case "OrderedList": {
      const items = listItems(block);
      return items.length ? { section_id: sectionId(index), type: "list", items } : undefined;
    }
    case "CodeBlock": {
      const [, content] = block.c as [unknown, string];
      return content ? { section_id: sectionId(index), type: "code", content } : undefined;
    }
    case "Table": {
      const content = blocksText([block]);
      return content ? { section_id: sectionId(index), type: "table", content } : undefined;
    }
    default: {
      const content = blocksText([block]);
      return content ? { section_id: sectionId(index), type: "paragraph", content } : undefined;
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
      default:
        return "";
    }
  }).join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

function inlineText(inlines: PandocInline[] | undefined): string {
  if (!inlines) {
    return "";
  }
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
        return inlineText(inline.c as PandocInline[]);
      case "Code":
        return String((inline.c as [unknown, string])?.[1] ?? "");
      case "Link":
      case "Span":
        return inlineText((inline.c as [unknown, PandocInline[]])?.[1]);
      case "Image":
        return inlineText((inline.c as [unknown, PandocInline[], unknown])?.[1]);
      default:
        return "";
    }
  }).join("").replace(/[ \t]+/g, " ").trim();
}

function firstImage(inlines: PandocInline[], imageBaseDir?: string): DocumentSection["assets"] extends Array<infer T> ? T | undefined : never {
  for (const inline of inlines) {
    if (inline.t !== "Image") {
      continue;
    }
    const [, altInlines, target] = inline.c as [unknown, PandocInline[], [string, string]];
    const [rawPath] = target;
    const path = rawPath && imageBaseDir && !isAbsolute(rawPath) ? join(imageBaseDir, rawPath) : rawPath;
    return {
      path,
      alt: inlineText(altInlines)
    } as DocumentSection["assets"] extends Array<infer T> ? T : never;
  }
  return undefined as DocumentSection["assets"] extends Array<infer T> ? T | undefined : never;
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
