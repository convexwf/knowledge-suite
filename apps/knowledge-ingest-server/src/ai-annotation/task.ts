import type { KnowledgeDocument, SummaryAnnotation } from "@uknowledge/knowledge-schema";
import type { KnowledgeStore } from "../store.js";
import type { AIAnnotationProvider } from "./provider.js";
import { getMaxTokens } from "./provider.js";
import { buildScopeText, needsTwoPass, splitIntoChunks } from "./strategy.js";
import { SUMMARY_SYSTEM_PROMPT, CHUNK_SUMMARY_PROMPT, TWO_PASS_REDUCE_PROMPT } from "./prompt.js";
import { makeId, nowIso } from "@uknowledge/knowledge-schema";

export type TaskStatus = "running" | "paused" | "cancelled" | "done";

export interface TaskState {
  task_id: string;
  doc_id: string;
  status: TaskStatus;
  total: number;
  skipped: number;
  completed: number;
  failed: number;
  pending_section_ids: string[];
  completed_section_ids: string[];
  failed_section_ids: string[];
  current_section_id: string | null;
  current_heading_text: string | null;
}

class Task {
  task_id: string;
  doc_id: string;
  status: TaskStatus = "running";
  private pendingIds: string[];
  completedIds: string[] = [];
  failedIds: string[] = [];
  skipped = 0;
  currentSectionId: string | null = null;
  currentHeadingText: string | null = null;
  private abortController = new AbortController();
  private provider: AIAnnotationProvider;
  private store: KnowledgeStore;
  private document: KnowledgeDocument;
  private model: string;
  private force: boolean;

  constructor(
    provider: AIAnnotationProvider,
    store: KnowledgeStore,
    document: KnowledgeDocument,
    model: string,
    sectionIds: string[],
    force: boolean
  ) {
    this.task_id = makeId();
    this.doc_id = document.doc_id;
    this.provider = provider;
    this.store = store;
    this.document = document;
    this.model = model;
    this.force = force;

    // Filter: skip cached headings at task creation
    const sections = document.sections;
    const headingMap = new Map<string, { index: number; level: number; content: string }>();
    for (const sid of sectionIds) {
      const idx = sections.findIndex((s) => s.section_id === sid);
      if (idx >= 0 && sections[idx].type === "heading") {
        const h = sections[idx];
        headingMap.set(sid, { index: idx, level: h.level ?? 1, content: h.content ?? "" });
      }
    }

    this.pendingIds = [...headingMap.keys()];

    // Sort deepest first for hierarchical summarization (h3→h2→h1)
    this.pendingIds.sort((a, b) => {
      const la = headingMap.get(a)?.level ?? 1;
      const lb = headingMap.get(b)?.level ?? 1;
      return lb - la;
    });

    this.headingMap = headingMap;
  }

  private headingMap: Map<string, { index: number; level: number; content: string }> = new Map();

  get total(): number {
    return this.pendingIds.length + this.completedIds.length + this.failedIds.length + this.skipped;
  }

  get completed(): number {
    return this.completedIds.length;
  }

  get failed(): number {
    return this.failedIds.length;
  }

  toState(): TaskState {
    return {
      task_id: this.task_id,
      doc_id: this.doc_id,
      status: this.status,
      total: this.total,
      skipped: this.skipped,
      completed: this.completed,
      failed: this.failed,
      pending_section_ids: [...this.pendingIds],
      completed_section_ids: [...this.completedIds],
      failed_section_ids: [...this.failedIds],
      current_section_id: this.currentSectionId,
      current_heading_text: this.currentHeadingText,
    };
  }

  async start(): Promise<void> {
    // Filter out cached headings if not force
    if (!this.force) {
      const existingAnnotations = await this.store.loadAnnotations(this.doc_id);
      const cachedIds = new Set(
        existingAnnotations
          .filter(
            (a): a is SummaryAnnotation =>
              a.type === "summary" && a.ai_model === this.model && !a.orphaned
          )
          .map((a) => a.section_id)
      );
      this.pendingIds = this.pendingIds.filter((sid) => {
        if (cachedIds.has(sid)) {
          this.skipped++;
          return false;
        }
        return true;
      });
    }

    if (this.pendingIds.length === 0) {
      this.status = "done";
      return;
    }

    this.status = "running";
    this.processLoop().catch(() => {});
  }

