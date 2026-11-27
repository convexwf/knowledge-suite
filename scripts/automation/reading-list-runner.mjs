#!/usr/bin/env node
// Import the articles recommended in docs/agent-risk-finance-reading-list.zh-CN.md
// into Knowledge Suite, one collection per top-level section of that document.
//
// The document is the source list: links are read from it on every run, so
// editing the document changes what the next run imports. Entries that point
// at a site index (blog home, archive, tag page) are skipped by default;
// collecting a whole blog needs a per-site runner like the ones next to this file.
//
// Unlike those runners this one talks to Knowledge Suite directly, because it
// only needs single pages and no list expansion in a browser:
//   relay  – POST /api/capture: the Knowledge Capture Relay extension opens the
//            page in Chrome and sends the rendered DOM. Needs the host in the
//            relay allow-list.
//   fetch  – POST /api/collections/pages with server_fetch: plain HTTP from the server.
//   auto   – relay when the extension is connected and allows the host, else fetch.
//
// Usage: node scripts/automation/reading-list-runner.mjs [options]
//   --dry-run            Preview every page and report; save nothing
//   --capture <mode>     auto | relay | fetch (default auto)
//   --section <text>     Only sections whose title contains <text>
//   --include-index      Also import site index pages
//   --category <name>    Registered category to save into (default: default)
//   --limit <n>          Stop after n pages
//   --server <url>       Knowledge Suite base URL (default $KNOWLEDGE_SERVER_URL or http://127.0.0.1:18765)
//   --token <token>      API token (default $KNOWLEDGE_TOKEN or dev-token)
// Exit code: 0 all pages ok, 1 at least one page failed or was rejected.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const suiteRoot = resolve(scriptDir, "../..");
const DOC_PATH = join(suiteRoot, "docs", "agent-risk-finance-reading-list.zh-CN.md");
const DOC_URL = "https://github.com/convexwf/knowledge-suite/blob/master/docs/agent-risk-finance-reading-list.zh-CN.md";
const COLLECTION_PREFIX = "阅读清单";
const SOURCE = "agent-risk-finance-reading-list";
const runtimeDir = join(suiteRoot, "tmp", "automation", "reading-list");
const logFile = join(runtimeDir, "runner.jsonl");

// A page shorter than this after parsing is treated as blocked or empty, not as an article.
const MIN_ARTICLE_CHARS = 800;
const REQUEST_TIMEOUT_MS = 120000;
// Hosts whose article body is rendered by JavaScript: a plain server fetch
// returns only part of the page, so a fetch result there is flagged.
const RENDERED_HOSTS = new Set(["bigquant.com"]);
const INDEX_PATH_NAMES = new Set([
  "blog", "posts", "writing", "archive", "research", "insights", "wiki", "doc", "updates",
  "foundation", "coding-agents", "hello-agents", "agents", "jingdongkeji", "zh",
]);

export function parseArgs(argv) {
  const args = {
    dryRun: false,
    capture: "auto",
    section: undefined,
    includeIndex: false,
    category: "default",
    limit: undefined,
    server: process.env.KNOWLEDGE_SERVER_URL || "http://127.0.0.1:18765",
    token: process.env.KNOWLEDGE_TOKEN || "dev-token",
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--include-index") args.includeIndex = true;
    else if (arg === "--capture") args.capture = argv[++index];
    else if (arg === "--section") args.section = argv[++index];
    else if (arg === "--category") args.category = argv[++index];
    else if (arg === "--limit") args.limit = Number(argv[++index]);
    else if (arg === "--server") args.server = argv[++index];
    else if (arg === "--token") args.token = argv[++index];
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!["auto", "relay", "fetch"].includes(args.capture)) {
    throw new Error("--capture must be auto, relay or fetch");
  }
  if (args.limit !== undefined && !(Number.isInteger(args.limit) && args.limit > 0)) {
    throw new Error("--limit must be a positive integer");
  }
  args.server = String(args.server).replace(/\/+$/, "");
  return args;
}

/** True for site entry points (home, archive, tag pages) rather than single articles. */
export function isIndexPage(value) {
  const segments = new URL(value).pathname.split("/").filter(Boolean);
  if (segments.length === 0) return true;
  return INDEX_PATH_NAMES.has(segments[segments.length - 1].toLowerCase());
}

/**
 * Read the list entries of the document. Only the reading sections are used;
 * the evaluation notes at the end contain links that are not reading material.
 */
