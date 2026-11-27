import {
  createFeedApiClient,
  FeedApiError,
  feedReaderPath,
  formatScore,
  safeExternalUrl,
  type FeedBriefingDetail,
  type FeedBriefingSummary,
  type FeedCandidates,
  type FeedEntry,
  type FeedEntryState,
  type FeedSource
} from "./feed-client.js";
import { getSettings } from "./settings.js";
import { openKnowledgePage } from "./tabs.js";
import { bindThemeModePreference } from "./theme.js";

type ViewName = "briefing" | "entries" | "settings";

/** What a citation or candidate needs to render its action buttons. */
interface EntryActionTarget {
  entryId: string;
  url: string;
  sectionId?: string;
  state: FeedEntryState;
}

const settings = await getSettings();
bindThemeModePreference(settings.themeMode);
const client = createFeedApiClient(settings);

const notice = mustGet<HTMLElement>("feed-notice");
const runStatus = mustGet<HTMLElement>("run-status");
const runButton = mustGet<HTMLButtonElement>("run-now");
const briefingSelect = mustGet<HTMLSelectElement>("briefing-select");
const briefingState = mustGet<HTMLElement>("briefing-state");
const briefingMeta = mustGet<HTMLElement>("briefing-meta");
const briefingBody = mustGet<HTMLElement>("briefing-body");
const showCandidates = mustGet<HTMLInputElement>("show-candidates");
const entriesSource = mustGet<HTMLSelectElement>("entries-source");
const entriesSelected = mustGet<HTMLSelectElement>("entries-selected");
const entriesCount = mustGet<HTMLElement>("entries-count");
const entriesList = mustGet<HTMLElement>("entries-list");
const entriesMore = mustGet<HTMLButtonElement>("entries-more");
const sourcesList = mustGet<HTMLElement>("sources-list");
const sourceForm = mustGet<HTMLFormElement>("source-form");
const sourceKind = mustGet<HTMLSelectElement>("source-kind");
const sourceTitle = mustGet<HTMLInputElement>("source-title");
const sourceUrl = mustGet<HTMLInputElement>("source-url");
const sourcePatternRow = mustGet<HTMLElement>("source-pattern-row");
const sourcePattern = mustGet<HTMLInputElement>("source-pattern");
const coarseHint = mustGet<HTMLTextAreaElement>("coarse-hint");
const coarseHintMeta = mustGet<HTMLElement>("coarse-hint-meta");
const coarseHintSave = mustGet<HTMLButtonElement>("coarse-hint-save");
const runDetail = mustGet<HTMLElement>("run-detail");

let briefings: FeedBriefingSummary[] = [];
let entriesCursor: string | undefined;
let pollTimer: number | undefined;
let feedAvailable = true;

for (const tab of Array.from(document.querySelectorAll<HTMLButtonElement>(".feed-tab"))) {
  tab.addEventListener("click", () => showView(tab.dataset.view as ViewName));
}
mustGet<HTMLButtonElement>("open-items").addEventListener("click", () => void openKnowledgePage("items.html"));
runButton.addEventListener("click", () => void guarded(triggerRun));
briefingSelect.addEventListener("change", () => void guarded(renderSelectedBriefing));
showCandidates.addEventListener("change", () => void guarded(renderSelectedBriefing));
entriesSource.addEventListener("change", () => void guarded(() => loadEntries(true)));
entriesSelected.addEventListener("change", () => void guarded(() => loadEntries(true)));
entriesMore.addEventListener("click", () => void guarded(() => loadEntries(false)));
sourceKind.addEventListener("change", () => {
  sourcePatternRow.hidden = sourceKind.value !== "listing";
  sourcePattern.required = sourceKind.value === "listing";
});
sourceForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void guarded(addSource);
});
coarseHintSave.addEventListener("click", () => void guarded(saveHint));

await guarded(async () => {
  const running = await refreshStatus();
  await loadBriefings();
  // A fetch started elsewhere (for example by the agent) is followed to completion too.
  if (running) pollTimer = globalThis.setTimeout(() => void guarded(pollRun), 2000);
});

function showView(view: ViewName): void {
  for (const tab of Array.from(document.querySelectorAll<HTMLButtonElement>(".feed-tab"))) {
    tab.setAttribute("aria-selected", String(tab.dataset.view === view));
  }
  for (const name of ["briefing", "entries", "settings"] as const) {
    mustGet<HTMLElement>(`view-${name}`).hidden = name !== view;
  }
  if (!feedAvailable) return;
  if (view === "entries") void guarded(async () => { await loadSourceOptions(); await loadEntries(true); });
  if (view === "settings") void guarded(loadSettingsView);
}

