import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, posix } from "node:path";
import MarkdownIt from "markdown-it";
import type { Token } from "markdown-it";
import { parse as parseYaml } from "yaml";
import {
  assignDeterministicSectionIds,
  DocumentSection,
  KnowledgeDocument,
  makeId,
  nowIso,
  RawDoc
} from "@uknowledge/knowledge-schema";

const PARSER_VERSION = "knowledge-ingest-server/markdown-0.1:markdown_it";
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);

export interface MarkdownAssetInput {
  bytes: Buffer;
  filename?: string;
}

export interface ParseMarkdownOptions {
  rawdocId?: string;
  docId?: string;
  sourceUri?: string;
  relativePath?: string;
  titleHint?: string;
  tags?: string[];
  assets?: MarkdownAssetInput[];
}

export interface ParsedMarkdown {
  itemId: string;
  identityHash: string;
  rawdoc: RawDoc;
  document: KnowledgeDocument;
  warnings: string[];
  cleanup: () => Promise<void>;
}

interface MarkdownContext {
  sourceDir: string;
  assetFiles: Map<string, MarkdownAssetInput>;
  tempDir: string;
  warnings: string[];
  writtenAssets: Map<string, string>;
}

interface HeadingInfo {
  anchorId: string;
  content: string;
}

export async function parseMarkdown(bytes: Buffer, options: ParseMarkdownOptions = {}): Promise<ParsedMarkdown> {
  if (bytes.length === 0) {
    throw new Error("unsupported_file_type: Markdown file is empty");
  }

  const rawText = bytes.toString("utf8").replace(/^\uFEFF/, "");
  const identityHash = sha256(Buffer.from(rawText, "utf8"));
  const rawdocId = options.rawdocId ?? makeId();
  const docId = options.docId ?? makeId();
  const itemId = `markdown:sha256:${identityHash}`;
  const fetchTime = nowIso();
  const tempDir = await mkdtemp(join(tmpdir(), "knowledge-markdown-"));
  const warnings: string[] = [];

  try {
    const frontmatter = extractFrontmatter(rawText);
    const body = stripInternalSectionComments(frontmatter.body);
    const markdown = new MarkdownIt({
      html: false,
      linkify: false,
      typographer: false,
      breaks: false
    });
    const tokens = markdown.parse(body, {});
    const sourceRelativePath = normalizeRelativePath(options.relativePath);
    const context: MarkdownContext = {
      sourceDir: sourceRelativePath ? posix.dirname(sourceRelativePath) : "",
      assetFiles: buildAssetIndex(options.assets ?? [], warnings),
      tempDir,
      warnings,
      writtenAssets: new Map()
    };
    const headings = collectHeadingInfo(tokens);
    const sections = tokensToSections(tokens, headings, context);
    assignDeterministicSectionIds(sections);

    const firstHeading = sections.find((section) => section.type === "heading");
    const title = firstNonEmpty(
      stringValue(frontmatter.value.title),
      firstHeading?.content ? stripInlineMarkdown(firstHeading.content) : undefined,
      options.titleHint,
      basenameWithoutExtension(options.sourceUri),
      "Untitled Markdown"
    );
    const authors = normalizeStringList(frontmatter.value.authors ?? frontmatter.value.author);
    const tags = unique([
      ...(options.tags ?? []),
      ...normalizeStringList(frontmatter.value.tags)
    ]);
    const relativePath = sourceRelativePath || undefined;
    const metadata: Record<string, unknown> = {
      title,
      parserMethod: "markdown_it",
      parserProfile: "gfm",
      parserVersion: PARSER_VERSION,
      importMode: relativePath ? "folder_or_resource_directory" : "single_file",
      sourceUri: options.sourceUri,
      relativePath,
      tags,
      frontmatter: frontmatter.value,
      warnings
    };

    const rawdoc: RawDoc = {
      rawdoc_id: rawdocId,
      source_type: "markdown",
      source_uri: options.sourceUri ?? itemId,
      fetch_time: fetchTime,
      content_type: "text/markdown",
      content_length: bytes.byteLength,
      metadata
    };
    const document: KnowledgeDocument = {
      doc_id: docId,
      meta: {
        title,
        source: {
          type: "markdown",
          url: options.sourceUri ?? itemId,
          rawdoc_id: rawdocId
        },
        authors,
        published_at: stringValue(frontmatter.value.published_at),
        ingested_at: fetchTime,
        language: stringValue(frontmatter.value.language),
        tags,
        parser_version: PARSER_VERSION
      },
      sections: sections.length > 0
        ? sections
        : [{ type: "paragraph", content: title }]
    };

    return {
      itemId,
      identityHash,
      rawdoc,
      document,
      warnings,
      cleanup: () => rm(tempDir, { recursive: true, force: true })
    };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

function tokensToSections(tokens: Token[], headings: Map<Token, HeadingInfo>, context: MarkdownContext): DocumentSection[] {
  const sections: DocumentSection[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    switch (token.type) {
      case "heading_open": {
        const inline = tokens[index + 1];
        const info = headings.get(token);
        const content = info?.content ?? inline?.content ?? "";
        sections.push({
          type: "heading",
          level: Number(token.tag.slice(1)) || 2,
          content,
          anchor_id: info?.anchorId
        });
        index += 2;
        break;
      }
      case "paragraph_open": {
        const inline = tokens[index + 1];
        if (inline?.type === "inline") {
          sections.push(...paragraphToSections(inline, context));
          index = findClosingToken(tokens, index, "paragraph_close");
        }
        break;
      }
      case "blockquote_open": {
        const closing = findMatchingClose(tokens, index, "blockquote_open", "blockquote_close");
        const content = tokens
          .slice(index + 1, closing)
          .filter((child) => child.type === "inline")
          .map((child) => child.content.trim())
          .filter(Boolean)
          .join("\n");
        if (content) {
          sections.push({ type: "blockquote", content });
        }
        index = closing;
        break;
      }
      case "bullet_list_open":
      case "ordered_list_open": {
        const parsed = parseList(tokens, index, context);
        if (parsed.items.length > 0) {
          sections.push({ type: "list", items: parsed.items });
        }
        index = parsed.nextIndex;
        break;
      }
      case "fence":
        sections.push({
          type: "code",
          content: token.content,
          language: token.info.trim().split(/\s+/, 1)[0] || undefined
        });
        break;
      case "table_open": {
        const closing = findMatchingClose(tokens, index, "table_open", "table_close");
        const rows = tableRows(tokens.slice(index + 1, closing));
        if (rows.length > 0) {
          sections.push({ type: "table", rows });
        }
        index = closing;
        break;
      }
      case "html_block": {
        const content = stripHtml(token.content).trim();
        if (content) sections.push({ type: "paragraph", content });
        break;
      }
      case "hr":
        break;
      default:
        if (token.type === "inline" && token.content.trim()) {
          sections.push({ type: "paragraph", content: token.content });
        }
        break;
    }
  }
  return sections;
}

function paragraphToSections(inline: Token, context: MarkdownContext): DocumentSection[] {
  const images = imageAssets(inline, context);
  if (images.length === 0) {
    return inline.content.trim() ? [{ type: "paragraph", content: inline.content }] : [];
  }
  const content = inlineTextWithoutImages(inline).trim();
  return [{
    type: "figure",
    assets: images,
    ...(content ? { content } : {})
  }];
}

function parseList(tokens: Token[], startIndex: number, context: MarkdownContext): { items: Array<string | { text: string; items?: string[] }>; nextIndex: number } {
  const listOpen = tokens[startIndex];
  const listClose = listOpen.type === "ordered_list_open" ? "ordered_list_close" : "bullet_list_close";
  const items: Array<string | { text: string; items?: string[] }> = [];
  let index = startIndex + 1;
  while (index < tokens.length && tokens[index].type !== listClose) {
    if (tokens[index].type !== "list_item_open") {
      index += 1;
      continue;
    }
    const itemClose = findMatchingClose(tokens, index, "list_item_open", "list_item_close");
    const itemTokens = tokens.slice(index + 1, itemClose);
    const inline = itemTokens.find((token) => token.type === "inline");
    const text = inline?.content.trim() ?? "";
    const nestedList = itemTokens.findIndex((token) => token.type === "bullet_list_open" || token.type === "ordered_list_open");
    if (nestedList >= 0) {
      const nested = parseList(itemTokens, nestedList, context);
      if (text) items.push({ text, items: nested.items.map((item) => typeof item === "string" ? item : item.text) });
    } else if (text) {
      items.push(text);
    }
    index = itemClose + 1;
  }
  return { items, nextIndex: index };
}

function tableRows(tokens: Token[]): string[][] {
  const rows: string[][] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].type !== "tr_open") continue;
    const rowClose = findMatchingClose(tokens, index, "tr_open", "tr_close");
    const row: string[] = [];
    for (const cell of tokens.slice(index + 1, rowClose)) {
      if (cell.type === "inline") row.push(cell.content.trim());
    }
    if (row.length > 0) rows.push(row);
    index = rowClose;
  }
  return rows;
}

