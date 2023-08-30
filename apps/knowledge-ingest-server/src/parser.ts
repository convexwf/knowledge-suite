import DefuddleDefault, { type DefuddleOptions, type DefuddleResponse } from "defuddle";
import { parseHTML } from "linkedom";
import {
  KnowledgeDocument,
  makeId,
  nowIso,
  RawDoc
} from "@uknowledge/knowledge-schema";
import { matchSiteAdapters, type MatchedAdapter, type SiteAdapter } from "./parser/adapters/index.js";
import { ResolvedInput } from "./input.js";

export interface ParsedPage {
  rawdoc: RawDoc;
  document: KnowledgeDocument;
  candidatePreviews: ParserCandidateDocumentPreview[];
  selectedCandidateId: string;
  serverSelectedCandidateId: string;
  activeCandidateId: string;
}

interface ParsePageOptions {
  rawdocId?: string;
  selectedCandidateId?: string;
}

type ParserMethod =
  | "selection"
  | "defuddle"
  | "site_adapter"
  | "schema_org"
  | "dom_fallback"
  | "rendered_text_fallback";

interface CandidateMetrics {
  textLength: number;
  sectionCount: number;
  headingCount: number;
  linkCount: number;
  imageCount: number;
  tableCount: number;
  codeCount: number;
  linkDensity: number;
}

interface ParserCandidate {
  id: string;
  method: ParserMethod;
  adapterId?: string;
  selector?: string;
  title?: string;
  sections: KnowledgeDocument["sections"];
  metadata: {
    authors?: string[];
    publishedAt?: string | null;
    language?: string;
    image?: string;
    tags?: string[];
  };
  references?: KnowledgeDocument["references"];
  metrics: CandidateMetrics;
  score: number;
  warnings: string[];
  reason: string;
}

interface ParserCandidateDocumentPreview {
  id: string;
  method: ParserMethod;
  adapterId?: string;
  selector?: string;
  selected: boolean;
  score: number;
  metrics: CandidateMetrics;
  warnings: string[];
  reason: string;
  document: KnowledgeDocument;
}

interface DefuddleRunDiagnostics {
  attempted: boolean;
  mode?: "async" | "sync";
  asyncTimedOut?: boolean;
  useful?: boolean;
  contentTextLength?: number;
  wordCount?: number;
  error?: string;
}

const PARSER_VERSION = "knowledge-ingest-server/0.2";
const DEFUDDLE_ASYNC_TIMEOUT_MS = 5000;
const DefuddleClass = DefuddleDefault as unknown as {
  new (doc: Document, options?: DefuddleOptions): {
    parse(): DefuddleResponse;
    parseAsync(): Promise<DefuddleResponse>;
  };
};

export async function parsePage(input: ResolvedInput, options: ParsePageOptions = {}): Promise<ParsedPage> {
  const rawdocId = options.rawdocId ?? makeId();
  const fetchTime = nowIso();
  const matchedAdapters = matchSiteAdapters(input);
  const rawDocument = parseRawDocument(input.html);
  const defuddleDocument = parseRawDocument(input.html);
  applyDefuddleRootHints(defuddleDocument, matchedAdapters);
  const baseDocument = parseCleanDocument(input.html);
  const htmlBaseUrl = htmlBaseUrlFor(input);
  const defuddleRun = await runDefuddle(defuddleDocument, input);
  const defuddleResult = defuddleRun.result;
  const pageTitle = input.pageTitle || input.title || readPageTitle(rawDocument) || input.normalizedUrl;
  const title = readContentTitle(rawDocument) || defuddleResult?.title || pageTitle;
  const candidates = buildCandidates(input, title, pageTitle, defuddleResult, matchedAdapters);
  const serverSelected = selectCandidate(candidates);
  const selected = selectRequestedCandidate(candidates, options.selectedCandidateId, serverSelected);
  const selectedCandidateId = selected.id;
  const serverSelectedCandidateId = serverSelected.id;
  const activeCandidateId = selected.id;
  const fallbackText = normalizeText(input.bodyText || baseDocument.body?.textContent || "");
  const parserWarnings = collectParserWarnings(selected, candidates);
  const parserDiagnostics = buildParserDiagnostics(input, selected, candidates, defuddleRun.diagnostics);
  const selectedTitle = selected.title || title;
  const displayTitle = displayTitleFor(pageTitle, selectedTitle, input.normalizedUrl);
  const userSelectedCandidateId = options.selectedCandidateId && options.selectedCandidateId !== serverSelectedCandidateId
    ? selectedCandidateId
    : undefined;

  const rawdoc: RawDoc = {
    rawdoc_id: rawdocId,
    source_type: input.inputMode === "browser_html" && input.url.startsWith("file://") ? "singlefile_html" : "url",
    source_uri: input.url,
    fetch_time: fetchTime,
    content_type: "text/html",
    content_length: Buffer.byteLength(input.html),
    metadata: {
      inputMode: input.inputMode,
      normalizedUrl: input.normalizedUrl,
      originalUrl: input.originalUrl,
      canonicalUrl: input.canonicalUrl,
      fetchUrl: input.fetchUrl,
      title: pageTitle,
      pageTitle,
      contentTitle: selectedTitle,
      displayTitle,
      parserMethod: selected.method,
      parserProfile: selected.adapterId ?? selected.method,
      selectedCandidateId,
      parserSelectedCandidateId: serverSelectedCandidateId,
      userSelectedCandidateId,
      parserWarnings,
      matchedAdapters: matchedAdapters.map((match) => ({
        id: match.adapter.id,
        type: match.adapter.type,
        priority: match.adapter.priority,
        matchScore: round(match.matchScore),
        matchReason: match.matchReason
      })),
      parserCandidates: candidates.map((candidate) => candidateSummary(
        candidate,
        selectedCandidateId,
        serverSelectedCandidateId
      )),
      defuddle: defuddleResult
        ? {
            author: defuddleResult.author,
            domain: defuddleResult.domain,
            extractorType: defuddleResult.extractorType,
            image: defuddleResult.image,
            language: defuddleResult.language,
            site: defuddleResult.site,
            wordCount: defuddleResult.wordCount,
            diagnostics: defuddleRun.diagnostics
          }
        : { diagnostics: defuddleRun.diagnostics },
      parserDiagnostics,
      meta: input.meta
    }
  };

  const documentContext = {
    input,
    rawdocId,
    fetchTime,
    pageTitle,
    fallbackText,
    baseDocument,
    defuddleResult
  };
  const previewCandidates = candidatePreviewsFor(candidates, selected, serverSelected);
  const candidatePreviews = previewCandidates.map((candidate) => ({
    ...candidateSummary(candidate, selectedCandidateId, serverSelectedCandidateId),
    document: candidateToDocument(candidate, documentContext)
  }));
  const selectedPreview = candidatePreviews.find((preview) => preview.id === selectedCandidateId);
  const knowledgeDocument = selectedPreview?.document ?? candidateToDocument(selected, documentContext);

  return {
    rawdoc,
    document: knowledgeDocument,
    candidatePreviews,
    selectedCandidateId,
    serverSelectedCandidateId,
    activeCandidateId
  };
}