/** Run an action and surface any failure in the notice bar instead of the console. */
async function guarded(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof FeedApiError && error.code === "feed_disabled") {
      feedAvailable = false;
      runButton.disabled = true;
      showNotice("Feed is disabled on this server. Start it with KNOWLEDGE_FEED_ENABLED=true.", "warning", null);
      return;
    }
    showNotice(error instanceof Error ? error.message : String(error), "danger");
  }
}

function showNotice(message: string, tone: "warning" | "danger" = "warning", timeoutMs: number | null = 6000): void {
  notice.textContent = message;
  notice.dataset.tone = tone;
  notice.hidden = false;
  if (timeoutMs !== null) {
    globalThis.setTimeout(() => {
      if (notice.textContent === message) notice.hidden = true;
    }, timeoutMs);
  }
}

// ── run status ──────────────────────────────────────────────────────────────

async function refreshStatus(): Promise<boolean> {
  const status = await client.status();
  runButton.disabled = status.running;
  const run = status.run;
  if (status.running && run) {
    runStatus.textContent = `Fetching… (${String(run.stats.stage ?? "")})`;
  } else if (run) {
    runStatus.textContent = `Last fetch ${formatDateTime(run.finishedAt ?? run.startedAt)} · ${run.state}`;
  } else {
    runStatus.textContent = "No fetch has run yet";
  }
  renderRunDetail(status);
  return status.running;
}

async function triggerRun(): Promise<void> {
  try {
    await client.run(settings.annotatorName?.trim() || "user");
  } catch (error) {
    if (!(error instanceof FeedApiError) || error.code !== "feed_run_in_progress") throw error;
  }
  await pollRun();
}

async function pollRun(): Promise<void> {
  globalThis.clearTimeout(pollTimer);
  const running = await refreshStatus();
  if (running) {
    pollTimer = globalThis.setTimeout(() => void guarded(pollRun), 2000);
    return;
  }
  await loadBriefings();
}

function renderRunDetail(status: Awaited<ReturnType<typeof client.status>>): void {
  runDetail.replaceChildren();
  const add = (label: string, value: string): void => {
    runDetail.append(el("dt", { text: label }), el("dd", { text: value }));
  };
  add("Summary model", status.summaryModel);
  add("Pending briefings", String(status.pendingBriefings));
  const run = status.run;
  if (!run) {
    add("Run", "None yet");
    return;
  }
  add("State", run.state);
  add("Triggered by", run.triggeredBy);
  add("Started", formatDateTime(run.startedAt));
  if (run.finishedAt) add("Finished", formatDateTime(run.finishedAt));
  if (run.error) add("Error", run.error);
  const labels: Array<[string, string]> = [
    ["discovered", "New entries"], ["duplicates", "Duplicates skipped"], ["scored", "Scored"],
    ["selected", "Selected"], ["fetched", "Fetched"], ["fetchFailed", "Fetch failed"],
    ["points", "Points extracted"], ["scoreFailed", "Scoring failed"], ["pointsFailed", "Extraction failed"],
    ["sourcesFailed", "Sources failed"], ["expired", "Expired and removed"]
  ];
  for (const [key, label] of labels) {
    const value = run.stats[key];
    if (typeof value === "number" && (value > 0 || key === "discovered")) add(label, String(value));
  }
}

// ── briefing view ───────────────────────────────────────────────────────────

async function loadBriefings(): Promise<void> {
  const previous = briefingSelect.value;
  briefings = await client.briefings();
  briefingSelect.replaceChildren();
  for (const briefing of briefings) {
    const option = el("option", {
      text: `${briefing.date} · ${briefing.state === "composed" ? "composed" : "awaiting agent"}`
    }) as HTMLOptionElement;
    option.value = briefing.briefingId;
    briefingSelect.append(option);
  }
  if (briefings.some((briefing) => briefing.briefingId === previous)) briefingSelect.value = previous;
  await renderSelectedBriefing();
}

async function renderSelectedBriefing(): Promise<void> {
  const briefing = briefings.find((candidate) => candidate.briefingId === briefingSelect.value);
  briefingBody.replaceChildren();
  if (!briefing) {
    briefingState.textContent = "";
    briefingMeta.textContent = "";
    showCandidates.disabled = true;
    briefingBody.append(el("div", {
      className: "empty-state",
      text: "No briefing yet. Add a source under “Sources & settings”, then choose “Fetch now” or let your agent trigger a fetch."
    }));
    return;
  }

  const composed = briefing.state === "composed";
  showCandidates.disabled = !composed;
  briefingState.textContent = composed ? "Composed" : "Awaiting agent";
  briefingState.dataset.tone = composed ? "" : "warm";
  briefingMeta.textContent = composed
    ? `by ${briefing.composer ?? "unknown"} · ${formatDateTime(briefing.composedAt ?? briefing.preparedAt)} · revision ${briefing.revision}`
    : `${briefing.pointCount} candidate points from ${briefing.entryCount} entries, by coarse score`;

  if (composed && !showCandidates.checked) {
    renderComposed(await client.briefing(briefing.briefingId));
  } else {
    renderCandidates(await client.candidates(briefing.briefingId), composed);
  }
}

