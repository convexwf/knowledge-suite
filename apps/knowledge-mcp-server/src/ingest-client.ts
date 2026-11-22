// ingest-client.ts — HTTP client for knowledge-ingest-server API
const BASE_URL = process.env.KNOWLEDGE_BASE_URL ?? "http://127.0.0.1:18765";
const TOKEN = process.env.KNOWLEDGE_TOKEN ?? "dev-token";
const TIMEOUT_MS = Number(
  process.env.KNOWLEDGE_REQUEST_TIMEOUT_MS ?? 30000,
);
const IMPORT_TIMEOUT_MS = Number(
  process.env.KNOWLEDGE_IMPORT_TIMEOUT_MS ?? 300000,
);

export interface SearchParams {
  query: string;
  limit?: number;
  docId?: string;
  url?: string;
  parserMethod?: string;
  trace?: boolean;
  category?: string;
}

export interface ContextParams {
  query: string;
  limit?: number;
  maxChars?: number;
  docId?: string;
  url?: string;
  parserMethod?: string;
  trace?: boolean;
  category?: string;
}

export interface KnowledgePageSnapshot {
  pageUrl: string;
  canonicalUrl?: string;
  pageTitle?: string;
  title?: string;
  html: string;
  text?: string;
  diagnostics?: {
    htmlLength: number;
    textLength: number;
    shadowRootCount: number;
  };
  capturedAt: string;
  meta?: Record<string, string>;
  selectionHtml?: string;
}

export interface KnowledgeCollectionTarget {
  title: string;
  rootUrl: string;
  strategy?: "create" | "update";
  collectionId?: string;
  orderIndex?: number;
  depth?: number;
  source?: string;
}

export type KnowledgePageInput =
  | {
      inputMode: "server_fetch";
      url: string;
      candidateId?: string;
      overwrite?: boolean;
      category?: string;
      collection?: KnowledgeCollectionTarget;
    }
  | {
      inputMode: "browser_html";
      snapshot: KnowledgePageSnapshot;
      candidateId?: string;
      overwrite?: boolean;
      category?: string;
      collection?: KnowledgeCollectionTarget;
    };

export interface CaptureKnowledgePageParams {
  url: string;
  waitMs?: number;
  candidateId?: string;
  category?: string;
  collection?: KnowledgeCollectionTarget;
  tabId?: number;
  keepOpen?: boolean;
}

export interface DiscoverKnowledgeLinksParams {
  url: string;
  waitMs?: number;
  keepOpen?: boolean;
  scope?: {
    sameOrigin?: boolean;
    pathPrefix?: string;
    maxItems?: number;
  };
}

export interface BatchCandidateInput {
  url: string;
  text?: string;
  titleHint?: string;
  source?: string;
  order?: number;
  depth?: number;
}

export interface BatchDiscoverParams {
  pageUrl: string;
  candidates: BatchCandidateInput[];
  scope?: {
    sameOrigin?: boolean;
    pathPrefix?: string;
    maxItems?: number;
  };
}

export interface BatchJobCreateParams {
  sourcePageUrl: string;
  category?: string;
  mode?: "server_fetch";
  collection: {
    title: string;
    rootUrl: string;
    strategy?: "create" | "update";
    collectionId?: string;
  };
  urls?: string[];
  items?: BatchCandidateInput[];
  options?: {
    skipExisting?: boolean;
    maxConcurrency?: number;
  };
}

export interface EpubImportParams {
  fileName: string;
  fileBase64: string;
  sourceUri?: string;
  titleHint?: string;
  tags?: string[];
  category?: string;
  metadataOpfBase64?: string;
  coverBase64?: string;
  coverFileName?: string;
  coverMediaType?: string;
}

export interface MarkdownAssetImportParams {
  relativePath: string;
  fileBase64: string;
  mediaType?: string;
}

export interface MarkdownImportParams {
  fileName: string;
  fileBase64: string;
  sourceUri?: string;
  relativePath?: string;
  tags?: string[];
  category?: string;
  assets?: MarkdownAssetImportParams[];
}