interface CandidateDocumentContext {
  input: ResolvedInput;
  rawdocId: string;
  fetchTime: string;
  pageTitle: string;
  fallbackText: string;
  baseDocument: Document;
  defuddleResult?: DefuddleResponse;
}

function candidateSummary(
  candidate: ParserCandidate,
  selectedCandidateId: string,
  serverSelectedCandidateId: string
): Omit<ParserCandidateDocumentPreview, "document"> & { serverSelected: boolean } {
  return {
    id: candidate.id,
    method: candidate.method,
    adapterId: candidate.adapterId,
    selector: candidate.selector,
    selected: candidate.id === selectedCandidateId,
    serverSelected: candidate.id === serverSelectedCandidateId,
    score: round(candidate.score),
    metrics: candidate.metrics,
    warnings: candidate.warnings,
    reason: candidate.reason
  };
}

function candidateToDocument(
  candidate: ParserCandidate,
  context: CandidateDocumentContext
): KnowledgeDocument {
  const selectedTitle = candidate.title || context.pageTitle;
  const sections = candidate.sections.length > 0
    ? candidate.sections
    : context.fallbackText
      ? [{ section_id: makeId(), type: "paragraph" as const, content: context.fallbackText }]
      : [];

  return {
    doc_id: makeId(),
    meta: {
      title: selectedTitle,
      page_title: context.pageTitle,
      source: {
        type: "html",
        url: context.input.url,
        rawdoc_id: context.rawdocId
      },
      authors: candidate.metadata.authors?.length
        ? candidate.metadata.authors
        : readAuthors(context.baseDocument, context.input.meta, context.defuddleResult),
      published_at: candidate.metadata.publishedAt ??
        readPublishedAt(context.baseDocument, context.input.meta, context.defuddleResult),
      ingested_at: context.fetchTime,
      language: candidate.metadata.language ||
        context.defuddleResult?.language ||
        context.baseDocument.documentElement?.getAttribute("lang") ||
        context.input.meta.language,
      tags: unique(candidate.metadata.tags ?? []),
      parser_version: `${PARSER_VERSION}:${candidate.method}`
    },
    references: candidate.references,
    sections
  };
}

function candidatePreviewsFor(
  candidates: ParserCandidate[],
  selected: ParserCandidate,
  serverSelected: ParserCandidate
): ParserCandidate[] {
  const result: ParserCandidate[] = [];
  const add = (candidate: ParserCandidate) => {
    if (!result.some((item) => item.id === candidate.id)) {
      result.push(candidate);
    }
  };

  add(selected);
  add(serverSelected);
  for (const candidate of candidates
    .filter(isViableCandidate)
    .sort((left, right) => right.score - left.score)) {
    add(candidate);
    if (result.length >= 8) {
      break;
    }
  }

  return result.length > 0 ? result : [selected];
}

function selectRequestedCandidate(
  candidates: ParserCandidate[],
  requestedCandidateId: string | undefined,
  fallback: ParserCandidate
): ParserCandidate {
  if (!requestedCandidateId) {
    return fallback;
  }
  const requested = candidates.find((candidate) => candidate.id === requestedCandidateId);
  if (!requested) {
    throw new Error(`candidateId not found: ${requestedCandidateId}`);
  }
  if (!isViableCandidate(requested)) {
    throw new Error(`candidateId is not viable: ${requestedCandidateId}`);
  }
  return requested;
}

function isViableCandidate(candidate: ParserCandidate): boolean {
  return candidate.sections.length > 0 && candidate.metrics.textLength > 0;
}