function renderComposed(detail: FeedBriefingDetail): void {
  const content = detail.content;
  if (!content) return;
  if (content.summary) briefingBody.append(el("p", { className: "briefing-summary", text: content.summary }));
  for (const topic of content.topics) {
    const section = el("section", { className: "topic" }, [el("h2", { text: topic.title })]);
    if (topic.overview) section.append(el("p", { className: "topic-overview", text: topic.overview }));
    for (const item of topic.items) {
      const text = el("p", { className: "item-text", text: item.text });
      if (item.rewritten) {
        const badge = el("span", { className: "badge", text: "agent wording" });
        badge.dataset.tone = "muted";
        badge.title = "Written by the composing agent; check it against the quotes below.";
        text.append(badge);
      }
      const node = el("div", { className: "briefing-item" }, [text]);
      for (const ref of item.refs) {
        node.append(renderRef(ref.title, ref.quote, {
          entryId: ref.entryId,
          url: ref.url,
          sectionId: ref.sectionId,
          state: detail.entries[ref.entryId] ?? { exists: false, hasDocument: false }
        }));
      }
      section.append(node);
    }
    briefingBody.append(section);
  }
  briefingBody.append(el("p", {
    className: "briefing-meta",
    text: `${content.stats.usedPoints} of ${content.stats.candidatePoints} candidate points used · ${content.stats.selected} entries fetched from ${content.stats.scored} scored`
  }));
}

function renderCandidates(candidates: FeedCandidates, composed: boolean): void {
  if (candidates.entries.length === 0) {
    briefingBody.append(el("div", { className: "empty-state", text: "This briefing has no candidates." }));
    return;
  }
  for (const entry of candidates.entries) {
    const meta = el("div", { className: "candidate-meta" }, [
      el("span", { text: entry.sourceTitle ?? "Unknown source" }),
      el("span", { text: `score ${formatScore(entry.effectiveScore)}` })
    ]);
    if (entry.publishedAt) meta.append(el("span", { text: formatDate(entry.publishedAt) }));
    if (entry.exploration) meta.append(tag("exploration", "Picked by the exploration quota, outside the current hint."));
    if (entry.rescued) meta.append(tag("added by agent", "Requested by the composing agent after the coarse filter skipped it."));
    if (entry.fetchFailed) meta.append(tag("no full text", "The page could not be fetched; only the feed summary is available."));
    const card = el("article", { className: "candidate" }, [
      el("div", { className: "candidate-header" }, [
        el("div", { className: "candidate-title", text: entry.title }),
        meta,
        ...(entry.scoreReason ? [el("div", { className: "entry-reason", text: entry.scoreReason })] : [])
      ])
    ]);
    if (entry.points.length === 0) {
      card.append(renderRef(entry.title, undefined, { entryId: entry.entryId, url: entry.url, state: entry.state }));
    }
    for (const point of entry.points) {
      const text = el("p", { className: "item-text", text: point.text });
      if (composed && point.used) text.append(el("span", { className: "badge", text: "in briefing" }));
      const node = el("div", { className: "candidate-point" }, [
        text,
        renderRef(entry.title, point.quote, {
          entryId: entry.entryId, url: entry.url, sectionId: point.sectionId, state: entry.state
        })
      ]);
      node.dataset.used = String(point.used);
      card.append(node);
    }
    briefingBody.append(card);
  }
  if (candidates.skipped.length > 0) {
    briefingBody.append(el("p", {
      className: "briefing-meta",
      text: `${candidates.skipped.length} more entries were scored but not fetched; see the Entries tab.`
    }));
  }
}

function tag(text: string, title: string): HTMLElement {
  const node = el("span", { className: "badge", text });
  node.dataset.tone = "muted";
  node.title = title;
  return node;
}