function imageAssets(inline: Token, context: MarkdownContext): NonNullable<DocumentSection["assets"]> {
  const assets: NonNullable<DocumentSection["assets"]> = [];
  for (const child of inline.children ?? []) {
    if (child.type !== "image") continue;
    const src = attr(child, "src");
    if (!src) continue;
    if (isRemoteUrl(src)) {
      assets.push({ source_url: src, alt: child.content, caption: attr(child, "title") ?? null });
      continue;
    }
    const relativePath = resolveAssetPath(context.sourceDir, src);
    if (!relativePath) {
      context.warnings.push(`Unsafe local image reference skipped: ${src}`);
      continue;
    }
    const input = context.assetFiles.get(relativePath);
    if (!input) {
      context.warnings.push(`Missing local image: ${src}`);
      continue;
    }
    let tempPath = context.writtenAssets.get(relativePath);
    if (!tempPath) {
      tempPath = join(context.tempDir, "assets", relativePath);
      context.writtenAssets.set(relativePath, tempPath);
      mkdirSync(dirname(tempPath), { recursive: true });
      writeFileSync(tempPath, input.bytes);
    }
    assets.push({
      path: tempPath,
      relative_path: relativePath,
      alt: child.content,
      caption: attr(child, "title") ?? null
    });
  }
  return assets;
}

