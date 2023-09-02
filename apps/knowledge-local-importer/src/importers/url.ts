import {
  documentToMarkdown,
  KnowledgeStore,
  parsePage,
  resolveClipInput,
  type ServerConfig
} from "@uknowledge/knowledge-ingest-server/local-import-api.js";
import { normalizeUrlForKnowledge, urlHash } from "@uknowledge/knowledge-schema";
import { ImportOptions, ReportItem, UrlCandidate } from "../types.js";

export async function importUrl(
  store: KnowledgeStore | undefined,
  candidate: UrlCandidate,
  options: ImportOptions,
  config: ServerConfig
): Promise<ReportItem> {
  const normalizedUrl = normalizeUrlForKnowledge(candidate.url);
  const identityHash = urlHash(normalizedUrl);
  const itemId = `url:sha256:${identityHash}`;
  if (options.dryRun) {
    return {
      type: "url",
      url: candidate.url,
      state: "candidate",
      itemId,
      identityHash
    };
  }
  if (!store) {
    throw new Error("Knowledge store is required for import");
  }
  if (options.skipExisting && (await store.status(normalizedUrl)).state === "parsed") {
    return {
      type: "url",
      url: candidate.url,
      state: "skipped",
      itemId,
      identityHash,
      errorCode: "already_exists",
      errorMessage: "URL item already exists and is parsed"
    };
  }

  const resolved = await resolveClipInput({ inputMode: "server_fetch", url: candidate.url }, config);
  const parsed = await parsePage(resolved);
  parsed.document.meta.tags = [...new Set([...(parsed.document.meta.tags ?? []), ...options.tags])];
  parsed.rawdoc.metadata = {
    ...parsed.rawdoc.metadata,
    localImportSource: "url_list",
    tags: options.tags
  };
  const markdown = documentToMarkdown(parsed.document);
  const paths = await store.save({
    normalizedUrl: resolved.normalizedUrl,
    html: resolved.html,
    rawdoc: parsed.rawdoc,
    document: parsed.document,
    markdown
  });
  return {
    type: "url",
    url: candidate.url,
    state: "imported",
    itemId,
    identityHash,
    rawdocId: parsed.rawdoc.rawdoc_id,
    docId: parsed.document.doc_id,
    paths
  };
}