function buildCandidates(
  input: ResolvedInput,
  title: string,
  pageTitle: string,
  defuddleResult: DefuddleResponse | undefined,
  matchedAdapters: MatchedAdapter[]
): ParserCandidate[] {
  const candidates: ParserCandidate[] = [];

  const selectionCandidate = buildSelectionCandidate(input, title);
  if (selectionCandidate) {
    candidates.push(selectionCandidate);
  }

  if (defuddleResult) {
    const sections = extractDefuddleSections(defuddleResult.content, title, htmlBaseUrlFor(input));
    candidates.push(makeCandidate({
      id: "defuddle",
      method: "defuddle",
      title: defuddleResult.title && defuddleResult.title !== pageTitle ? defuddleResult.title : title,
      sections,
      metadata: {
        authors: defuddleResult.author ? [defuddleResult.author] : undefined,
        publishedAt: normalizeDate(defuddleResult.published),
        language: defuddleResult.language,
        image: defuddleResult.image
      },
      reason: "Defuddle universal article extraction",
      baseScore: 20,
      warnings: defuddleResult.wordCount && defuddleResult.wordCount < 20
        ? [`Low Defuddle word count: ${defuddleResult.wordCount}`]
        : []
    }));
  }

  for (const match of matchedAdapters) {
    candidates.push(...buildAdapterCandidates(input, title, match));
  }

  const schemaCandidate = buildSchemaOrgCandidate(input, title);
  if (schemaCandidate) {
    candidates.push(schemaCandidate);
  }

  const renderedTextCandidate = buildRenderedTextFallbackCandidate(input, title);
  if (renderedTextCandidate) {
    candidates.push(renderedTextCandidate);
  }

  const fallbackDocument = parseCleanDocument(input.html);
  const htmlBaseUrl = htmlBaseUrlFor(input);
  applyMatchedAdapterCleanup(fallbackDocument, matchedAdapters, htmlBaseUrl, "fallback");
  const fallbackRoot = pickReadableRoot(fallbackDocument);
  normalizeUrls(fallbackRoot, htmlBaseUrl);
  candidates.push(makeCandidate({
    id: "dom_fallback",
    method: "dom_fallback",
    title,
    sections: extractSections(fallbackRoot, title),
    metadata: {},
    reason: "Generic DOM readable-root fallback",
    baseScore: 0,
    warnings: []
  }));

  return candidates;
}

function buildRenderedTextFallbackCandidate(input: ResolvedInput, title: string): ParserCandidate | undefined {
  const text = normalizeText(input.bodyText ?? "");
  if (text.length < 80) {
    return undefined;
  }

  const sections = textToParagraphSections(input.bodyText ?? "", title);
  if (sections.length === 0) {
    return undefined;
  }

  return makeCandidate({
    id: "rendered_text_fallback",
    method: "rendered_text_fallback",
    title,
    sections,
    metadata: {},
    reason: "Browser-rendered body innerText fallback",
    baseScore: -15,
    warnings: ["Rendered text fallback loses links, images, tables, and code structure."]
  });
}

function buildSelectionCandidate(input: ResolvedInput, title: string): ParserCandidate | undefined {
  if (!input.selectionHtml || normalizeText(input.selectionHtml).length < 20) {
    return undefined;
  }
  const document = parseCleanDocument(input.selectionHtml);
  const root = pickParsedContentRoot(document);
  if (!root) {
    return undefined;
  }
  normalizeUrls(root, htmlBaseUrlFor(input));
  return makeCandidate({
    id: "selection",
    method: "selection",
    title,
    sections: extractSections(root, title),
    metadata: {},
    reason: "User-selected page fragment",
    baseScore: 120,
    warnings: []
  });
}

function buildSchemaOrgCandidate(input: ResolvedInput, fallbackTitle: string): ParserCandidate | undefined {
  const document = parseHTML(input.html).document;
  const article = findSchemaArticle(document);
  if (!article) {
    return undefined;
  }

  const title = stringValue(article.headline) || stringValue(article.name) || fallbackTitle;
  const body = stringValue(article.articleBody) || stringValue(article.abstract) || stringValue(article.description);
  if (!body || normalizeText(body).length < 80) {
    return undefined;
  }

  const sections: KnowledgeDocument["sections"] = [];
  const abstract = stringValue(article.abstract);
  if (abstract && normalizeText(abstract) !== normalizeText(body)) {
    sections.push({
      section_id: makeId(),
      type: "heading",
      level: 2,
      content: "Abstract"
    });
    sections.push({
      section_id: makeId(),
      type: "paragraph",
      content: normalizeText(abstract)
    });
  }
  for (const paragraph of body.split(/\n{2,}/).map(normalizeText).filter(Boolean)) {
    sections.push({
      section_id: makeId(),
      type: "paragraph",
      content: paragraph
    });
  }

  return makeCandidate({
    id: "schema_org",
    method: "schema_org",
    title,
    sections,
    metadata: {
      authors: schemaAuthors(article.author),
      publishedAt: normalizeDate(stringValue(article.datePublished)),
      image: schemaImage(article.image),
      tags: schemaKeywords(article.keywords)
    },
    reason: `Schema.org ${stringValue(article["@type"]) || "Article"} JSON-LD candidate`,
    baseScore: 30,
    warnings: []
  });
}

function buildAdapterCandidates(input: ResolvedInput, title: string, match: MatchedAdapter): ParserCandidate[] {
  const document = parseRawDocument(input.html);
  const baseUrl = htmlBaseUrlFor(input);
  applyAdapterCleanup(document, match.adapter, baseUrl);
  const candidates: ParserCandidate[] = [];

  for (const selector of match.adapter.content.selectors) {
    const roots = [...document.querySelectorAll(selector)];
    for (const [index, root] of roots.entries()) {
      applyScopedExcludes(root, match.adapter.content.excludeSelectors ?? []);
      normalizeUrls(root, baseUrl);
      const rootTextLength = normalizeText(root.textContent ?? "").length;
      if (rootTextLength < (match.adapter.content.requireTextLength ?? 0) && !root.querySelector("img,table")) {
        continue;
      }
      const sections = extractSections(root, title);
      candidates.push(makeCandidate({
        id: `adapter:${match.adapter.id}:${selector}:${index}`,
        method: "site_adapter",
        adapterId: match.adapter.id,
        selector,
        title: readAdapterMetadata(document, match.adapter, "title") || title,
        sections,
        metadata: {
          authors: readAdapterMetadataList(document, match.adapter, "author"),
          publishedAt: normalizeDate(readAdapterMetadata(document, match.adapter, "publishedAt")),
          image: readAdapterMetadata(document, match.adapter, "image"),
          tags: match.adapter.enrich?.tags?.(input.url) ?? []
        },
        references: match.adapter.enrich?.references?.(root),
        reason: `Matched ${match.adapter.id} (${match.matchReason}); content selector ${selector}`,
        baseScore: match.adapter.priority / 2 + match.matchScore / 10 + (match.adapter.quality?.minScoreBonus ?? 0),
        warnings: []
      }));
    }
  }

  return dedupeSimilarAdapterCandidates(candidates);
}