function collectHeadingInfo(tokens: Token[]): Map<Token, HeadingInfo> {
  const result = new Map<Token, HeadingInfo>();
  const used = new Map<string, number>();
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].type !== "heading_open") continue;
    const inline = tokens[index + 1];
    const rawContent = inline?.content ?? "";
    const explicit = rawContent.match(/\s+\{#([A-Za-z0-9_.:-]+)\}\s*$/);
    const content = explicit ? rawContent.slice(0, explicit.index).trimEnd() : rawContent;
    const base = explicit?.[1] || slugifyHeading(stripInlineMarkdown(content));
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    result.set(tokens[index], {
      content,
      anchorId: count === 0 ? base : `${base}-${count + 1}`
    });
  }
  return result;
}

function buildAssetIndex(inputs: MarkdownAssetInput[], warnings: string[]): Map<string, MarkdownAssetInput> {
  const result = new Map<string, MarkdownAssetInput>();
  for (const input of inputs) {
    const filename = normalizeRelativePath(input.filename);
    if (!filename) {
      warnings.push("A local asset was skipped because its relative filename is invalid.");
      continue;
    }
    if (result.has(filename)) {
      warnings.push(`Duplicate local asset path: ${filename}`);
      continue;
    }
    result.set(filename, input);
  }
  return result;
}

function extractFrontmatter(text: string): { value: Record<string, unknown>; body: string } {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/.exec(text);
  if (!match) return { value: {}, body: text };
  const parsed = parseYaml(match[1]) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid_frontmatter: YAML frontmatter must be an object");
  }
  return { value: parsed as Record<string, unknown>, body: text.slice(match[0].length) };
}

function stripInternalSectionComments(text: string): string {
  return text.replace(/<!--\s*section_id\s*:[\s\S]*?-->\s*/gi, "");
}

function normalizeRelativePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    return undefined;
  }
  return normalized;
}

function resolveAssetPath(sourceDir: string, reference: string): string | undefined {
  let decoded = reference;
  try {
    decoded = decodeURIComponent(reference);
  } catch {
    return undefined;
  }
  decoded = decoded.split(/[?#]/, 1)[0];
  if (!decoded || isRemoteUrl(decoded)) return undefined;
  return normalizeRelativePath(posix.join(sourceDir || ".", decoded));
}

function inlineTextWithoutImages(token: Token): string {
  return (token.children ?? []).map((child) => {
    if (child.type === "image") return "";
    if (child.type === "softbreak" || child.type === "hardbreak") return "\n";
    if (child.type === "code_inline" || child.type === "text") return child.content;
    return child.content;
  }).join("");
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .trim();
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, "");
}

function isRemoteUrl(value: string): boolean {
  return /^(?:https?:)?\/\//i.test(value);
}

function attr(token: Token, name: string): string | undefined {
  return token.attrGet(name) ?? undefined;
}

function findClosingToken(tokens: Token[], startIndex: number, type: string): number {
  for (let index = startIndex + 1; index < tokens.length; index += 1) {
    if (tokens[index].type === type) return index;
  }
  return tokens.length - 1;
}

function findMatchingClose(tokens: Token[], startIndex: number, openType: string, closeType: string): number {
  let depth = 0;
  for (let index = startIndex; index < tokens.length; index += 1) {
    if (tokens[index].type === openType) depth += 1;
    if (tokens[index].type === closeType) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return tokens.length - 1;
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/[;,]/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  return values.find((value) => Boolean(value?.trim()))?.trim() ?? "";
}

function basenameWithoutExtension(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const base = posix.basename(value.replaceAll("\\", "/"));
  const extension = extname(base);
  return (MARKDOWN_EXTENSIONS.has(extension.toLowerCase()) ? base.slice(0, -extension.length) : base) || undefined;
}

function slugifyHeading(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
  return normalized || "section";
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