export function parseReadingList(markdown) {
  const entries = [];
  const seen = new Set();
  let section;
  let group;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^(#{2,4})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (heading[1].length === 2) {
        section = heading[2];
        group = undefined;
      } else {
        group = heading[2];
      }
      continue;
    }
    if (!section || /^(文档信息|目录|整理口径|Knowledge 与 adapter 评估)$/.test(section)) continue;
    const item = /^-\s+\[(.+?)\]\((https:\/\/[^)\s]+)\)\s*[：:]?\s*(.*)$/.exec(line);
    if (!item) continue;
    const url = item[2];
    if (seen.has(url)) continue;
    seen.add(url);
    entries.push({
      section,
      group,
      title: item[1],
      url,
      note: item[3] || undefined,
      kind: isIndexPage(url) ? "index" : "article",
    });
  }
  return entries;
}

function sectionSlug(section) {
  // Collections are identified by their root URL; the fragment is dropped when
  // URLs are normalised, so the section goes into the query string.
  return encodeURIComponent(section);
}

export function collectionTarget(entry, orderIndex) {
  return {
    title: `${COLLECTION_PREFIX} · ${entry.section}`,
    rootUrl: `${DOC_URL}?section=${sectionSlug(entry.section)}`,
    strategy: "create",
    orderIndex,
    depth: 1,
    source: entry.group ? `${SOURCE}: ${entry.group}` : SOURCE,
  };
}

async function writeLog(level, event, fields = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), level, event, ...fields });
  process.stdout.write(`${line}\n`);
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(logFile, `${line}\n`, { flag: "a" });
}

function createApi(args) {
  return async function api(method, path, body) {
    const url = new URL(path, `${args.server}/`);
    if (args.category !== "default" && !url.searchParams.has("category") && method === "GET") {
      url.searchParams.set("category", args.category);
    }
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${args.token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { message: text.slice(0, 500) };
    }
    return { status: response.status, ok: response.ok, json };
  };
}

function describeFailure(result) {
  const { json } = result;
  if (json.error === "capture_blocked") {
    return `capture_blocked (${(json.blockReasons ?? []).join(", ") || "unknown"})`;
  }
  return `${result.status} ${json.error ?? ""} ${String(json.message ?? "").slice(0, 300)}`.trim();
}

function pageStats(json) {
  const document = json.document;
  return {
    title: document?.meta?.title ?? json.status?.title,
    chars: document?.meta?.statistics?.charCount ?? String(json.markdown ?? "").length,
    sections: document?.sections?.length ?? 0,
  };
}

/** A relay failure that server_fetch may still recover from. */
function relayCanFallBack(result) {
  if (result.ok) return false;
  if (result.status === 503) return true;
  const message = `${result.json.error ?? ""} ${result.json.message ?? ""}`;
  return /host not allowed|agent_unavailable|capture_blocked|timed out|timeout/i.test(message);
}

async function processEntry(api, args, entry, orderIndex, relayConnected) {
  const collection = collectionTarget(entry, orderIndex);
  const category = args.category === "default" ? {} : { category: args.category };
  const modes = args.capture === "auto"
    ? (relayConnected ? ["relay", "fetch"] : ["fetch"])
    : [args.capture];
  const attempts = [];

  for (const mode of modes) {
    // Preview first: a blocked or near-empty page must not be saved as an article.
    const preview = mode === "relay"
      ? await api("POST", "/api/capture", { url: entry.url, ...category })
      : await api("POST", "/api/ingest/preview", { inputMode: "server_fetch", url: entry.url, ...category });
    if (!preview.ok) {
      attempts.push({ mode, error: describeFailure(preview) });
      if (mode === "relay" && modes.includes("fetch") && relayCanFallBack(preview)) continue;
      break;
    }
    const stats = pageStats(preview.json);
    if (stats.chars < MIN_ARTICLE_CHARS) {
      attempts.push({ mode, error: `only ${stats.chars} characters parsed; treated as blocked or empty` });
      continue;
    }
    if (mode === "fetch" && RENDERED_HOSTS.has(new URL(entry.url).hostname)) {
      attempts.push({ mode, warning: "page is rendered in the browser; server fetch is partial, use the relay for the full text" });
    }
    const alreadySaved = preview.json.status?.state === "parsed";
    if (args.dryRun) {
      return { ok: true, action: alreadySaved ? "would_attach_existing" : "would_save", mode, ...stats, attempts };
    }

    const saved = mode === "relay"
      ? await api("POST", "/api/capture", { url: entry.url, save: true, overwrite: false, collection, ...category })
      : await api("POST", "/api/collections/pages", {
        inputMode: "server_fetch", url: entry.url, overwrite: false, collection, ...category,
      });
    if (!saved.ok) {
      attempts.push({ mode, error: describeFailure(saved) });
      break;
    }
    if ((!saved.json.saved && !saved.json.reusedExisting) || saved.json.status?.state !== "parsed"
      || !saved.json.collection?.collectionId) {
      attempts.push({ mode, error: "Suite did not confirm a parsed save in the collection" });
      break;
    }
    return {
      ok: true,
      action: saved.json.reusedExisting ? "existing_article_attached" : "article_saved",
      mode,
      collectionId: saved.json.collection.collectionId,
      itemId: saved.json.status.itemId,
      ...(saved.json.reusedExisting ? stats : pageStats(saved.json)),
      attempts,
    };
  }
  return { ok: false, attempts };
}