function htmlBaseUrlFor(input: ResolvedInput): string {
  return input.fetchUrl ?? input.originalUrl ?? input.url;
}

function makeCandidate(params: {
  id: string;
  method: ParserMethod;
  adapterId?: string;
  selector?: string;
  title?: string;
  sections: KnowledgeDocument["sections"];
  metadata: ParserCandidate["metadata"];
  references?: ParserCandidate["references"];
  reason: string;
  baseScore: number;
  warnings: string[];
}): ParserCandidate {
  const metrics = measureSections(params.sections);
  const warnings = [...params.warnings, ...qualityWarnings(metrics)];
  const score = scoreCandidate(params.method, metrics, params.baseScore, warnings);
  return {
    ...params,
    metrics,
    warnings,
    score
  };
}

function dedupeSimilarAdapterCandidates(candidates: ParserCandidate[]): ParserCandidate[] {
  const deduped: ParserCandidate[] = [];
  for (const candidate of candidates) {
    const duplicateIndex = deduped.findIndex((existing) => areSimilarCandidates(existing, candidate));
    if (duplicateIndex === -1) {
      deduped.push(candidate);
      continue;
    }
    if (candidate.score > deduped[duplicateIndex].score) {
      deduped[duplicateIndex] = candidate;
    }
  }
  return deduped;
}

function areSimilarCandidates(left: ParserCandidate, right: ParserCandidate): boolean {
  const leftText = candidateText(left);
  const rightText = candidateText(right);
  if (!leftText || !rightText) {
    return false;
  }
  if (leftText === rightText) {
    return true;
  }
  const [shorter, longer] = leftText.length < rightText.length
    ? [leftText, rightText]
    : [rightText, leftText];
  if (shorter.length < 120) {
    return false;
  }
  return shorter.length / longer.length >= 0.9 && longer.includes(shorter);
}

function candidateText(candidate: ParserCandidate): string {
  return normalizeText(candidate.sections.map(sectionText).join(" ")).toLowerCase();
}

function selectCandidate(candidates: ParserCandidate[]): ParserCandidate {
  const viable = candidates.filter(isViableCandidate);
  const pool = viable.length > 0 ? viable : candidates;
  const selected = [...pool].sort((left, right) => right.score - left.score)[0];
  return selected ?? {
    id: "empty",
    method: "dom_fallback",
    sections: [],
    metadata: {},
    metrics: emptyMetrics(),
    score: 0,
    warnings: ["No parser candidate produced content."],
    reason: "Empty parser result"
  };
}