export interface GitHubMarkdownParams {
  owner: string;
  repo: string;
  ref: string;
  path: string;
  tags?: string[];
  category?: string;
}

export interface StructuredImportParams {
  provider: string;
  platform: string;
  itemId: string;
  url: string;
  canonicalUrl?: string;
  title: string;
  authors?: string[];
  publishedAt?: string;
  language?: string;
  tags?: string[];
  category?: string;
  markdown: string;
  comments?: Array<Record<string, unknown>>;
  media?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
  commentsMode?: "append" | "none";
  overwrite?: boolean;
}

export interface CategoryListResponse {
  categories: string[];
  defaultCategory: "default";
}

export interface HighlightInput {
  text: string;
  sectionId?: string;
  note?: string;
  color?: string;
}

export interface AddHighlightsParams {
  docId: string;
  category?: string;
  authorName: string;
  authorColor?: string;
  highlights: HighlightInput[];
  dryRun?: boolean;
}

export interface AddHighlightsResponse {
  docId: string;
  added: number;
  wouldAdd: number;
  alreadyPresent: number;
  skipped: number;
  dryRun: boolean;
  results: Array<{
    index: number;
    status: "added" | "would_add" | "already_present" | "not_found" | "ambiguous" | "failed";
    text: string;
    annotationIds?: string[];
    sectionIds?: string[];
    candidateSectionIds?: string[];
    message?: string;
  }>;
}

export interface NoteAnnotationInput {
  note: string;
  text?: string;
  sectionId?: string;
}

export interface AddNotesParams {
  docId: string;
  category?: string;
  authorName: string;
  authorColor?: string;
  annotations: NoteAnnotationInput[];
  dryRun?: boolean;
}

export interface AddNotesResponse {
  docId: string;
  added: number;
  wouldAdd: number;
  alreadyPresent: number;
  skipped: number;
  dryRun: boolean;
  results: Array<{
    index: number;
    status: "added" | "would_add" | "already_present" | "not_found" | "ambiguous" | "unsupported" | "failed";
    note: string;
    annotationId?: string;
    sectionId?: string;
    message?: string;
  }>;
}

interface IngestSearchResponse {
  query: string;
  retriever: string;
  results: Array<Record<string, unknown>>;
}

interface IngestContextResponse {
  query: string;
  retriever: string;
  packer: string;
  budget: { maxChars: number; usedChars: number };
  contextText: string;
  citations: Array<Record<string, unknown>>;
}

interface HighlightableDocument {
  doc_id: string;
  sections: Array<{
    section_id?: string;
    content?: string;
    items?: Array<string | { text: string; items?: string[] }>;
  }>;
}

interface ExistingAnnotation {
  annotation_id: string;
  section_id: string;
  type: string;
  text_ref?: string | null;
  note?: string | null;
  created_by?: { name?: string };
}

interface SavedAnnotationResponse {
  saved: boolean;
  annotation_id: string;
}

export async function listKnowledgeCategories(): Promise<CategoryListResponse> {
  const url = new URL("/api/categories", BASE_URL);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ingest server returned ${res.status}: ${body}`);
  }
  return res.json() as Promise<CategoryListResponse>;
}

export async function searchKnowledge(
  params: SearchParams,
): Promise<IngestSearchResponse> {
  const url = new URL("/api/search", BASE_URL);
  url.searchParams.set("q", params.query);
  if (params.limit != null) url.searchParams.set("limit", String(params.limit));
  if (params.docId) url.searchParams.set("docId", params.docId);
  if (params.url) url.searchParams.set("url", params.url);
  if (params.parserMethod)
    url.searchParams.set("parserMethod", params.parserMethod);
  if (params.trace) url.searchParams.set("trace", "true");
  if (params.category) url.searchParams.set("category", params.category);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ingest server returned ${res.status}: ${body}`);
  }

  return res.json() as Promise<IngestSearchResponse>;
}