/** One citation: quote, source title and the actions available for its entry. */
function renderRef(title: string, quote: string | undefined, target: EntryActionTarget): HTMLElement {
  const node = el("div", { className: "ref" });
  node.dataset.dismissed = String(Boolean(target.state.dismissedAt));
  if (quote) node.append(el("blockquote", { className: "ref-quote", text: quote }));
  const actions = el("div", { className: "ref-actions" });
  const state = target.state;

  if (state.promotedItemId) {
    const saved = el("a", { text: "In library" }) as HTMLAnchorElement;
    saved.href = `reader.html?itemId=${encodeURIComponent(state.promotedItemId)}`;
    saved.target = "_blank";
    actions.append(saved);
  } else if (state.exists && state.hasDocument) {
    const read = el("a", { text: target.sectionId ? "Read passage" : "Read" }) as HTMLAnchorElement;
    read.href = feedReaderPath(target.entryId, target.sectionId);
    read.target = "_blank";
    actions.append(read);
  }

  const originalUrl = safeExternalUrl(target.url);
  if (originalUrl) {
    const original = el("a", { text: "Original" }) as HTMLAnchorElement;
    original.href = originalUrl;
    original.target = "_blank";
    original.rel = "noopener noreferrer";
    if (state.exists) {
      original.addEventListener("click", () => void client.signal(target.entryId, "open_original").catch(() => undefined));
    }
    actions.append(original);
  }

  if (state.exists && !state.promotedItemId) {
    const save = el("button", { text: "Save to library" }) as HTMLButtonElement;
    save.type = "button";
    save.addEventListener("click", () => void guarded(async () => {
      save.disabled = true;
      save.textContent = "Saving…";
      try {
        await client.star(target.entryId);
      } finally {
        save.disabled = false;
        save.textContent = "Save to library";
      }
      await renderSelectedBriefing();
    }));
    actions.append(save);
    if (!state.dismissedAt) {
      const dismiss = el("button", { text: "Dismiss" }) as HTMLButtonElement;
      dismiss.type = "button";
      dismiss.addEventListener("click", () => void guarded(async () => {
        await client.dismiss(target.entryId);
        await renderSelectedBriefing();
      }));
      actions.append(dismiss);
    }
  }
  if (!state.exists && !state.promotedItemId) actions.append(tag("expired", "This entry has been removed from the feed."));

  node.append(el("div", { className: "ref-source" }, [el("span", { className: "ref-title", text: title }), actions]));
  return node;
}

// ── entries view ────────────────────────────────────────────────────────────

async function loadSourceOptions(): Promise<void> {
  const current = entriesSource.value;
  const sources = await client.sources();
  entriesSource.replaceChildren(optionNode("", "All sources"));
  for (const source of sources) entriesSource.append(optionNode(source.sourceId, source.title));
  entriesSource.value = sources.some((source) => source.sourceId === current) ? current : "";
}

async function loadEntries(reset: boolean): Promise<void> {
  if (reset) {
    entriesCursor = undefined;
    entriesList.replaceChildren();
  }
  const result = await client.entries({
    sourceId: entriesSource.value || undefined,
    selected: entriesSelected.value === "" ? undefined : entriesSelected.value === "true",
    cursor: entriesCursor
  });
  entriesCursor = result.nextCursor;
  entriesMore.hidden = !result.nextCursor;
  entriesCount.textContent = `${result.total} entries`;
  if (result.total === 0) {
    entriesList.append(el("div", { className: "empty-state", text: "No entries match this filter." }));
    return;
  }
  for (const entry of result.entries) entriesList.append(renderEntryRow(entry));
}

function renderEntryRow(entry: FeedEntry): HTMLElement {
  const meta = el("div", { className: "entry-meta" }, [
    el("span", { text: entry.sourceTitle ?? "Unknown source" }),
    el("span", { text: `score ${formatScore(entry.effectiveScore)}` }),
    el("span", { text: entryStageLabel(entry) }),
    el("span", { text: `expires ${formatDate(entry.expiresAt)}` })
  ]);
  const row = el("article", { className: "entry-row" }, [
    el("div", { className: "entry-title", text: entry.title }),
    meta
  ]);
  if (entry.scoreReason) row.append(el("div", { className: "entry-reason", text: entry.scoreReason }));
  if (entry.lastError) row.append(el("div", { className: "source-error", text: entry.lastError }));
  row.append(renderRef(entry.title, undefined, {
    entryId: entry.entryId,
    url: entry.url,
    state: {
      exists: true,
      hasDocument: entry.hasDocument,
      promotedItemId: entry.promotedItemId,
      dismissedAt: entry.dismissedAt
    }
  }));
  return row;
}

function entryStageLabel(entry: FeedEntry): string {
  if (entry.stage === "discovered") return "not scored yet";
  if (entry.stage === "fetch_failed") return "fetch failed";
  if (!entry.selected) return "not selected";
  return entry.stage === "fetched" ? "full text fetched" : "selected";
}