async function runDefuddle(
  document: Document,
  input: ResolvedInput
): Promise<{ result?: DefuddleResponse; diagnostics: DefuddleRunDiagnostics }> {
  const diagnostics: DefuddleRunDiagnostics = {
    attempted: true
  };

  try {
    const asyncDefuddle = new DefuddleClass(document.cloneNode(true) as Document, {
      url: input.url,
      language: input.meta.language,
      useAsync: true
    });
    const result = await withTimeout(asyncDefuddle.parseAsync(), DEFUDDLE_ASYNC_TIMEOUT_MS);
    diagnostics.mode = "async";
    diagnostics.useful = isUsefulExtraction(result);
    diagnostics.contentTextLength = normalizeText(result.content).length;
    diagnostics.wordCount = result.wordCount;
    if (diagnostics.useful) {
      return { result, diagnostics };
    }
  } catch (error) {
    diagnostics.asyncTimedOut = error instanceof Error && error.message === "Defuddle parseAsync timeout";
    diagnostics.error = error instanceof Error ? error.message : String(error);
  }

  try {
    const defuddle = new DefuddleClass(document, {
      url: input.url,
      language: input.meta.language,
      useAsync: false
    });
    const result = defuddle.parse();
    diagnostics.mode = "sync";
    diagnostics.useful = isUsefulExtraction(result);
    diagnostics.contentTextLength = normalizeText(result.content).length;
    diagnostics.wordCount = result.wordCount;
    return diagnostics.useful ? { result, diagnostics } : { diagnostics };
  } catch (error) {
    diagnostics.mode = diagnostics.mode ?? "sync";
    diagnostics.error = error instanceof Error ? error.message : String(error);
    return { diagnostics };
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Defuddle parseAsync timeout")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

function isUsefulExtraction(result: DefuddleResponse): boolean {
  return normalizeText(result.content).length >= 80 || (result.wordCount ?? 0) >= 20;
}

function extractDefuddleSections(contentHtml: string, title: string, baseUrl: string): KnowledgeDocument["sections"] {
  if (!contentHtml.trim()) {
    return [];
  }
  const contentDocument = parseHTML(`<!doctype html><html><body>${contentHtml}</body></html>`).document;
  cleanDocumentForExtraction(contentDocument);
  const bodyRoot = pickParsedContentRoot(contentDocument);
  if (!bodyRoot) {
    return [];
  }
  normalizeUrls(bodyRoot, baseUrl);
  return extractSections(bodyRoot, title);
}

function pickParsedContentRoot(document: Document): Element | undefined {
  if (document.body && normalizeText(document.body.textContent ?? "")) {
    return document.body;
  }
  return document.documentElement || document.body || undefined;
}

function readPageTitle(document: Document): string | undefined {
  const title = document.querySelector("title")?.textContent?.trim();
  const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim();
  return title || ogTitle || undefined;
}

function readContentTitle(document: Document): string | undefined {
  return document.querySelector("h1")?.textContent?.trim() || undefined;
}

function displayTitleFor(pageTitle: string | undefined, contentTitle: string | undefined, fallback: string): string {
  return pageTitle || contentTitle || fallback;
}

function readAuthors(document: Document, meta: Record<string, string>, defuddleResult?: DefuddleResponse): string[] {
  const author =
    defuddleResult?.author ||
    meta.author ||
    document.querySelector('meta[name="author"]')?.getAttribute("content")?.trim() ||
    document.querySelector('[rel="author"]')?.textContent?.trim();
  return author ? [author] : [];
}

function readPublishedAt(document: Document, meta: Record<string, string>, defuddleResult?: DefuddleResponse): string | null {
  const value =
    defuddleResult?.published ||
    meta["article:published_time"] ||
    meta.published ||
    document.querySelector('meta[property="article:published_time"]')?.getAttribute("content") ||
    document.querySelector("time[datetime]")?.getAttribute("datetime");
  return normalizeDate(value ?? undefined);
}

function readAdapterMetadata(document: Document, adapter: SiteAdapter, key: keyof NonNullable<SiteAdapter["metadata"]>): string | undefined {
  for (const selector of adapter.metadata?.[key] ?? []) {
    const node = document.querySelector(selector);
    if (!node) {
      continue;
    }
    const content = node.getAttribute("content") ||
      node.getAttribute("datetime") ||
      node.getAttribute("src") ||
      node.getAttribute("post-title") ||
      node.getAttribute("author") ||
      node.getAttribute("created-timestamp") ||
      node.getAttribute("data-author") ||
      node.textContent;
    const normalized = normalizeText(content ?? "");
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function readAdapterMetadataList(document: Document, adapter: SiteAdapter, key: keyof NonNullable<SiteAdapter["metadata"]>): string[] {
  for (const selector of adapter.metadata?.[key] ?? []) {
    const values: string[] = [];
    for (const node of document.querySelectorAll(selector)) {
      const content = node.getAttribute("content") ||
        node.getAttribute("datetime") ||
        node.getAttribute("src") ||
        node.getAttribute("post-title") ||
        node.getAttribute("author") ||
        node.getAttribute("created-timestamp") ||
        node.getAttribute("data-author") ||
        node.textContent;
      const normalized = normalizeText(content ?? "");
      if (normalized) {
        values.push(normalized);
      }
    }
    if (values.length > 0) {
      return unique(values);
    }
  }
  return [];
}

function findSchemaArticle(document: Document): Record<string, unknown> | undefined {
  const candidates: Record<string, unknown>[] = [];
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    const text = script.textContent?.trim();
    if (!text) {
      continue;
    }
    try {
      collectJsonLdObjects(JSON.parse(text), candidates);
    } catch {
      // Ignore invalid JSON-LD blocks; other candidates may still be usable.
    }
  }
  return candidates.find((candidate) => {
    const types = arrayValue(candidate["@type"]).map(String);
    return types.some((type) => /^(Article|NewsArticle|BlogPosting|ScholarlyArticle|TechArticle)$/i.test(type));
  });
}

function collectJsonLdObjects(value: unknown, output: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectJsonLdObjects(item, output));
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  output.push(value);
  const graph = value["@graph"];
  if (graph) {
    collectJsonLdObjects(graph, output);
  }
}

function schemaAuthors(value: unknown): string[] {
  return unique(arrayValue(value)
    .map((author) => {
      if (typeof author === "string") {
        return author;
      }
      if (isRecord(author)) {
        return stringValue(author.name);
      }
      return "";
    })
    .filter((author): author is string => Boolean(author)));
}

function schemaImage(value: unknown): string | undefined {
  const first = arrayValue(value)[0];
  if (typeof first === "string") {
    return first;
  }
  if (isRecord(first)) {
    return stringValue(first.url) || stringValue(first.contentUrl);
  }
  return undefined;
}

function schemaKeywords(value: unknown): string[] {
  if (typeof value === "string") {
    return value.split(",").map(normalizeText).filter(Boolean);
  }
  return arrayValue(value).map((item) => String(item)).map(normalizeText).filter(Boolean);
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeText(value) || undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function arrayValue(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  return value === undefined || value === null ? [] : [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeDate(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function pickReadableRoot(document: Document): Element {
  return (
    document.querySelector("article") ||
    document.querySelector("main") ||
    document.querySelector('[role="main"]') ||
    document.body ||
    document.documentElement
  );
}

function parseRawDocument(html: string): Document {
  return parseHTML(html).document;
}

function parseCleanDocument(html: string): Document {
  const { document } = parseHTML(html);
  cleanDocumentForExtraction(document);
  return document;
}

function cleanDocumentForExtraction(document: Document): void {
  const selectors = [
    "script",
    "style",
    "noscript",
    "template",
    "iframe",
    "svg",
    "canvas",
    "form",
    "input",
    "button",
    "select",
    "textarea",
    "nav",
    "header",
    "footer",
    "aside",
    "dialog",
    "[role='navigation']",
    "[role='banner']",
    "[role='complementary']",
    "[role='contentinfo']",
    "[role='dialog']",
    "[role='alertdialog']",
    "[role='menu']",
    "[aria-hidden='true']",
    "[hidden]",
    "[popover]",
    ".modal",
    ".overlay",
    ".popup",
    ".popover",
    ".tooltip",
    ".toast",
    ".drawer",
    ".sidebar",
    ".navbar",
    ".navigation",
    ".menu",
    ".cookie",
    ".cookies",
    ".consent",
    ".banner",
    ".ad",
    ".ads",
    ".advertisement",
    ".share",
    ".social",
    ".subscribe",
    ".newsletter",
    "#modal",
    "#overlay",
    "#popup",
    "#cookie",
    "#cookies",
    "#consent",
    "#banner"
  ];

  document.querySelectorAll(selectors.join(",")).forEach((node) => node.remove());
  document.querySelectorAll("*").forEach((node) => {
    node.removeAttribute("style");
    const className = node.getAttribute("class") ?? "";
    const id = node.getAttribute("id") ?? "";
    if (isLikelyNoise(`${className} ${id}`) && !isReadableSemanticRoot(node)) {
      node.remove();
    }
  });
}

function isReadableSemanticRoot(node: Element): boolean {
  const tagName = node.tagName.toLowerCase();
  return tagName === "main" || tagName === "article" || node.getAttribute("role") === "main";
}

function applyAdapterCleanup(document: Document, adapter: SiteAdapter, baseUrl: string): void {
  for (const selector of adapter.cleanup?.removeSelectors ?? []) {
    document.querySelectorAll(selector).forEach((node) => node.remove());
  }

  for (const selector of adapter.cleanup?.unwrapSelectors ?? []) {
    document.querySelectorAll(selector).forEach((node) => unwrap(node));
  }

  if (adapter.cleanup?.normalizeImageAttributes) {
    normalizeImageAttributes(document);
  }

  if (adapter.cleanup?.normalizeRelativeUrls) {
    normalizeUrls(document.documentElement, baseUrl);
  }
}

function applyMatchedAdapterCleanup(
  document: Document,
  matches: MatchedAdapter[],
  baseUrl: string,
  phase: "defuddle" | "fallback"
): void {
  for (const match of matches) {
    if (phase === "fallback" && match.adapter.hints?.fallbackCleanup === false) {
      continue;
    }
    applyAdapterCleanup(document, match.adapter, baseUrl);
  }
}

function applyDefuddleRootHints(document: Document, matches: MatchedAdapter[]): void {
  const body = document.body;
  if (!body) {
    return;
  }

  for (const match of matches) {
    const selectors = match.adapter.hints?.defuddleRootSelectors ?? match.adapter.content.selectors;
    for (const selector of selectors) {
      const root = document.querySelector(selector);
      if (!root) {
        continue;
      }
      const rootTextLength = normalizeText(root.textContent ?? "").length;
      if (rootTextLength < (match.adapter.content.requireTextLength ?? 0) && !root.querySelector("img,table")) {
        continue;
      }
      body.replaceChildren(root.cloneNode(true));
      return;
    }
  }
}

function applyScopedExcludes(root: Element, selectors: string[]): void {
  for (const selector of selectors) {
    root.querySelectorAll(selector).forEach((node) => node.remove());
  }
}

function unwrap(node: Element): void {
  const parent = node.parentNode;
  if (!parent) {
    return;
  }
  while (node.firstChild) {
    parent.insertBefore(node.firstChild, node);
  }
  node.remove();
}

function normalizeImageAttributes(root: ParentNode): void {
  root.querySelectorAll("img").forEach((img) => {
    const src = imageSourceUrl(img);
    if (src) {
      img.setAttribute("src", src);
    }
  });
}

function imageSourceUrl(img: Element): string | undefined {
  return img.getAttribute("src") ||
    img.getAttribute("data-src") ||
    img.getAttribute("data-original") ||
    img.getAttribute("data-testid-src") ||
    firstSrcsetUrl(img.getAttribute("srcset") || img.getAttribute("data-srcset"));
}

function firstSrcsetUrl(srcset: string | null): string | undefined {
  return srcset?.split(",")[0]?.trim().split(/\s+/)[0];
}

function normalizeUrls(root: ParentNode, baseUrl: string): void {
  normalizeImageAttributes(root);

  root.querySelectorAll("a[href]").forEach((link) => {
    const href = toAbsoluteUrl(link.getAttribute("href"), baseUrl);
    if (href) {
      link.setAttribute("href", href);
    }
  });

  root.querySelectorAll("img[src]").forEach((img) => {
    const src = toAbsoluteUrl(img.getAttribute("src"), baseUrl);
    if (src) {
      img.setAttribute("src", src);
    }
  });
}

function toAbsoluteUrl(value: string | null, baseUrl: string): string | undefined {
  if (!value || value.startsWith("data:")) {
    return value || undefined;
  }
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

function isLikelyNoise(value: string): boolean {
  return /\b(nav|navbar|navigation|menu|sidebar|modal|overlay|popup|popover|tooltip|toast|drawer|cookie|cookies|consent|banner|advert|advertisement|ads?|share|social|subscribe|newsletter|promo|recommend|related|breadcrumb|footer|header|floating|sticky|fixed)\b/i.test(value);
}

const SECTION_NODE_SELECTOR = "h1,h2,h3,h4,h5,h6,p,pre,blockquote,ul,ol,figure,table,img,div";

function extractSections(root: Element, title: string): KnowledgeDocument["sections"] {
  const sections: KnowledgeDocument["sections"] = [];
  const nodes = root.querySelectorAll(SECTION_NODE_SELECTOR);

  for (const node of nodes) {
    const tagName = node.tagName.toLowerCase();
    if (isInsideMediaContainer(node)) {
      continue;
    }
    const text = normalizeText(node.textContent ?? "");
    const hasMedia = tagName === "img" || Boolean(node.querySelector("img"));
    if ((!text && !hasMedia && tagName !== "table") || (text === title && !hasMedia)) {
      continue;
    }

    if (/^h[1-6]$/.test(tagName)) {
      sections.push({
        section_id: makeId(),
        type: "heading",
        level: Number(tagName.slice(1)),
        content: inlineToMarkdown(node)
      });
      continue;
    }

    if (tagName === "ul" || tagName === "ol") {
      const items = [...node.querySelectorAll(":scope > li")]
        .map((li) => inlineToMarkdown(li))
        .filter(Boolean);
      if (items.length > 0) {
        sections.push({ section_id: makeId(), type: "list", items });
      }
      continue;
    }

    if (tagName === "pre") {
      sections.push({ section_id: makeId(), type: "code", content: node.textContent ?? "" });
      continue;
    }

    if (tagName === "blockquote") {
      sections.push({
        section_id: makeId(),
        type: "blockquote",
        content: inlineToMarkdown(node)
      });
      continue;
    }

    if (tagName === "figure" || tagName === "img" || isMediaContainer(node)) {
      const section = figureSectionFromNode(node);
      if (section) {
        sections.push(section);
      }
      continue;
    }

    if (tagName === "table") {
      const rows = [...node.querySelectorAll("tr")]
        .map((row) => [...row.querySelectorAll("th,td")].map((cell) => inlineToMarkdown(cell)))
        .filter((row) => row.length > 0);
      if (rows.length > 0) {
        sections.push({ section_id: makeId(), type: "table", rows });
      }
      continue;
    }

    if (tagName === "div") {
      continue;
    }

    sections.push({
      section_id: makeId(),
      type: "paragraph",
      content: inlineToMarkdown(node)
    });
  }

  return dedupeAdjacent(sections);
}

function isInsideMediaContainer(node: Element): boolean {
  const parent = node.parentElement;
  if (!parent) {
    return false;
  }
  return Boolean(closestMediaContainer(parent));
}

function closestMediaContainer(node: Element): Element | undefined {
  let current: Element | null = node;
  while (current) {
    if (isMediaContainer(current)) {
      return current;
    }
    current = current.parentElement;
  }
  return undefined;
}

function isMediaContainer(node: Element): boolean {
  if (node.tagName.toLowerCase() !== "div" || !node.querySelector("img")) {
    return false;
  }
  if (node.querySelector("h1,h2,h3,h4,h5,h6,ul,ol,table,pre,blockquote")) {
    return false;
  }
  const text = normalizeText(node.textContent ?? "");
  const imageCount = node.querySelectorAll("img").length;
  return imageCount > 0 && text.length <= 240;
}

function figureSectionFromNode(node: Element): KnowledgeDocument["sections"][number] | undefined {
  const tagName = node.tagName.toLowerCase();
  const images = tagName === "img" ? [node] : [...node.querySelectorAll("img")];
  const assets = images
    .map((img) => ({
      asset_id: makeId(),
      source_url: imageSourceUrl(img),
      alt: normalizeText(img.getAttribute("alt") ?? "") || undefined,
      caption: figureCaption(node, img)
    }))
    .filter((asset) => asset.source_url);
  if (assets.length === 0) {
    return undefined;
  }

  const caption = tagName === "img" ? assets[0].caption ?? "" : figureCaption(node, images[0]) ?? "";
  return {
    section_id: makeId(),
    type: "figure",
    content: caption,
    assets
  };
}

function figureCaption(container: Element, image: Element | undefined): string | null {
  const caption = normalizeText(
    container.querySelector("figcaption")?.textContent ??
    container.querySelector(":scope > p")?.textContent ??
    (container.tagName.toLowerCase() === "img"
      ? adjacentFigcaptionText(container)
      : undefined) ??
    image?.getAttribute("alt") ??
    ""
  );
  return caption || null;
}

function adjacentFigcaptionText(image: Element): string | undefined {
  const next = image.nextElementSibling;
  if (next?.tagName.toLowerCase() === "figcaption") {
    return next.textContent ?? undefined;
  }
  const previous = image.previousElementSibling;
  if (previous?.tagName.toLowerCase() === "figcaption") {
    return previous.textContent ?? undefined;
  }
  return undefined;
}

function textToParagraphSections(text: string, title: string): KnowledgeDocument["sections"] {
  return text
    .split(/\n{2,}|\r?\n/)
    .map(normalizeText)
    .filter((paragraph) => paragraph && paragraph !== title)
    .slice(0, 200)
    .map((paragraph) => ({
      section_id: makeId(),
      type: "paragraph" as const,
      content: paragraph
    }));
}

function inlineToMarkdown(node: Element): string {
  return normalizeMarkdown(renderInlineChildren(node));
}

function renderInlineChildren(node: Element): string {
  return [...node.childNodes].map(renderInlineNode).join("");
}

function renderInlineNode(node: ChildNode): string {
  if (node.nodeType === 3) {
    return node.textContent ?? "";
  }

  if (node.nodeType !== 1) {
    return "";
  }

  const element = node as Element;
  const tagName = element.tagName.toLowerCase();
  const content = renderInlineChildren(element);

  if (tagName === "a") {
    const href = element.getAttribute("href");
    const label = normalizeMarkdown(content || href || "");
    return href && label ? `[${escapeMarkdownLinkText(label)}](${href})` : label;
  }

  if (tagName === "img") {
    const src = imageSourceUrl(element);
    const alt = normalizeMarkdown(element.getAttribute("alt") ?? "");
    return src ? `![${escapeMarkdownLinkText(alt)}](${src})` : alt;
  }

  if (tagName === "code") {
    return `\`${content.replace(/`/g, "\\`")}\``;
  }

  if (tagName === "math") {
    const tex = mathText(element);
    if (!tex) {
      return content;
    }
    const display = element.getAttribute("display") === "block" ||
      (element.getAttribute("class") ?? "").includes("ltx_Math_display");
    return display ? `\n$$\n${tex}\n$$\n` : `$${tex}$`;
  }

  if (tagName === "strong" || tagName === "b") {
    return content ? `**${content}**` : "";
  }

  if (tagName === "em" || tagName === "i") {
    return content ? `_${content}_` : "";
  }

  if (tagName === "br") {
    return "\n";
  }

  return content;
}

function mathText(element: Element): string | undefined {
  for (const encoding of ["application/x-tex", "application/x-latex"]) {
    const annotation = element.querySelector(`annotation[encoding="${encoding}"]`);
    const text = normalizeText(annotation?.textContent ?? "");
    if (text) {
      return text;
    }
  }
  const altText = normalizeText(element.getAttribute("alttext") ?? "");
  return altText || undefined;
}

function measureSections(sections: KnowledgeDocument["sections"]): CandidateMetrics {
  const text = sections.map(sectionText).join(" ");
  const textLength = normalizeText(text).length;
  const linkCount = countMatches(text, /\]\(/g);
  return {
    textLength,
    sectionCount: sections.length,
    headingCount: sections.filter((section) => section.type === "heading").length,
    linkCount,
    imageCount: sections.filter((section) => section.type === "figure").length + countMatches(text, /!\[/g),
    tableCount: sections.filter((section) => section.type === "table").length,
    codeCount: sections.filter((section) => section.type === "code").length,
    linkDensity: textLength > 0 ? round(linkCount / Math.max(textLength / 1000, 1)) : 0
  };
}

function sectionText(section: KnowledgeDocument["sections"][number]): string {
  return [
    section.content,
    ...(section.items ?? []).map((item) => typeof item === "string" ? item : item.text),
    ...(section.rows ?? []).flatMap((row) => Array.isArray(row) ? row.map(String) : [String(row)])
  ].filter(Boolean).join(" ");
}

function scoreCandidate(method: ParserMethod, metrics: CandidateMetrics, baseScore: number, warnings: string[]): number {
  if (metrics.textLength === 0) {
    return -100;
  }

  const methodBoost = method === "selection"
    ? 60
    : method === "defuddle"
      ? 20
      : method === "site_adapter"
        ? 35
        : method === "schema_org"
          ? 15
          : method === "rendered_text_fallback"
            ? 5
            : 0;
  const lengthScore = Math.min(metrics.textLength / 20, 80);
  const structureScore = Math.min(metrics.sectionCount * 5, 40) +
    metrics.headingCount * 4 +
    metrics.imageCount * 8 +
    metrics.tableCount * 8 +
    metrics.codeCount * 4;
  const linkPenalty = metrics.linkDensity > 12 ? (metrics.linkDensity - 12) * 3 : 0;
  const shortPenalty = metrics.textLength < 120 && metrics.imageCount === 0 && metrics.tableCount === 0 ? 45 : 0;
  const warningPenalty = warnings.length * 5;
  return baseScore + methodBoost + lengthScore + structureScore - linkPenalty - shortPenalty - warningPenalty;
}

function qualityWarnings(metrics: CandidateMetrics): string[] {
  const warnings: string[] = [];
  if (metrics.sectionCount === 0) {
    warnings.push("No sections extracted.");
  }
  if (metrics.textLength > 0 && metrics.textLength < 120 && metrics.imageCount === 0 && metrics.tableCount === 0) {
    warnings.push("Extracted text is short.");
  }
  if (metrics.linkDensity > 12) {
    warnings.push(`High link density: ${metrics.linkDensity}`);
  }
  return warnings;
}

function collectParserWarnings(selected: ParserCandidate, candidates: ParserCandidate[]): string[] {
  const warnings = [...selected.warnings];
  if (selected.method === "dom_fallback") {
    warnings.push("Generic DOM fallback selected after candidate scoring.");
  }
  if (selected.method === "rendered_text_fallback") {
    warnings.push("Browser rendered text fallback selected after structured extraction failed.");
  }
  if (candidates.some((candidate) => candidate.method === "defuddle") && selected.method !== "defuddle") {
    warnings.push("Defuddle was available but another candidate scored higher.");
  }
  if (candidates.length <= 1) {
    warnings.push("Only one parser candidate was available.");
  }
  return unique(warnings);
}

function buildParserDiagnostics(
  input: ResolvedInput,
  selected: ParserCandidate,
  candidates: ParserCandidate[],
  defuddle: DefuddleRunDiagnostics
): Record<string, unknown> {
  const htmlDiagnostics = summarizeHtmlDiagnostics(input.html);
  const candidateSummary = candidates.map((candidate) => ({
    id: candidate.id,
    method: candidate.method,
    selected: candidate.id === selected.id,
    textLength: candidate.metrics.textLength,
    sectionCount: candidate.metrics.sectionCount,
    score: round(candidate.score),
    warnings: candidate.warnings
  }));

  return {
    input: {
      mode: input.inputMode,
      htmlBytes: Buffer.byteLength(input.html),
      browserTextLength: normalizeText(input.bodyText ?? "").length,
      snapshot: input.snapshotDiagnostics,
      pageTitle: input.pageTitle,
      title: input.title
    },
    cleanup: htmlDiagnostics,
    defuddle,
    selected: {
      id: selected.id,
      method: selected.method,
      adapterId: selected.adapterId,
      reason: selected.reason,
      score: round(selected.score),
      metrics: selected.metrics
    },
    candidates: candidateSummary
  };
}

function summarizeHtmlDiagnostics(html: string): Record<string, unknown> {
  const rawDocument = parseHTML(html).document;
  const cleanedDocument = parseCleanDocument(html);
  const rawRoot = pickReadableRoot(rawDocument);
  const cleanedRoot = pickReadableRoot(cleanedDocument);

  return {
    rawTextLength: normalizeText(rawDocument.body?.textContent ?? "").length,
    cleanedTextLength: normalizeText(cleanedDocument.body?.textContent ?? "").length,
    rawReadableRoot: describeElement(rawRoot),
    cleanedReadableRoot: describeElement(cleanedRoot)
  };
}

function describeElement(element: Element | undefined): Record<string, unknown> | undefined {
  if (!element) {
    return undefined;
  }
  return {
    tag: element.tagName.toLowerCase(),
    id: element.getAttribute("id") || undefined,
    className: element.getAttribute("class") || undefined,
    textLength: normalizeText(element.textContent ?? "").length
  };
}

function emptyMetrics(): CandidateMetrics {
  return {
    textLength: 0,
    sectionCount: 0,
    headingCount: 0,
    linkCount: 0,
    imageCount: 0,
    tableCount: 0,
    codeCount: 0,
    linkDensity: 0
  };
}

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function normalizeMarkdown(value: string): string {
  return value
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function escapeMarkdownLinkText(value: string): string {
  return value.replace(/[[\]]/g, "\\$&");
}

function dedupeAdjacent(sections: KnowledgeDocument["sections"]): KnowledgeDocument["sections"] {
  const result: KnowledgeDocument["sections"] = [];
  for (const section of sections) {
    const previous = result[result.length - 1];
    if (
      previous &&
      previous.type === section.type &&
      previous.content &&
      section.content &&
      previous.content === section.content
    ) {
      continue;
    }
    result.push(section);
  }
  return result;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