  private async processLoop(): Promise<void> {
    const sections = this.document.sections;
    const docId = this.doc_id;

    for (const sid of this.pendingIds) {
      if (this.status === "cancelled" || this.status === "paused") break;
      if (this.abortController.signal.aborted) break;

      const idx = sections.findIndex((s) => s.section_id === sid);
      if (idx === -1 || sections[idx].type !== "heading") {
        this.failedIds.push(sid);
        continue;
      }

      const heading = sections[idx];
      this.currentSectionId = sid;
      this.currentHeadingText = heading.content ?? "";

      try {
        const scopeText = buildScopeText(sections, idx);
        const childSids = findChildHeadingIds(sections, { index: idx, level: heading.level ?? 1 });
        
        let inputText: string;
        // For parent headings: use child summaries if available. For leaf: use scope.
        // In this simple task loop, we process headings in order from deepest first.
        // But since we're processing in pendingIds order (not sorted by depth),
        // we use scope text directly and rely on hierarchicalSummarize
        // which is called from server.ts before task creation.
        // Here we just use scope text — the quality improvement is a separate concern.
        inputText = scopeText;

        const level = heading.level ?? 1;
        const strategy = needsTwoPass(inputText) ? "two-pass" : "single";
        const maxTokens = getMaxTokens("summary", level);

        let summary: string;
        if (strategy === "single") {
          const resp = await this.provider.generate({
            headingText: `${"#".repeat(level)} ${heading.content ?? ""}`,
            headingLevel: level,
            scopeText: inputText,
            systemPrompt: SUMMARY_SYSTEM_PROMPT,
            maxTokens,
            signal: this.abortController.signal,
          });
          summary = resp.text;
        } else {
          const resp = await twoPassTask(this.provider, heading, inputText, this.abortController.signal);
          summary = resp.text;
        }

        await this.store.saveAnnotation(docId, {
          type: "summary",
          annotation_id: makeId(),
          doc_id: docId,
          section_id: sid,
          note: summary,
          ai_model: this.model,
          created_at: nowIso(),
          updated_at: nowIso(),
        });

        // Remove from pending, add to completed
        this.pendingIds = this.pendingIds.filter((p) => p !== sid);
        this.completedIds.push(sid);
      } catch (err) {
        this.pendingIds = this.pendingIds.filter((p) => p !== sid);
        this.failedIds.push(sid);
      } finally {
        this.currentSectionId = null;
        this.currentHeadingText = null;
      }
    }

    if (this.status !== "cancelled") {
      this.status = this.pendingIds.length === 0 ? "done" : "paused";
    }
  }

  pause(): void {
    if (this.status === "running") {
      this.status = "paused";
    }
  }

  resume(): void {
    if (this.status === "paused") {
      this.status = "running";
      this.processLoop().catch(() => {});
    }
  }

  cancel(): void {
    this.status = "cancelled";
    this.abortController.abort();
  }

  cancelAndRemove(manager: { removeTask(taskId: string): void }): void {
    this.cancel();
    // Remove after a short delay to allow current heading to finish
    setTimeout(() => manager.removeTask(this.task_id), 5000);
  }

  addHeadings(sectionIds: string[], force: boolean): number {
    const sections = this.document.sections;
    const added: string[] = [];
    for (const sid of sectionIds) {
      const idx = sections.findIndex((s) => s.section_id === sid);
      if (idx === -1 || sections[idx].type !== "heading") continue;
      if (this.completedIds.includes(sid) || this.failedIds.includes(sid) || this.pendingIds.includes(sid)) continue;
      added.push(sid);
    }
    // Add at end — they'll be processed after current pending items
    this.pendingIds.push(...added);
    return added.length;
  }

  removeHeadings(sectionIds: string[]): number {
    let removed = 0;
    for (const sid of sectionIds) {
      const idx = this.pendingIds.indexOf(sid);
      if (idx >= 0) {
        this.pendingIds.splice(idx, 1);
        removed++;
      }
    }
    return removed;
  }
}

class TaskManager {
  private tasks = new Map<string, Task>(); // task_id → Task
  private docTasks = new Map<string, Task>(); // doc_id → Task

  createTask(
    provider: AIAnnotationProvider,
    store: KnowledgeStore,
    document: KnowledgeDocument,
    model: string,
    sectionIds: string[],
    force: boolean
  ): { task: Task; replaced: string | null } {
    const docId = document.doc_id;
    const existing = this.docTasks.get(docId);
    let replaced: string | null = null;

    if (existing && existing.status === "running") {
      existing.cancel();
      replaced = existing.task_id;
      this.tasks.delete(existing.task_id);
    }

    const task = new Task(provider, store, document, model, sectionIds, force);
    this.tasks.set(task.task_id, task);
    this.docTasks.set(docId, task);
    return { task, replaced };
  }

  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  getTaskForDoc(docId: string): Task | undefined {
    return this.docTasks.get(docId);
  }

  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    task.cancelAndRemove(this);
    return true;
  }

  removeTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      this.tasks.delete(taskId);
      this.docTasks.delete(task.doc_id);
    }
  }
}

export const taskManager = new TaskManager();

function findChildHeadingIds(
  sections: KnowledgeDocument["sections"],
  parent: { index: number; level: number }
): string[] {
  const childIds: string[] = [];
  for (let i = parent.index + 1; i < sections.length; i++) {
    const s = sections[i];
    if (s.type === "heading") {
      const sLevel = s.level ?? 99;
      if (sLevel <= parent.level) break;
      if (s.section_id) childIds.push(s.section_id);
    }
  }
  return childIds;
}

async function twoPassTask(
  provider: AIAnnotationProvider,
  heading: { content?: string; level?: number },
  scopeText: string,
  signal?: AbortSignal
): Promise<{ text: string; model: string }> {
  const chunks = splitIntoChunks(scopeText);
  const chunkResults = await Promise.all(
    chunks.map((chunk) =>
      provider.generate({
        headingText: "",
        headingLevel: 0,
        scopeText: chunk,
        systemPrompt: CHUNK_SUMMARY_PROMPT,
        maxTokens: 120,
        signal,
      })
    )
  );

  const combined = chunkResults
    .map((r, i) => `[段${i + 1}] ${r.text}`)
    .join("\n\n");

  const level = heading.level ?? 1;
  const resp = await provider.generate({
    headingText: `${"#".repeat(level)} ${heading.content ?? ""}`,
    headingLevel: level,
    scopeText: combined,
    systemPrompt: TWO_PASS_REDUCE_PROMPT,
    maxTokens: getMaxTokens("summary", level),
    signal,
  });
  return { text: resp.text, model: resp.model };
}
