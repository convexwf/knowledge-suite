#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BLOG_URL = "https://developers.openai.com/blog";
const BLOG_ORIGIN = "https://developers.openai.com";
const COLLECTION_TITLE = "OpenAI Developers Blog";
const GATEWAY_URL = process.env.BOT_MCP_GW_URL ?? "http://127.0.0.1:18769/mcp";
const GATEWAY_TOKEN = process.env.BOT_MCP_GW_TOKEN;
const MAX_DISCOVERED_POSTS = 500;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const suiteRoot = resolve(scriptDir, "../..");
const runtimeDir = join(suiteRoot, "tmp", "automation", "openai-dev-blog");
const logFile = join(runtimeDir, "runner.jsonl");

let client;
let toolNames = new Map();

function normalizeUrl(value) {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

function isBlogPostUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === BLOG_ORIGIN && /^\/blog\/[^/]+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

function articleKey(value) {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/^\/zh-Hans(?=\/blog\/)/, "");
  return normalizeUrl(url.toString());
}

function cleanTitle(value) {
  const lines = String(value ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const title = lines.find((line) => !/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}$/i.test(line));
  return (title ?? lines[0] ?? "").slice(0, 500);
}

function parseJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function unwrapResult(value) {
  let current = value;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current === "string") {
      const parsed = parseJson(current);
      if (parsed === current) return current;
      current = parsed;
      continue;
    }
    if (current && typeof current === "object" && typeof current.result === "string") {
      const parsed = parseJson(current.result);
      if (parsed === current.result) return current;
      current = parsed;
      continue;
    }
    return current;
  }
  return current;
}

function resultData(result) {
  if (result?.isError) {
    const details = (result.content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
    throw new Error(details || "MCP tool call failed");
  }
  if (result?.structuredContent && typeof result.structuredContent === "object") return unwrapResult(result.structuredContent);
  const text = (result?.content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
  return unwrapResult(parseJson(text));
}

function findTool(catalog, upstream, leafName) {
  const name = `${upstream}__${leafName}`;
  if (!catalog.some((tool) => tool.name === name)) {
    throw new Error(`Gateway tool catalog does not contain ${name}. Restarting Codex is not required; check the Gateway upstream and its current tools/list response.`);
  }
  return name;
}

async function callTool(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return resultData(result);
}

async function writeLog(level, event, fields = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), level, event, ...fields });
  process.stdout.write(`${line}\n`);
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(logFile, `${line}\n`, { flag: "a" });
}

async function connectGateway() {
  if (!GATEWAY_TOKEN) {
    throw new Error("Set BOT_MCP_GW_TOKEN in the environment before running this script.");
  }
  client = new Client({ name: "openai-dev-blog-runner", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(GATEWAY_URL), {
    requestInit: { headers: { authorization: `Bearer ${GATEWAY_TOKEN}` } },
  });
  await client.connect(transport);

  // Read the live catalog on every run so the runner follows Gateway changes.
  const { tools = [] } = await client.listTools();
  toolNames = new Map([
    ["newTab", findTool(tools, "browser", "browser_new_tab")],
    ["browserBatch", findTool(tools, "browser", "browser_batch")],
    ["getTabs", findTool(tools, "browser", "browser_get_tabs")],
    ["executeJs", findTool(tools, "browser", "browser_execute_js")],
    ["discover", findTool(tools, "knowledge_suite", "discover_knowledge_batch_imports")],
    ["listCollections", findTool(tools, "knowledge_suite", "list_knowledge_collections")],
    ["listItems", findTool(tools, "knowledge_suite", "list_knowledge_items")],
    ["saveToCollection", findTool(tools, "knowledge_suite", "save_knowledge_page_to_collection")],
  ]);
  await writeLog("info", "gateway_connected", { gatewayUrl: GATEWAY_URL, toolCount: tools.length });
}

async function executeBrowserJs(tabId, script) {
  const result = await callTool(toolNames.get("executeJs"), {
    script,
    switch_tab_id: tabId,
    no_monitor: true,
  });
  if (!result || result.status !== "success") {
    throw new Error(`Browser CDP call failed: ${JSON.stringify(result).slice(0, 1000)}`);
  }
  return result.js_return;
}

async function openBlogTab() {
  const result = await callTool(toolNames.get("newTab"), { url: BLOG_URL });
  if (result?.status !== "success") throw new Error(`Gateway could not create a background blog tab: ${JSON.stringify(result).slice(0, 1000)}`);
  const targetId = result.target_id;
  const tabId = result.tab?.id ?? result.tab_id ?? result.tabId ?? result.metadata?.tab_id;
  if (!tabId) throw new Error(`Gateway created a target but did not confirm its Chrome tab ID: ${JSON.stringify(result).slice(0, 1000)}`);
  return { tabId: String(tabId), targetId: targetId ? String(targetId) : undefined };
}

async function discoverPosts(tabId) {
  let candidates = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const jsReturn = await executeBrowserJs(tabId, `JSON.stringify([...new Map([...document.querySelectorAll('a[href]')].map(a => {const u=new URL(a.href,location.href);return [u.href,{url:u.href,titleHint:(a.innerText||a.getAttribute('aria-label')||'').trim().replace(/\\s+/g,' ')}]})).values()].filter(x => new URL(x.url).origin === ${JSON.stringify(BLOG_ORIGIN)} && /^\\/blog\\/[^/]+\\/?$/.test(new URL(x.url).pathname)).map((x,i)=>({...x,order:i,depth:1,source:'openai-dev-blog'})))`);
    candidates = parseJson(jsReturn);
    if (Array.isArray(candidates) && candidates.length > 0) break;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 900));
  }
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("No English blog links were found on the English index; refusing to alter the collection.");
  }

  const result = await callTool(toolNames.get("discover"), {
    pageUrl: BLOG_URL,
    scope: { sameOrigin: true, pathPrefix: "/blog/", maxItems: 200 },
    candidates,
  });
  const posts = (result.items ?? [])
    .filter((item) => item.selectedByDefault !== false && isBlogPostUrl(item.url))
    .map((item, order) => ({
      url: normalizeUrl(item.url),
      titleHint: cleanTitle(item.titleHint ?? item.text),
      source: item.source ?? "openai-dev-blog",
      order,
      depth: item.depth ?? 1,
    }));
  if (posts.length === 0) throw new Error("The Gateway found no eligible English blog posts.");
  if (posts.length > MAX_DISCOVERED_POSTS) throw new Error(`Discovered ${posts.length} posts, above the safe limit of ${MAX_DISCOVERED_POSTS}.`);
  return posts;
}