export async function getKnowledgeContext(
  params: ContextParams,
): Promise<IngestContextResponse> {
  const url = new URL("/api/context", BASE_URL);
  url.searchParams.set("q", params.query);
  if (params.limit != null) url.searchParams.set("limit", String(params.limit));
  if (params.maxChars != null)
    url.searchParams.set("maxChars", String(params.maxChars));
  if (params.docId) url.searchParams.set("docId", params.docId);
  if (params.url) url.searchParams.set("url", params.url);
  if (params.parserMethod)
    url.searchParams.set("parserMethod", params.parserMethod);
  if (params.trace) url.searchParams.set("trace", "true");
  if (params.category) url.searchParams.set("category", params.category);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ingest server returned ${res.status}: ${body}`);
  }

  return res.json() as Promise<IngestContextResponse>;
}

export async function getKnowledgeCaptureStatus(): Promise<unknown> {
  return getJson<unknown>("/api/capture/status");
}

export async function previewKnowledgePage(input: KnowledgePageInput): Promise<unknown> {
  return postJson<unknown>("/api/ingest/preview", input, IMPORT_TIMEOUT_MS);
}

export async function saveKnowledgePage(input: KnowledgePageInput): Promise<unknown> {
  return postJson<unknown>("/api/ingest/save", input, IMPORT_TIMEOUT_MS);
}

export async function saveKnowledgePageToCollection(
  input: KnowledgePageInput & { collection: KnowledgeCollectionTarget }
): Promise<unknown> {
  return postJson<unknown>("/api/collections/pages", input, IMPORT_TIMEOUT_MS);
}

export async function captureKnowledgePage(params: CaptureKnowledgePageParams): Promise<unknown> {
  return postJson<unknown>("/api/capture", {
    ...params,
    mode: "document",
    save: true,
  }, IMPORT_TIMEOUT_MS);
}

export async function discoverKnowledgeLinks(params: DiscoverKnowledgeLinksParams): Promise<unknown> {
  return postJson<unknown>("/api/capture", {
    ...params,
    mode: "links",
    save: false,
  }, IMPORT_TIMEOUT_MS);
}

export async function reparseKnowledgePage(url: string, category?: string): Promise<unknown> {
  return postJson<unknown>("/api/ingest/reparse", { url, ...(category ? { category } : {}) }, IMPORT_TIMEOUT_MS);
}

export async function importEpubFile(params: EpubImportParams): Promise<unknown> {
  const form = new FormData();
  form.append("file", blobFromBase64(params.fileBase64, "application/epub+zip"), params.fileName);
  form.append("sourceUri", params.sourceUri?.trim() || params.fileName);
  if (params.titleHint?.trim()) form.append("titleHint", params.titleHint.trim());
  if (params.tags?.length) form.append("tags", params.tags.join(","));
  if (params.category) form.append("category", params.category);
  if (params.metadataOpfBase64) {
    form.append("metadataOpf", blobFromBase64(params.metadataOpfBase64, "application/xml"), "metadata.opf");
  }
  if (params.coverBase64) {
    form.append(
      "cover",
      blobFromBase64(params.coverBase64, params.coverMediaType ?? "image/jpeg"),
      params.coverFileName ?? "cover.jpg",
    );
  }
  return postForm<unknown>("/api/import/epub", form, IMPORT_TIMEOUT_MS);
}

export async function importMarkdownFile(params: MarkdownImportParams): Promise<unknown> {
  if (params.assets?.length && !params.relativePath?.trim()) {
    throw new Error("relativePath is required when Markdown assets are supplied");
  }
  const form = new FormData();
  form.append("file", blobFromBase64(params.fileBase64, "text/markdown"), params.fileName);
  form.append("sourceUri", params.sourceUri?.trim() || params.fileName);
  if (params.relativePath?.trim()) form.append("relativePath", params.relativePath.trim());
  if (params.tags?.length) form.append("tags", params.tags.join(","));
  if (params.category) form.append("category", params.category);
  for (const asset of params.assets ?? []) {
    form.append("assetPath", asset.relativePath);
    form.append(
      "asset",
      blobFromBase64(asset.fileBase64, asset.mediaType ?? "application/octet-stream"),
      asset.relativePath,
    );
  }
  return postForm<unknown>("/api/import/markdown", form, IMPORT_TIMEOUT_MS);
}

export async function scanGitHubMarkdown(params: GitHubMarkdownParams): Promise<unknown> {
  return postJson<unknown>("/api/import/github/markdown/scan", params, IMPORT_TIMEOUT_MS);
}

export async function importGitHubMarkdown(params: GitHubMarkdownParams): Promise<unknown> {
  return postJson<unknown>("/api/import/github/markdown", params, IMPORT_TIMEOUT_MS);
}

export async function importStructuredContent(params: StructuredImportParams): Promise<unknown> {
  return postJson<unknown>("/api/import/structured", params, IMPORT_TIMEOUT_MS);
}

export async function discoverKnowledgeBatch(params: BatchDiscoverParams): Promise<unknown> {
  return postJson<unknown>("/api/batch/discover", params, IMPORT_TIMEOUT_MS);
}

export async function createKnowledgeBatchJob(params: BatchJobCreateParams): Promise<unknown> {
  return postJson<unknown>("/api/batch/jobs", params, IMPORT_TIMEOUT_MS);
}

export async function getKnowledgeBatchJob(jobId: string, category?: string): Promise<unknown> {
  return getJson<unknown>(withQuery(`/api/batch/jobs/${encodeURIComponent(jobId)}`, { category }));
}

export async function cancelKnowledgeBatchJob(jobId: string, category?: string): Promise<unknown> {
  return postJson<unknown>(withQuery(`/api/batch/jobs/${encodeURIComponent(jobId)}/cancel`, { category }), {});
}

export async function retryKnowledgeBatchJob(jobId: string, category?: string): Promise<unknown> {
  return postJson<unknown>(withQuery(`/api/batch/jobs/${encodeURIComponent(jobId)}/retry`, { category }), {}, IMPORT_TIMEOUT_MS);
}

export async function reparseKnowledgeFileItem(itemId: string, category?: string): Promise<unknown> {
  return postJson<unknown>(withQuery(`/api/items/${encodeURIComponent(itemId)}/reparse`, { category }), {}, IMPORT_TIMEOUT_MS);
}

export async function checkGitHubMarkdownUpdate(itemId: string, category?: string): Promise<unknown> {
  return getJson<unknown>(withQuery(`/api/items/${encodeURIComponent(itemId)}/update-status`, { category }));
}

export async function refreshGitHubMarkdownItem(itemId: string, category?: string): Promise<unknown> {
  return postJson<unknown>(withQuery(`/api/items/${encodeURIComponent(itemId)}/refresh`, { category }), {}, IMPORT_TIMEOUT_MS);
}

export async function listKnowledgeItems(params: {
  sourceType?: string;
  category?: string;
  tag?: string;
  limit?: number;
} = {}): Promise<unknown> {
  return getJson<unknown>(withQuery("/api/items", {
    sourceType: params.sourceType,
    category: params.category,
    tag: params.tag,
    limit: params.limit,
  }));
}

export async function getKnowledgeItem(itemId: string, category?: string): Promise<unknown> {
  return getJson<unknown>(withQuery(`/api/items/${encodeURIComponent(itemId)}`, { category }));
}

export async function deleteKnowledgeItem(params: {
  itemId: string;
  mode?: "remove" | "purge";
  category?: string;
}): Promise<unknown> {
  return deleteJson<unknown>(withQuery(`/api/items/${encodeURIComponent(params.itemId)}`, {
    mode: params.mode,
    category: params.category,
  }));
}

export async function getKnowledgeDocument(docId: string, category?: string): Promise<unknown> {
  return getJson<unknown>(withQuery(`/api/documents/${encodeURIComponent(docId)}`, { category }));
}

export async function getKnowledgeOutline(docId: string, category?: string): Promise<unknown> {
  return getJson<unknown>(withQuery(`/api/documents/${encodeURIComponent(docId)}/outline`, { category }));
}

export async function getKnowledgeAnnotations(itemId: string, category?: string): Promise<unknown> {
  return getJson<unknown>(withQuery(`/api/items/${encodeURIComponent(itemId)}/annotations`, { category }));
}

export async function getKnowledgeReadingProgress(itemId: string, category?: string): Promise<unknown> {
  return getJson<unknown>(withQuery(`/api/items/${encodeURIComponent(itemId)}/reading-progress`, { category }));
}

export async function setKnowledgeReadingProgress(params: {
  itemId: string;
  sectionId: string | null;
  expectedRevision: number;
  category?: string;
}): Promise<unknown> {
  return putJson<unknown>(
    withQuery(`/api/items/${encodeURIComponent(params.itemId)}/reading-progress`, { category: params.category }),
    { section_id: params.sectionId, expected_revision: params.expectedRevision },
  );
}

export async function listKnowledgeTags(category?: string): Promise<unknown> {
  return getJson<unknown>(withQuery("/api/tags", { category }));
}

export async function listKnowledgeCollections(limit?: number, category?: string): Promise<unknown> {
  return getJson<unknown>(withQuery("/api/collections", { limit, category }));
}

export async function addKnowledgeHighlights(
  params: AddHighlightsParams,
): Promise<AddHighlightsResponse> {
  const docId = params.docId.trim();
  if (!docId) throw new Error("docId is required");
  const authorName = requireAuthorName(params.authorName);
  const authorColor = resolveAuthorColor(authorName, params.authorColor);
  if (params.highlights.length === 0) {
    throw new Error("At least one highlight is required");
  }
  if (params.highlights.length > 100) {
    throw new Error("A maximum of 100 highlights can be added per request");
  }

  const document = await getJson<HighlightableDocument>(
    withQuery(`/api/documents/${encodeURIComponent(docId)}`, { category: params.category }),
  );
  if (document.doc_id !== docId) {
    throw new Error(`Document ${docId} was not found`);
  }
  const annotationFile = await getJson<{ annotations: ExistingAnnotation[] }>(
    withQuery(`/api/documents/${encodeURIComponent(docId)}/annotations`, { category: params.category }),
  );
  const existing = new Set(
    annotationFile.annotations
      .filter((annotation) => annotation.type === "highlight" && annotation.text_ref)
      .map((annotation) => `${annotation.section_id}\u0000${annotation.text_ref}`),
  );

  const results: AddHighlightsResponse["results"] = [];
  let added = 0;
  let wouldAdd = 0;
  let alreadyPresent = 0;

  for (const [index, highlight] of params.highlights.entries()) {
    const text = highlight.text.trim();
    if (!text) {
      results.push({ index, status: "not_found", text: highlight.text, message: "Highlight text is empty" });
      continue;
    }

    const occurrences = findHighlightOccurrences(document, text, highlight.sectionId);
    if (occurrences.length === 0) {
      results.push({ index, status: "not_found", text, message: "Text did not match a document section" });
      continue;
    }
    if (occurrences.length > 1) {
      results.push({
        index,
        status: "ambiguous",
        text,
        candidateSectionIds: [...new Set(occurrences.flatMap((occurrence) => occurrence.map((match) => match.sectionId)))],
        message: "Text matched more than one location; provide sectionId or a more specific excerpt",
      });
      continue;
    }

    const matches = occurrences[0];
    const annotationIds: string[] = [];
    const sectionIds = [...new Set(matches.map((match) => match.sectionId))];
    if (params.dryRun) {
      const missingMatches = matches.filter(
        (match) => !existing.has(`${match.sectionId}\u0000${match.textRef}`),
      );
      if (missingMatches.length === 0) {
        alreadyPresent += 1;
        results.push({ index, status: "already_present", text, sectionIds });
      } else {
        wouldAdd += 1;
        results.push({ index, status: "would_add", text, sectionIds });
      }
      continue;
    }

    let failedMessage: string | undefined;
    let addedThisExcerpt = false;

    for (const match of matches) {
      const key = `${match.sectionId}\u0000${match.textRef}`;
      if (existing.has(key)) continue;

      const annotationId = crypto.randomUUID();
      const now = new Date().toISOString();
      const annotation = {
        annotation_id: annotationId,
        doc_id: docId,
        section_id: match.sectionId,
        type: "highlight",
        text_ref: match.textRef,
        color: highlight.color ?? authorColor,
        created_by: { name: authorName, source: "mcp", color: authorColor },
        ...(highlight.note ? { note: highlight.note } : {}),
        created_at: now,
        updated_at: now,
      };

      try {
        const saved = await postJson<SavedAnnotationResponse>(
          withQuery(`/api/documents/${encodeURIComponent(docId)}/annotations`, { category: params.category }),
          annotation,
        );
        existing.add(key);
        if (!saved.saved) continue;
        annotationIds.push(annotationId);
        addedThisExcerpt = true;
      } catch (error) {
        failedMessage = error instanceof Error ? error.message : String(error);
        break;
      }
    }

    if (failedMessage) {
      results.push({ index, status: "failed", text, annotationIds, sectionIds, message: failedMessage });
    } else if (addedThisExcerpt) {
      added += 1;
      results.push({ index, status: "added", text, annotationIds, sectionIds });
    } else {
      alreadyPresent += 1;
      results.push({ index, status: "already_present", text, sectionIds });
    }
  }

  return {
    docId,
    added,
    wouldAdd,
    alreadyPresent,
    skipped: results.length - added - wouldAdd - alreadyPresent,
    dryRun: params.dryRun === true,
    results,
  };
}

export async function addKnowledgeNotes(
  params: AddNotesParams,
): Promise<AddNotesResponse> {
  const docId = params.docId.trim();
  if (!docId) throw new Error("docId is required");
  const authorName = requireAuthorName(params.authorName);
  const authorColor = resolveAuthorColor(authorName, params.authorColor);
  if (params.annotations.length === 0) {
    throw new Error("At least one annotation is required");
  }
  if (params.annotations.length > 100) {
    throw new Error("A maximum of 100 annotations can be added per request");
  }

  const document = await getJson<HighlightableDocument>(
    withQuery(`/api/documents/${encodeURIComponent(docId)}`, { category: params.category }),
  );
  if (document.doc_id !== docId) {
    throw new Error(`Document ${docId} was not found`);
  }
  const annotationFile = await getJson<{ annotations: ExistingAnnotation[] }>(
    withQuery(`/api/documents/${encodeURIComponent(docId)}/annotations`, { category: params.category }),
  );
  const existing = new Set(
    annotationFile.annotations
      .filter((annotation) => annotation.type === "note")
      .map((annotation) => `${annotation.section_id}\u0000${annotation.text_ref ?? ""}\u0000${annotation.note ?? ""}\u0000${normalizeAuthorIdentity(annotation.created_by?.name ?? "convexwf")}`),
  );

  const results: AddNotesResponse["results"] = [];
  let added = 0;
  let wouldAdd = 0;
  let alreadyPresent = 0;

  for (const [index, input] of params.annotations.entries()) {
    const note = input.note.trim();
    if (!note) {
      results.push({ index, status: "not_found", note: input.note, message: "Annotation text is empty" });
      continue;
    }

    let sectionId = input.sectionId;
    let textRef: string | undefined;
    if (input.text?.trim()) {
      const occurrences = findHighlightOccurrences(document, input.text.trim(), input.sectionId);
      if (occurrences.length === 0) {
        results.push({ index, status: "not_found", note, message: "Selected text did not match a document section" });
        continue;
      }
      if (occurrences.length > 1) {
        results.push({ index, status: "ambiguous", note, message: "Selected text matched more than one location" });
        continue;
      }
      if (occurrences[0].length !== 1) {
        results.push({
          index,
          status: "unsupported",
          note,
          message: "A note selection must fit within one section; pass a shorter excerpt",
        });
        continue;
      }
      sectionId = occurrences[0][0].sectionId;
      textRef = occurrences[0][0].textRef;
    }

    if (!sectionId || !document.sections.some((section) => section.section_id === sectionId)) {
      results.push({ index, status: "not_found", note, message: "A valid sectionId is required for a section-level annotation" });
      continue;
    }

    const key = `${sectionId}\u0000${textRef ?? ""}\u0000${note}\u0000${normalizeAuthorIdentity(authorName)}`;
    if (existing.has(key)) {
      alreadyPresent += 1;
      results.push({ index, status: "already_present", note, sectionId });
      continue;
    }
    if (params.dryRun) {
      wouldAdd += 1;
      results.push({ index, status: "would_add", note, sectionId });
      continue;
    }

    const annotationId = crypto.randomUUID();
    const now = new Date().toISOString();
    const annotation = {
      annotation_id: annotationId,
      doc_id: docId,
      section_id: sectionId,
      type: "note",
      note,
      ...(textRef ? { text_ref: textRef } : {}),
      color: authorColor,
      created_by: { name: authorName, source: "mcp", color: authorColor },
      created_at: now,
      updated_at: now,
    };

    try {
      const saved = await postJson<SavedAnnotationResponse>(
        withQuery(`/api/documents/${encodeURIComponent(docId)}/annotations`, { category: params.category }),
        annotation,
      );
      existing.add(key);
      if (!saved.saved) {
        alreadyPresent += 1;
        results.push({ index, status: "already_present", note, sectionId });
        continue;
      }
      added += 1;
      results.push({ index, status: "added", note, annotationId, sectionId });
    } catch (error) {
      results.push({
        index,
        status: "failed",
        note,
        sectionId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    docId,
    added,
    wouldAdd,
    alreadyPresent,
    skipped: results.length - added - wouldAdd - alreadyPresent,
    dryRun: params.dryRun === true,
    results,
  };
}

const AUTHOR_COLORS = ["#a5d8ff", "#b2f2bb", "#d0bfff", "#ffc9c9", "#ffec99", "#99e9f2"];

function requireAuthorName(value: string): string {
  const name = value?.trim();
  if (!name) throw new Error("authorName is required");
  if (name.length > 80) throw new Error("authorName must be 80 characters or fewer");
  return name;
}

function resolveAuthorColor(authorName: string, value?: string): string {
  if (value !== undefined) {
    if (!/^#[0-9a-f]{6}$/i.test(value.trim())) {
      throw new Error("authorColor must be a six-digit hex color such as #fff2a8");
    }
    return value.trim().toLowerCase();
  }
  if (normalizeAuthorIdentity(authorName) === "convexwf") return "#fff2a8";
  let hash = 0;
  for (const character of normalizeAuthorIdentity(authorName)) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return AUTHOR_COLORS[hash % AUTHOR_COLORS.length];
}

function normalizeAuthorIdentity(name: string): string {
  return name.trim().toLocaleLowerCase();
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(new URL(path, BASE_URL), {
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ingest server returned ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

function withQuery(path: string, values: Record<string, string | number | undefined>): string {
  const url = new URL(path, BASE_URL);
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function postJson<T>(path: string, body: unknown, timeoutMs = TIMEOUT_MS): Promise<T> {
  const res = await fetch(new URL(path, BASE_URL), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const responseBody = await res.text();
    throw new Error(`ingest server returned ${res.status}: ${responseBody}`);
  }
  return res.json() as Promise<T>;
}

async function postForm<T>(path: string, form: FormData, timeoutMs = TIMEOUT_MS): Promise<T> {
  const res = await fetch(new URL(path, BASE_URL), {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN },
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const responseBody = await res.text();
    throw new Error(`ingest server returned ${res.status}: ${responseBody}`);
  }
  return res.json() as Promise<T>;
}

function blobFromBase64(encoded: string, mediaType: string): Blob {
  const normalized = encoded.replace(/\s+/g, "");
  if (!normalized || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)) {
    throw new Error("fileBase64 must contain valid, non-empty base64 data");
  }
  const bytes = Buffer.from(normalized, "base64");
  const arrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(arrayBuffer).set(bytes);
  return new Blob([arrayBuffer], { type: mediaType });
}

async function putJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(new URL(path, BASE_URL), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const responseBody = await res.text();
    throw new Error(`ingest server returned ${res.status}: ${responseBody}`);
  }
  return res.json() as Promise<T>;
}

async function deleteJson<T>(path: string): Promise<T> {
  const res = await fetch(new URL(path, BASE_URL), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const responseBody = await res.text();
    throw new Error(`ingest server returned ${res.status}: ${responseBody}`);
  }
  return res.json() as Promise<T>;
}

interface HighlightMatch {
  sectionId: string;
  textRef: string;
}

function findHighlightOccurrences(
  document: HighlightableDocument,
  text: string,
  sectionId?: string,
): HighlightMatch[][] {
  const parts: Array<{ sectionId: string; text: string }> = [];
  const sections = document.sections.filter(
    (section) => section.section_id && (!sectionId || section.section_id === sectionId),
  );

  for (const section of sections) {
    const sectionParts = [section.content ?? "", ...(section.items ?? []).flatMap(collectListText)];
    for (const part of sectionParts) {
      if (part) parts.push({ sectionId: section.section_id!, text: part });
    }
  }

  const normalizedNeedle = normalizeWithOffsets(text).text;
  if (!normalizedNeedle) return [];

  let searchableText = "";
  const sourceMap: Array<{ partIndex: number; start: number; end: number } | null> = [];
  for (const [partIndex, part] of parts.entries()) {
    if (searchableText) {
      searchableText += " ";
      sourceMap.push(null);
    }
    const normalizedPart = normalizeWithOffsets(part.text);
    searchableText += normalizedPart.text;
    for (let index = 0; index < normalizedPart.text.length; index += 1) {
      sourceMap.push({
        partIndex,
        start: normalizedPart.starts[index],
        end: normalizedPart.ends[index],
      });
    }
  }

  const offsets = findOccurrences(searchableText, normalizedNeedle);
  return offsets.map((offset) => {
    const matchMap = sourceMap.slice(offset, offset + normalizedNeedle.length);
    const matches: HighlightMatch[] = [];
    let groupStart = 0;

    while (groupStart < matchMap.length) {
      const first = matchMap[groupStart];
      if (!first) {
        groupStart += 1;
        continue;
      }
      let groupEnd = groupStart + 1;
      while (groupEnd < matchMap.length && matchMap[groupEnd]?.partIndex === first.partIndex) {
        groupEnd += 1;
      }
      const last = matchMap[groupEnd - 1];
      const part = parts[first.partIndex];
      if (last && part) {
        const textRef = part.text.slice(first.start, last.end);
        if (textRef) matches.push({ sectionId: part.sectionId, textRef });
      }
      groupStart = groupEnd;
    }

    return matches;
  }).filter((matches) => matches.length > 0);
}

function collectListText(item: string | { text: string; items?: string[] }): string[] {
  if (typeof item === "string") return [item];
  return [item.text, ...(item.items ?? [])];
}

function findOccurrences(haystack: string, needle: string): number[] {
  const offsets: number[] = [];
  let offset = haystack.indexOf(needle);
  while (offset !== -1) {
    offsets.push(offset);
    offset = haystack.indexOf(needle, offset + 1);
  }
  return offsets;
}

function normalizeWithOffsets(value: string): { text: string; starts: number[]; ends: number[] } {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let index = 0;

  while (index < value.length) {
    if (/\s/.test(value[index])) {
      const start = index;
      while (index < value.length && /\s/.test(value[index])) index += 1;
      if (text.length > 0 && text[text.length - 1] !== " ") {
        text += " ";
        starts.push(start);
        ends.push(index);
      }
      continue;
    }

    const codePoint = value.codePointAt(index)!;
    const character = String.fromCodePoint(codePoint);
    text += character;
    for (let offset = 0; offset < character.length; offset += 1) {
      starts.push(index + offset);
      ends.push(index + offset + 1);
    }
    index += character.length;
  }

  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    starts.pop();
    ends.pop();
  }
  return { text, starts, ends };
}