// ── settings view ───────────────────────────────────────────────────────────

async function loadSettingsView(): Promise<void> {
  const [sources, feedSettings] = await Promise.all([client.sources(), client.settings()]);
  renderSources(sources);
  coarseHint.value = feedSettings.coarseHint;
  coarseHintMeta.textContent = feedSettings.updatedAt
    ? `Last changed by ${feedSettings.updatedBy ?? "unknown"} on ${formatDateTime(feedSettings.updatedAt)}`
    : "Not set";
  await refreshStatus();
}

function renderSources(sources: FeedSource[]): void {
  sourcesList.replaceChildren();
  if (sources.length === 0) {
    sourcesList.append(el("div", { className: "empty-state", text: "No sources yet." }));
    return;
  }
  for (const source of sources) {
    const enabled = el("input") as HTMLInputElement;
    enabled.type = "checkbox";
    enabled.checked = source.enabled;
    enabled.addEventListener("change", () => void guarded(async () => {
      await client.updateSource(source.sourceId, { enabled: enabled.checked });
    }));

    const weight = el("input") as HTMLInputElement;
    weight.type = "number";
    weight.min = "0";
    weight.max = "2";
    weight.step = "0.1";
    weight.value = String(source.weight);
    weight.addEventListener("change", () => void guarded(async () => {
      const value = Math.min(2, Math.max(0, Number(weight.value)));
      if (!Number.isFinite(value)) return;
      weight.value = String(value);
      await client.updateSource(source.sourceId, { weight: value });
    }));

    const remove = el("button", { className: "danger-button", text: "Delete" }) as HTMLButtonElement;
    remove.type = "button";
    remove.addEventListener("click", () => void guarded(async () => {
      if (!globalThis.confirm(`Delete “${source.title}” and its feed entries? Saved library items are kept.`)) return;
      await client.deleteSource(source.sourceId);
      await loadSettingsView();
    }));

    const stats = source.stats;
    const meta = el("div", { className: "source-meta" }, [
      el("span", { text: source.kind === "rss" ? "RSS / Atom" : `Listing · ${source.linkPattern ?? ""}` }),
      el("span", { text: source.lastRunAt ? `last fetched ${formatDateTime(source.lastRunAt)}` : "never fetched" }),
      ...(source.createdBy ? [el("span", { text: `added by ${source.createdBy}` })] : []),
      ...(source.updatedBy ? [el("span", { text: `last changed by ${source.updatedBy}` })] : [])
    ]);
    const row = el("article", { className: "source-row" }, [
      el("div", { className: "entry-title", text: source.title }),
      el("div", { className: "source-url", text: source.url }),
      meta
    ]);
    if (stats) {
      row.append(el("div", {
        className: "source-meta",
        text: `30 days: ${stats.discovered} discovered · ${stats.selected} fetched · ${stats.briefed} in briefings · ${stats.opened} opened · ${stats.starred} saved · ${stats.dismissed} dismissed`
      }));
    }
    if (source.lastError) row.append(el("div", { className: "source-error", text: source.lastError }));
    row.append(el("div", { className: "source-controls" }, [
      el("label", { className: "toggle" }, [enabled, document.createTextNode("Enabled")]),
      el("label", { className: "toggle" }, [document.createTextNode("Weight"), weight]),
      remove
    ]));
    sourcesList.append(row);
  }
}

async function addSource(): Promise<void> {
  await client.addSource({
    kind: sourceKind.value === "listing" ? "listing" : "rss",
    title: sourceTitle.value.trim(),
    url: sourceUrl.value.trim(),
    linkPattern: sourceKind.value === "listing" ? sourcePattern.value.trim() : undefined
  });
  sourceForm.reset();
  sourcePatternRow.hidden = true;
  sourcePattern.required = false;
  await loadSettingsView();
}

async function saveHint(): Promise<void> {
  const saved = await client.saveSettings(coarseHint.value);
  coarseHint.value = saved.coarseHint;
  coarseHintMeta.textContent = `Last changed by ${saved.updatedBy ?? "unknown"} on ${formatDateTime(saved.updatedAt ?? "")}`;
}

// ── DOM helpers ─────────────────────────────────────────────────────────────

/** Build an element. Text always goes through textContent: feed content is untrusted. */
function el(
  tagName: string,
  props: { className?: string; text?: string } = {},
  children: Array<Node> = []
): HTMLElement {
  const node = document.createElement(tagName);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  node.append(...children);
  return node;
}

function optionNode(value: string, label: string): HTMLOptionElement {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

function mustGet<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}