async function readSuiteState() {
  const [collectionResult, itemResult] = await Promise.all([
    callTool(toolNames.get("listCollections"), { limit: 200 }),
    callTool(toolNames.get("listItems"), { limit: 1000 }),
  ]);
  const collection = (collectionResult.collections ?? []).find((item) => item.title === COLLECTION_TITLE
    && item.rootUrl
    && normalizeUrl(item.rootUrl) === normalizeUrl(BLOG_URL));
  const itemsByUrl = new Map();
  for (const item of itemResult.items ?? []) {
    const url = item.normalizedUrl ?? item.url;
    if (url && isBlogPostUrl(url)) itemsByUrl.set(articleKey(url), item);
  }
  return { collection, itemsByUrl };
}

function collectionTarget(collection, post) {
  return {
    title: COLLECTION_TITLE,
    rootUrl: BLOG_URL,
    strategy: collection ? "update" : "create",
    ...(collection?.collectionId ? { collectionId: collection.collectionId } : {}),
    orderIndex: post.order,
    depth: post.depth ?? 1,
    source: post.source ?? "openai-dev-blog",
  };
}

function browserSnapshotScript(expectedUrl) {
  return `JSON.stringify((()=>{const m=document.querySelector('main')||document.body;const meta={};for(const e of document.querySelectorAll('meta[name],meta[property]')){const k=e.name||e.getAttribute('property');if(k&&e.content)meta[k]=e.content}const canonical=document.querySelector('link[rel="canonical"]')?.href||location.href;const title=document.title;const lang=document.documentElement.lang||'en';const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');const html='<html lang="'+esc(lang)+'"><head><title>'+esc(title)+'</title><link rel="canonical" href="'+esc(canonical)+'"></head>'+m.outerHTML+'</html>';return {pageUrl:location.href,canonicalUrl:canonical,pageTitle:title,title,html,text:m.innerText,diagnostics:{htmlLength:html.length,textLength:m.innerText.length,shadowRootCount:0},capturedAt:new Date().toISOString(),meta,ready:document.readyState,expectedUrl:${JSON.stringify(expectedUrl)}}})())`;
}

async function getBrowserSnapshot(tabId, post) {
  await executeBrowserJs(tabId, `location.href=${JSON.stringify(post.url)}; "navigation requested"`);
  await new Promise((resolveSleep) => setTimeout(resolveSleep, 900));
  let snapshot;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const jsReturn = await executeBrowserJs(tabId, browserSnapshotScript(post.url));
    snapshot = parseJson(jsReturn);
    if (normalizeUrl(snapshot.pageUrl) === normalizeUrl(post.url)
      && snapshot.ready === "complete"
      && snapshot.text?.length > 500) break;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 900));
  }
  if (!snapshot || normalizeUrl(snapshot.pageUrl) !== normalizeUrl(post.url) || snapshot.text?.length <= 500) {
    throw new Error(`CDP page did not finish loading: ${snapshot?.pageUrl ?? "unknown"}`);
  }
  if (snapshot.lang && !snapshot.lang.toLowerCase().startsWith("en")) {
    throw new Error(`Expected English content, but the page language is ${snapshot.lang}: ${post.url}`);
  }
  delete snapshot.ready;
  delete snapshot.expectedUrl;
  return snapshot;
}

