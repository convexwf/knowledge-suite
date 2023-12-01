import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KnowledgeCaptureInput, KnowledgeDocument, ParserCandidatePreview } from "@uknowledge/knowledge-schema";
import { describe, expect, it } from "vitest";
import { resolveKnowledgeCaptureInput } from "./input.js";
import { documentToMarkdown } from "./markdown.js";
import { parsePage } from "./parser.js";
import type { ServerConfig } from "./config.js";

interface ParserFixtureCase {
  id: string;
  title: string;
  priority: "p0" | "p1" | "p2";
  status: "active" | "quarantined";
  source: {
    pageUrl: string;
    canonicalUrl?: string;
    capturedAt: string;
    captureMode: "browser_html" | "server_fetch" | "manual";
    notes?: string;
  };
  expectations: {
    parserMethod?: string;
    parserProfile?: string;
    requiredCandidates?: Array<{
      method: string;
      adapterId?: string;
    }>;
    minTextLength?: number;
    maxLinkDensity?: number;
    titleIncludes?: string[];
    authorsInclude?: string[];
    tagsInclude?: string[];
    sectionTypes?: string[];
    markdownIncludes?: string[];
    markdownExcludes?: string[];
    documentTextIncludes?: string[];
    warningsInclude?: string[];
    warningsExclude?: string[];
  };
}

interface ParserFixtureSnapshot {
  pageUrl?: string;
  canonicalUrl?: string;
  title?: string;
  pageTitle?: string;
  text?: string;
  meta?: Record<string, string>;
  selectionHtml?: string;
  diagnostics?: {
    htmlLength?: number;
    textLength?: number;
    shadowRootCount?: number;
  };
}

interface NormalizedCandidate {
  id: string;
  method: string;
  adapterId?: string;
  selector?: string;
  selected: boolean;
  serverSelected?: boolean;
  score: number;
  metrics: ParserCandidatePreview["metrics"];
  warnings: string[];
  reason: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "..", "fixtures", "parser");
const casesRoot = join(fixtureRoot, "cases");
const shouldUpdate = process.env.UPDATE_PARSER_FIXTURES === "1";

const testConfig: ServerConfig = {
  host: "127.0.0.1",
  port: 0,
  token: "fixture-token",
  storeRoot: join(fixtureRoot, "reports", "store"),
  fetchTimeoutMs: 1000,
  maxHtmlBytes: 10 * 1024 * 1024
};

describe("parser fixture corpus", async () => {
  const cases = await loadCases();

  for (const fixtureCase of cases.filter((item) => item.status === "active")) {
    it(`${fixtureCase.priority} ${fixtureCase.id}`, async () => {
      const paths = pathsFor(fixtureCase.id);
      const html = await readFile(paths.html, "utf8");
      const snapshot = await readJson<ParserFixtureSnapshot>(paths.snapshot);
      const input = fixtureInput(fixtureCase, snapshot, html);
      const resolved = await resolveKnowledgeCaptureInput(input, testConfig);
      const parsed = await parsePage(resolved, {
        rawdocId: stableRawdocId(fixtureCase.id)
      });
      const normalizedDocument = normalizeDocument(parsed.document, fixtureCase);
      const markdown = normalizeMarkdown(documentToMarkdown(normalizedDocument), fixtureCase);
      const candidates = normalizeCandidates(parsed.candidatePreviews);

      assertExpectations(fixtureCase, normalizedDocument, markdown, candidates);

      if (shouldUpdate) {
        await writeJson(paths.expectedDocument, normalizedDocument);
        await writeFile(paths.expectedMarkdown, markdown, "utf8");
        await writeJson(paths.expectedCandidates, candidates);
        return;
      }

      await expect(readJson(paths.expectedDocument)).resolves.toEqual(normalizedDocument);
      await expect(readFile(paths.expectedMarkdown, "utf8")).resolves.toBe(markdown);
      await expect(readJson(paths.expectedCandidates)).resolves.toEqual(candidates);
    });
  }
});

async function loadCases(): Promise<ParserFixtureCase[]> {
  const entries = await readdir(casesRoot, { withFileTypes: true });
  const cases = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => readJson<ParserFixtureCase>(join(casesRoot, entry.name, "case.json"))));
  return cases.sort((left, right) => left.id.localeCompare(right.id));
}

function fixtureInput(fixtureCase: ParserFixtureCase, snapshot: ParserFixtureSnapshot, html: string): KnowledgeCaptureInput {
  return {
    inputMode: "browser_html",
    snapshot: {
      pageUrl: snapshot.pageUrl ?? fixtureCase.source.pageUrl,
      canonicalUrl: snapshot.canonicalUrl ?? fixtureCase.source.canonicalUrl,
      pageTitle: snapshot.pageTitle ?? fixtureCase.title,
      title: snapshot.title ?? fixtureCase.title,
      html,
      text: snapshot.text,
      diagnostics: {
        htmlLength: Buffer.byteLength(html),
        textLength: snapshot.text?.length ?? 0,
        shadowRootCount: snapshot.diagnostics?.shadowRootCount ?? 0
      },
      capturedAt: fixtureCase.source.capturedAt,
      meta: snapshot.meta ?? {},
      selectionHtml: snapshot.selectionHtml
    }
  };
}

