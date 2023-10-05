import type { DocumentSection, KnowledgeDocument, SummaryAnnotation } from "@uknowledge/knowledge-schema";
import type { KnowledgeStore } from "../store.js";
import type { AIAnnotationProvider, AIAnnotationResponse } from "./provider.js";
import type { AIAnnotationResultItem } from "@uknowledge/knowledge-schema";
import { getMaxTokens } from "./provider.js";
import { buildScopeText, needsTwoPass, splitIntoChunks } from "./strategy.js";
import { SUMMARY_SYSTEM_PROMPT, CHUNK_SUMMARY_PROMPT, TWO_PASS_REDUCE_PROMPT } from "./prompt.js";
import { makeId, nowIso } from "@uknowledge/knowledge-schema";

export { SUMMARY_SYSTEM_PROMPT, CHUNK_SUMMARY_PROMPT, TWO_PASS_REDUCE_PROMPT };

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

  // Build heading index: section_id → { index, level, content }
  const headingMap = new Map<string, { index: number; level: number; content: string }>();
  for (const sid of headingSectionIds) {
    const idx = sections.findIndex((s) => s.section_id === sid);
    if (idx === -1 || sections[idx].type !== "heading") continue;
    const h = sections[idx];
    headingMap.set(sid, { index: idx, level: h.level ?? 1, content: h.content ?? "" });
  }

  // Check cache for all headings first
  const results: AIAnnotationResultItem[] = [];
  const summaries = new Map<string, string>(); // section_id → summary text

  for (const [sid, heading] of headingMap) {
    const cached = existingAnnotations.find(
      (a): a is SummaryAnnotation =>
        a.type === "summary" &&
        a.section_id === sid &&
        a.ai_model === model &&
        !a.orphaned
    );
    if (cached && !force) {
      summaries.set(sid, cached.note);
      results.push({
        type: "summary",
        annotation_id: cached.annotation_id,
        section_id: sid,
        heading_text: heading.content,
        heading_level: heading.level,
        content: cached.note,
        ai_model: model,
        hit_cache: true,
        strategy: "single",
      });
    }
  }

  // Process remaining: deepest levels first
  const pending = [...headingMap.entries()]
    .filter(([sid]) => !summaries.has(sid))
    .sort((a, b) => b[1].level - a[1].level); // deepest first

  for (const [sid, heading] of pending) {
    if (abortSignal?.aborted) break;

    // Find child headings within this heading's scope
    const childSids = findChildHeadingIds(sections, heading, headingMap);
    const scopeText = buildScopeText(sections, heading.index);

    let inputText: string;
    if (childSids.length === 0 || !needsTwoPass(scopeText)) {
      // Leaf or short scope: use original text directly
      inputText = scopeText;
    } else {
      // Parent with children: build intro + child summaries
      inputText = buildParentInput(sections, heading, childSids, summaries);
    }

    const strategy = needsTwoPass(inputText) ? "two-pass" : "single";
    const maxTokens = getMaxTokens("summary", heading.level);

    let response: AIAnnotationResponse;
    if (strategy === "single") {
      response = await provider.generate({
        headingText: `${"#".repeat(heading.level)} ${heading.content}`,
        headingLevel: heading.level,
        scopeText: inputText,
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        maxTokens,
        signal: abortSignal,
      });
    } else {
      response = await twoPassSummarize(provider, heading, inputText, abortSignal);
    }

    summaries.set(sid, response.text);

    const annotationId = makeId();
    await store.saveAnnotation(docId, {
      type: "summary",
      annotation_id: annotationId,
      doc_id: docId,
      section_id: sid,
      note: response.text,
      ai_model: response.model,
      created_at: nowIso(),
      updated_at: nowIso(),
    });

    results.push({
      type: "summary",
      annotation_id: annotationId,
      section_id: sid,
      heading_text: heading.content,
      heading_level: heading.level,
      content: response.text,
      ai_model: response.model,
      hit_cache: false,
      strategy,
    });
  }

  return results;
}

function findChildHeadingIds(
  sections: DocumentSection[],
  parent: { index: number; level: number },
  headingMap: Map<string, { index: number; level: number; content: string }>
): string[] {
  const childIds: string[] = [];
  for (let i = parent.index + 1; i < sections.length; i++) {
    const s = sections[i];
    if (s.type === "heading") {
      const sLevel = s.level ?? 99;
      if (sLevel <= parent.level) break;
      if (s.section_id && headingMap.has(s.section_id)) {
        childIds.push(s.section_id);
      }
    }
  }
  return childIds;
}

function buildParentInput(
  sections: DocumentSection[],
  heading: { index: number; level: number },
  childSids: string[],
  summaries: Map<string, string>
): string {
  const headingText = `${"#".repeat(heading.level)} ${sections[heading.index].content ?? ""}`;

  // Intro: text between this heading and first child heading
  const introParts: string[] = [headingText];
  const firstChildIdx = sections.findIndex(
    (s, i) => i > heading.index && s.type === "heading" && childSids.includes(s.section_id ?? "")
  );
  const endIdx = firstChildIdx > 0 ? firstChildIdx : sections.length;

  for (let i = heading.index + 1; i < endIdx; i++) {
    const s = sections[i];
    if (s.type === "heading" && (s.level ?? 99) <= heading.level) break;
    if (s.type === "paragraph" && s.content) {
      introParts.push(s.content);
    }
  }

  // Child summaries
  const childParts = childSids
    .filter((sid) => summaries.has(sid))
    .map((sid) => {
      const childInfo = [...headingMapIter(sections, sid)];
      const label = childInfo.length > 0
        ? childInfo[0].content.slice(0, 30)
        : sid.slice(0, 8);
      return `[子节: ${label}] ${summaries.get(sid)}`;
    });

  return [...introParts, ...childParts].join("\n\n");
}

function* headingMapIter(
  sections: DocumentSection[],
  sid: string
): Generator<{ content: string }> {
  const idx = sections.findIndex((s) => s.section_id === sid);
  if (idx >= 0) yield { content: sections[idx].content ?? "" };
}

async function twoPassSummarize(
  provider: AIAnnotationProvider,
  heading: { content?: string; level?: number },
  scopeText: string,
  abortSignal?: AbortSignal
): Promise<AIAnnotationResponse> {
  const chunks = splitIntoChunks(scopeText);

  const chunkResults = await Promise.all(
    chunks.map((chunk) =>
      provider.generate({
        headingText: "",
        headingLevel: 0,
        scopeText: chunk,
        systemPrompt: CHUNK_SUMMARY_PROMPT,
        maxTokens: 120,
        signal: abortSignal,
      })
    )
  );

  const combined = chunkResults
    .map((r, i) => `[段${i + 1}] ${r.text}`)
    .join("\n\n");

  const level = heading.level ?? 1;
  return provider.generate({
    headingText: `${"#".repeat(level)} ${heading.content ?? ""}`,
    headingLevel: level,
    scopeText: combined,
    systemPrompt: TWO_PASS_REDUCE_PROMPT,
    maxTokens: getMaxTokens("summary", level),
    signal: abortSignal,
  });
}