async function saveOrAttach(post, collection, existingItem, tabId) {
  const target = collectionTarget(collection, post);
  if (existingItem?.state === "parsed" && existingItem.activeDocId) {
    const linked = await callTool(toolNames.get("saveToCollection"), {
      inputMode: "server_fetch",
      url: post.url,
      overwrite: false,
      collection: target,
    });
    if (!linked.status || linked.status.state !== "parsed" || !linked.collection?.collectionId) {
      throw new Error(`Existing page was not confirmed as attached to the collection: ${post.url}`);
    }
    return { result: linked, collection: linked.collection, action: "existing_page_attached_or_reordered" };
  }

  const snapshot = await getBrowserSnapshot(tabId, post);
  const saved = await callTool(toolNames.get("saveToCollection"), {
    inputMode: "browser_html",
    snapshot,
    overwrite: false,
    collection: target,
  });
  if ((!saved.saved && !saved.reusedExisting) || saved.status?.state !== "parsed" || !saved.collection?.collectionId) {
    throw new Error(`Suite did not confirm a parsed save: ${post.url}`);
  }
  return {
    result: saved,
    collection: saved.collection,
    action: saved.reusedExisting ? "existing_page_attached_or_reordered" : "post_saved_from_cdp",
  };
}

async function closeBrowserTab(browserTab) {
  if (!browserTab?.targetId || !browserTab?.tabId || !toolNames.get("browserBatch")) return;
  try {
    await callTool(toolNames.get("browserBatch"), {
      tab_id: browserTab.tabId,
      commands: [{ cmd: "cdp", method: "Target.closeTarget", params: { targetId: browserTab.targetId } }],
      timeout: 10,
    });
  } catch {
    // Closing a background tab is best-effort; saving must not fail because of it.
  }
}

async function run() {
  const dryRun = process.argv.includes("--dry-run");
  let browserTab;
  await mkdir(runtimeDir, { recursive: true });
  await writeLog("info", "run_started", { blogUrl: BLOG_URL, gatewayUrl: GATEWAY_URL, dryRun });

  try {
    await connectGateway();
    browserTab = await openBlogTab();
    const discovered = await discoverPosts(browserTab.tabId);
    const { collection: existingCollection, itemsByUrl } = await readSuiteState();

    const merged = new Map();
    for (const post of discovered) merged.set(articleKey(post.url), post);
    for (const [key, item] of itemsByUrl) {
      if (merged.has(key)) continue;
      const url = item.normalizedUrl ?? item.url;
      merged.set(key, {
        url: normalizeUrl(url),
        titleHint: item.contentTitle ?? item.title ?? item.pageTitle ?? "",
        source: "openai-dev-blog-archive",
        order: merged.size,
        depth: 1,
      });
    }
    const posts = [...merged.values()].map((post, order) => ({ ...post, order }));
    const newPages = posts.filter((post) => itemsByUrl.get(articleKey(post.url))?.state !== "parsed");

    if (dryRun) {
      await writeLog("info", "dry_run_complete", {
        discovered: discovered.length,
        knownParsedPages: posts.length - newPages.length,
        pagesNeedingCdpCapture: newPages.length,
        collectionItemsAfterMerge: posts.length,
        collectionId: existingCollection?.collectionId,
      });
      return 0;
    }

    let collection = existingCollection;
    const failures = [];
    let savedCount = 0;
    let linkedCount = 0;
    for (const post of posts) {
      try {
        const existingItem = itemsByUrl.get(articleKey(post.url));
        const { result, collection: updatedCollection, action } = await saveOrAttach(post, collection, existingItem, browserTab.tabId);
        collection = updatedCollection;
        if (action === "post_saved_from_cdp") savedCount += 1;
        else linkedCount += 1;
        await writeLog("info", action, {
          url: post.url,
          title: result.status?.title ?? post.titleHint,
          collectionId: collection.collectionId,
          state: result.status?.state,
        });
      } catch (error) {
        const message = String(error?.message ?? error).slice(0, 700);
        failures.push({ url: post.url, message });
        await writeLog("warn", "post_save_failed", { url: post.url, message });
      }
    }

    await writeLog(failures.length ? "warn" : "info", "run_complete", {
      discovered: discovered.length,
      collectionItems: posts.length - failures.length,
      newPagesSaved: savedCount,
      existingPagesAttachedOrReordered: linkedCount,
      failures: failures.length,
      collectionId: collection?.collectionId,
      errors: failures,
    });
    return failures.length ? 1 : 0;
  } finally {
    await closeBrowserTab(browserTab);
    await client?.close().catch(() => {});
  }
}

run().then((exitCode) => {
  process.exitCode = exitCode;
}).catch(async (error) => {
  await writeLog("error", "run_failed", { message: String(error?.stack ?? error).slice(0, 2000) });
  process.exitCode = 1;
});
