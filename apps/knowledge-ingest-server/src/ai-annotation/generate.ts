import type { KnowledgeDocument, SummaryAnnotation } from "@uknowledge/knowledge-schema";
import type { KnowledgeStore } from "../store.js";
import type { AIAnnotationProvider, AIAnnotationResponse } from "./provider.js";
import type { AIAnnotationResultItem } from "@uknowledge/knowledge-schema";
import { buildScopeText, needsTwoPass, splitIntoChunks } from "./strategy.js";
import { SUMMARY_SYSTEM_PROMPT, CHUNK_SUMMARY_PROMPT } from "./prompt.js";
import { makeId, nowIso } from "@uknowledge/knowledge-schema";

export { SUMMARY_SYSTEM_PROMPT, CHUNK_SUMMARY_PROMPT };

export async function generateSummaries(
  provider: AIAnnotationProvider,
  store: KnowledgeStore,
  document: KnowledgeDocument,
  model: string,
  headingSectionIds: string[],
  force: boolean,
  abortSignal?: AbortSignal
): Promise<AIAnnotationResultItem[]> {
  const sections = document.sections;
  const docId = document.doc_id;
  const existingAnnotations = await store.loadAnnotations(docId);

  const results: AIAnnotationResultItem[] = [];

  for (const sectionId of headingSectionIds) {
    if (abortSignal?.aborted) break;

    const idx = sections.findIndex((s) => s.section_id === sectionId);
    if (idx === -1 || sections[idx].type !== "heading") continue;

    const heading = sections[idx];

    const cached = existingAnnotations.find(
      (a): a is SummaryAnnotation =>
        a.type === "summary" &&
        a.section_id === sectionId &&
        a.ai_model === model &&
        !a.orphaned
    );

    if (cached && !force) {
      results.push({
        type: "summary",
        annotation_id: cached.annotation_id,
        section_id: sectionId,
        heading_text: heading.content ?? "",
        heading_level: heading.level ?? 1,
        content: cached.note,
        ai_model: model,
        hit_cache: true,
        strategy: "single",
      });
      continue;
    }

    const scopeText = buildScopeText(sections, idx);
    const strategy = needsTwoPass(scopeText) ? "two-pass" : "single";

    let response: AIAnnotationResponse;
    if (strategy === "single") {
      response = await provider.generate({
        headingText: `${"#".repeat(heading.level ?? 1)} ${heading.content ?? ""}`,
        headingLevel: heading.level ?? 1,
        scopeText,
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        maxTokens: 500,
        signal: abortSignal,
      });
    } else {
      response = await twoPassSummarize(provider, heading, scopeText, abortSignal);
    }

    const annotationId = makeId();
    await store.saveAnnotation(docId, {
      type: "summary",
      annotation_id: annotationId,
      doc_id: docId,
      section_id: sectionId,
      note: response.text,
      ai_model: response.model,
      created_at: nowIso(),
      updated_at: nowIso(),
    });

    results.push({
      type: "summary",
      annotation_id: annotationId,
      section_id: sectionId,
      heading_text: heading.content ?? "",
      heading_level: heading.level ?? 1,
      content: response.text,
      ai_model: response.model,
      hit_cache: false,
      strategy,
    });
  }

  return results;
}

async function twoPassSummarize(
  provider: AIAnnotationProvider,
  heading: { content?: string; level?: number },
  scopeText: string,
  abortSignal?: AbortSignal
): Promise<AIAnnotationResponse> {
  const chunks = splitIntoChunks(scopeText);

  // Map phase: summarize chunks concurrently
  const chunkResults = await Promise.all(
    chunks.map((chunk) =>
      provider.generate({
        headingText: "",
        headingLevel: 0,
        scopeText: chunk,
        systemPrompt: CHUNK_SUMMARY_PROMPT,
        maxTokens: 150,
        signal: abortSignal,
      })
    )
  );

  const combined = chunkResults
    .map((r, i) => `[段${i + 1}] ${r.text}`)
    .join("\n\n");

  return provider.generate({
    headingText: `${"#".repeat(heading.level ?? 1)} ${heading.content ?? ""}`,
    headingLevel: heading.level ?? 1,
    scopeText: combined,
    systemPrompt: SUMMARY_SYSTEM_PROMPT,
    maxTokens: 500,
    signal: abortSignal,
  });
}