function assertExpectations(
  fixtureCase: ParserFixtureCase,
  document: KnowledgeDocument,
  markdown: string,
  candidates: NormalizedCandidate[]
): void {
  const expected = fixtureCase.expectations;
  const selectedCandidate = candidates.find((candidate) => candidate.selected);
  const documentText = document.sections.map((section) => [
    section.content,
    ...(section.items ?? []).map((item) => typeof item === "string" ? item : item.text),
    ...(Array.isArray(section.rows) ? section.rows.flat().map(String) : []),
    ...(section.assets ?? []).flatMap((asset) => [asset.alt ?? "", asset.caption ?? ""])
  ].filter(Boolean).join(" ")).join(" ");

  if (expected.parserMethod) {
    expect(document.meta.parser_version).toContain(`:${expected.parserMethod}`);
    expect(selectedCandidate?.method).toBe(expected.parserMethod);
  }
  if (expected.parserProfile) {
    expect(selectedCandidate?.adapterId ?? selectedCandidate?.method).toBe(expected.parserProfile);
  }
  for (const required of expected.requiredCandidates ?? []) {
    expect(candidates.some((candidate) =>
      candidate.method === required.method &&
      (!required.adapterId || candidate.adapterId === required.adapterId)
    )).toBe(true);
  }
  if (expected.minTextLength !== undefined) {
    expect(textLength(document)).toBeGreaterThanOrEqual(expected.minTextLength);
  }
  if (expected.maxLinkDensity !== undefined && selectedCandidate) {
    expect(selectedCandidate.metrics.linkDensity).toBeLessThanOrEqual(expected.maxLinkDensity);
  }
  for (const titlePart of expected.titleIncludes ?? []) {
    expect(document.meta.title).toContain(titlePart);
  }
  for (const author of expected.authorsInclude ?? []) {
    expect(document.meta.authors ?? []).toContain(author);
  }
  for (const tag of expected.tagsInclude ?? []) {
    expect(document.meta.tags ?? []).toContain(tag);
  }
  if (expected.sectionTypes) {
    expect(document.sections.map((section) => section.type).slice(0, expected.sectionTypes.length))
      .toEqual(expected.sectionTypes);
  }
  for (const text of expected.documentTextIncludes ?? []) {
    expect(documentText).toContain(text);
  }
  for (const text of expected.markdownIncludes ?? []) {
    expect(markdown).toContain(text);
  }
  for (const text of expected.markdownExcludes ?? []) {
    expect(markdown).not.toContain(text);
  }
  const warnings = candidates.flatMap((candidate) => candidate.warnings);
  for (const warning of expected.warningsInclude ?? []) {
    expect(warnings.join("\n")).toContain(warning);
  }
  for (const warning of expected.warningsExclude ?? []) {
    expect(warnings.join("\n")).not.toContain(warning);
  }
}

function normalizeDocument(document: KnowledgeDocument, fixtureCase: ParserFixtureCase): KnowledgeDocument {
  return {
    ...document,
    doc_id: stableDocId(fixtureCase.id),
    meta: {
      ...document.meta,
      ingested_at: fixtureCase.source.capturedAt,
      source: {
        ...document.meta.source,
        rawdoc_id: stableRawdocId(fixtureCase.id)
      }
    },
    references: document.references?.map((reference, index) => ({
      ...reference,
      ref_id: reference.ref_id || `${fixtureCase.id}-ref-${index + 1}`
    })),
    sections: document.sections.map((section, index) => ({
      ...section,
      section_id: `${fixtureCase.id}-section-${index + 1}`,
      assets: section.assets?.map((asset, assetIndex) => ({
        ...asset,
        asset_id: `${fixtureCase.id}-asset-${assetIndex + 1}`
      }))
    }))
  };
}

function normalizeCandidates(candidates: ParserCandidatePreview[]): NormalizedCandidate[] {
  return candidates.map((candidate) => ({
    id: candidate.id,
    method: candidate.method,
    adapterId: candidate.adapterId,
    selector: candidate.selector,
    selected: candidate.selected,
    serverSelected: candidate.serverSelected,
    score: round(candidate.score),
    metrics: {
      ...candidate.metrics,
      linkDensity: round(candidate.metrics.linkDensity)
    },
    warnings: [...candidate.warnings].sort(),
    reason: candidate.reason
  }));
}

function normalizeMarkdown(markdown: string, fixtureCase: ParserFixtureCase): string {
  return markdown
    .replace(/^ingested_at: .+$/m, `ingested_at: "${fixtureCase.source.capturedAt}"`);
}

function textLength(document: KnowledgeDocument): number {
  return document.sections.reduce((total, section) => total + [
    section.content ?? "",
    ...(section.items ?? []).map((item) => typeof item === "string" ? item : item.text),
    ...(Array.isArray(section.rows) ? section.rows.flat().map(String) : []),
    ...(section.assets ?? []).flatMap((asset) => [asset.alt ?? "", asset.caption ?? ""])
  ].join(" ").replace(/\s+/g, " ").trim().length, 0);
}

function pathsFor(caseId: string): Record<string, string> {
  const caseRoot = join(casesRoot, caseId);
  return {
    html: join(caseRoot, "input.html"),
    snapshot: join(caseRoot, "input.snapshot.json"),
    expectedDocument: join(caseRoot, "expected.document.json"),
    expectedMarkdown: join(caseRoot, "expected.markdown.md"),
    expectedCandidates: join(caseRoot, "expected.candidates.json")
  };
}

async function readJson<T = unknown>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function stableDocId(caseId: string): string {
  return `fixture-doc-${caseId}`;
}

function stableRawdocId(caseId: string): string {
  return `fixture-rawdoc-${caseId}`;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