async function run(args) {
  await mkdir(runtimeDir, { recursive: true });
  const api = createApi(args);
  const all = parseReadingList(await readFile(DOC_PATH, "utf8"));
  if (all.length === 0) throw new Error(`No reading-list links found in ${DOC_PATH}; refusing to continue.`);

  let entries = all.filter((entry) => args.includeIndex || entry.kind === "article");
  if (args.section) entries = entries.filter((entry) => entry.section.includes(args.section));
  if (args.limit) entries = entries.slice(0, args.limit);
  if (entries.length === 0) throw new Error("No entries match the given options.");

  const health = await api("GET", "/api/health");
  if (!health.ok) throw new Error(`Knowledge Suite is not reachable at ${args.server}: ${describeFailure(health)}`);
  const captureStatus = await api("GET", "/api/capture/status");
  const relayConnected = captureStatus.ok && captureStatus.json.agentConnected === true;
  if (args.capture === "relay" && !relayConnected) {
    throw new Error("--capture relay needs the Knowledge Capture Relay extension connected to this server.");
  }

  await writeLog("info", "run_started", {
    server: args.server,
    dryRun: args.dryRun,
    capture: args.capture,
    relayConnected,
    category: args.category,
    listedLinks: all.length,
    selectedEntries: entries.length,
    skippedIndexPages: args.includeIndex ? 0 : all.filter((entry) => entry.kind === "index").length,
  });

  const orderBySection = new Map();
  const failures = [];
  const counts = {};
  for (const entry of entries) {
    const orderIndex = orderBySection.get(entry.section) ?? 0;
    orderBySection.set(entry.section, orderIndex + 1);
    let result;
    try {
      result = await processEntry(api, args, entry, orderIndex, relayConnected);
    } catch (error) {
      result = { ok: false, attempts: [{ mode: "request", error: String(error?.message ?? error).slice(0, 300) }] };
    }
    if (result.ok) {
      counts[result.action] = (counts[result.action] ?? 0) + 1;
      await writeLog("info", result.action, {
        url: entry.url,
        section: entry.section,
        mode: result.mode,
        title: result.title,
        chars: result.chars,
        collectionId: result.collectionId,
        ...(result.attempts.length ? { earlierAttempts: result.attempts } : {}),
      });
    } else {
      failures.push({ url: entry.url, section: entry.section, attempts: result.attempts });
      await writeLog("warn", "article_failed", { url: entry.url, section: entry.section, attempts: result.attempts });
    }
  }

  await writeLog(failures.length ? "warn" : "info", args.dryRun ? "dry_run_complete" : "run_complete", {
    entries: entries.length,
    ...counts,
    failures: failures.length,
    failedUrls: failures.map((failure) => failure.url),
  });
  return failures.length ? 1 : 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\nSee the header of this file for usage.\n`);
    process.exit(1);
  }
  if (args.help) {
    const header = (await readFile(fileURLToPath(import.meta.url), "utf8")).split("\n")
      .filter((line) => line.startsWith("//")).map((line) => line.replace(/^\/\/ ?/, "")).join("\n");
    process.stdout.write(`${header}\n`);
    process.exit(0);
  }
  run(args).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch(async (error) => {
    await writeLog("error", "run_failed", { message: String(error?.stack ?? error).slice(0, 2000) });
    process.exitCode = 1;
  });
}
