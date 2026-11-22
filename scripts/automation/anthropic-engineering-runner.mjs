#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const SITE_URL = "https://www.anthropic.com/engineering";
const SITE_ORIGIN = "https://www.anthropic.com";
const COLLECTION_TITLE = "Anthropic Engineering";
const SOURCE = "anthropic-engineering";
const GATEWAY_URL = process.env.BOT_MCP_GW_URL ?? "http://127.0.0.1:18769/mcp";
const GATEWAY_TOKEN = process.env.BOT_MCP_GW_TOKEN;
const MAX_ARTICLES = 500;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const suiteRoot = resolve(scriptDir, "../..");
const runtimeDir = join(suiteRoot, "tmp", "automation", "anthropic-engineering");
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

function isEngineeringArticle(value) {
  try {
    const url = new URL(value);
    return url.origin === SITE_ORIGIN && /^\/research\/[^/]+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

function articleKey(value) {
  return normalizeUrl(value);
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
    throw new Error(`Gateway tool catalog does not contain ${name}; check the current Gateway upstream tools/list response.`);
  }
  return name;
}

async function callTool(name, args = {}) {
  return resultData(await client.callTool({ name, arguments: args }));
}

async function writeLog(level, event, fields = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), level, event, ...fields });
  process.stdout.write(`${line}\n`);
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(logFile, `${line}\n`, { flag: "a" });
}

async function connectGateway() {
  if (!GATEWAY_TOKEN) throw new Error("Set BOT_MCP_GW_TOKEN in the environment before running this script.");
  client = new Client({ name: "anthropic-engineering-runner", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(GATEWAY_URL), {
    requestInit: { headers: { authorization: `Bearer ${GATEWAY_TOKEN}` } },
  });
  await client.connect(transport);

  // Read the live Gateway catalog each run; tool names are not cached in this script.
  const { tools = [] } = await client.listTools();
  toolNames = new Map([
    ["newTab", findTool(tools, "browser", "browser_new_tab")],
    ["browserBatch", findTool(tools, "browser", "browser_batch")],
    ["executeJs", findTool(tools, "browser", "browser_execute_js")],
    ["wait", findTool(tools, "browser", "browser_wait")],
    ["discover", findTool(tools, "knowledge_suite", "discover_knowledge_batch_imports")],
    ["listCollections", findTool(tools, "knowledge_suite", "list_knowledge_collections")],
    ["listItems", findTool(tools, "knowledge_suite", "list_knowledge_items")],
    ["saveToCollection", findTool(tools, "knowledge_suite", "save_knowledge_page_to_collection")],
  ]);
  await writeLog("info", "gateway_connected", { gatewayUrl: GATEWAY_URL, toolCount: tools.length });
}

async function executeBrowserJs(tabId, script) {
  const result = await callTool(toolNames.get("executeJs"), { script, switch_tab_id: tabId, no_monitor: true });
  if (!result || result.status !== "success") {
    throw new Error(`Browser CDP call failed: ${JSON.stringify(result).slice(0, 1000)}`);
  }
  return result.js_return;
}

async function openEngineeringTab() {
  const result = await callTool(toolNames.get("newTab"), { url: SITE_URL });
  if (result?.status !== "success") throw new Error(`Gateway could not create a background Engineering tab: ${JSON.stringify(result).slice(0, 1000)}`);
  if (!result.tab?.id) throw new Error(`Gateway did not confirm the Chrome tab ID: ${JSON.stringify(result).slice(0, 1000)}`);
  return { tabId: String(result.tab.id), targetId: result.target_id ? String(result.target_id) : undefined };
}

const articleStateScript = `JSON.stringify((()=>{const urls=[...new Set([...document.querySelectorAll('main a[href^="/research/"]')].map(a=>a.href).filter(url=>{const u=new URL(url);const p=u.pathname.split('/').filter(Boolean);return u.origin==='${SITE_ORIGIN}'&&p.length===2&&p[0]==='research'}))];const more=[...document.querySelectorAll('button')].some(b=>(b.innerText||'').trim().toLowerCase()==='see more');return {count:urls.length,more}})())`;

async function readArticleState(tabId) {
  return parseJson(await executeBrowserJs(tabId, articleStateScript));
}

async function loadAllArticles(tabId) {
  await callTool(toolNames.get("wait"), {
    condition_js: `location.origin === ${JSON.stringify(SITE_ORIGIN)} && location.pathname === "/engineering" && document.readyState === "complete"`,
    timeout: 45,
    interval: 1,
    switch_tab_id: tabId,
  });

  let state = await readArticleState(tabId);
  for (let page = 0; state.more && page < 30; page += 1) {
    const before = state.count;
    const clickResult = parseJson(await executeBrowserJs(tabId, `(()=>{const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim().toLowerCase()==='see more');if(!b)return JSON.stringify({clicked:false});b.click();return JSON.stringify({clicked:true})})()`));
    if (!clickResult.clicked) break;

    const waitResult = await callTool(toolNames.get("wait"), {
      condition_js: `(()=>{const urls=[...new Set([...document.querySelectorAll('main a[href^="/research/"]')].map(a=>a.href).filter(url=>{const u=new URL(url);const p=u.pathname.split('/').filter(Boolean);return u.origin==='${SITE_ORIGIN}'&&p.length===2&&p[0]==='research'}))];const more=[...document.querySelectorAll('button')].some(b=>(b.innerText||'').trim().toLowerCase()==='see more');return urls.length>${before}||!more})()`,
      timeout: 45,
      interval: 1,
      switch_tab_id: tabId,
    });
    state = await readArticleState(tabId);
    if (state.count <= before && state.more) {
      throw new Error("The Anthropic Engineering list did not expand after clicking See more.");
    }
    if (waitResult?.status !== "success" && state.more) {
      throw new Error("Timed out while expanding the Anthropic Engineering article list.");
    }
  }
  if (state.more) throw new Error("The article list still has See more after 30 expansions; refusing a partial import.");
  return state.count;
}

function extractArticlesScript() {
  return `JSON.stringify([...new Map([...document.querySelectorAll('main a[href^="/research/"]')].map(a=>{const url=a.href;const title=(a.innerText||a.getAttribute('aria-label')||'').trim().replace(/\\s+/g,' ');let n=a,card='';for(let i=0;i<5&&n;i++,n=n.parentElement){const value=(n.innerText||'').trim().replace(/\\s+/g,' ');if(/\\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+\\d{1,2},?\\s+20\\d{2}/i.test(value)){card=value;break}}const dateMatch=card.match(/\\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+(\\d{1,2}),?\\s+(20\\d{2})\\b/i);const months={Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'};const publishedAt=dateMatch?dateMatch[3]+'-'+months[dateMatch[1]]+'-'+dateMatch[2].padStart(2,'0'):'';return[url,{url,title:title||card.split(/\\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+\\d{1,2},?\\s+20\\d{2}/i)[0].trim(),publishedAt,card}]})).values()].filter(x=>{const u=new URL(x.url);const p=u.pathname.split('/').filter(Boolean);return u.origin===${JSON.stringify(SITE_ORIGIN)}&&p.length===2&&p[0]==='research'&&x.title&&x.publishedAt}).sort((a,b)=>b.publishedAt.localeCompare(a.publishedAt)).map((x,order)=>({...x,order,depth:1,source:${JSON.stringify(SOURCE)}})))`;
}

async function discoverArticles(tabId) {
  const expandedCount = await loadAllArticles(tabId);
  const candidates = parseJson(await executeBrowserJs(tabId, extractArticlesScript()));
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("No dated Anthropic Engineering articles were found; refusing to alter the collection.");
  }
  if (candidates.length > MAX_ARTICLES) throw new Error(`Found ${candidates.length} articles, above the safe limit of ${MAX_ARTICLES}.`);

  const result = await callTool(toolNames.get("discover"), {
    pageUrl: SITE_URL,
    scope: { sameOrigin: true, pathPrefix: "/research/", maxItems: 200 },
    candidates: candidates.map(({ card, ...candidate }) => candidate),
  });
  const articles = (result.items ?? [])
    .filter((item) => item.selectedByDefault !== false && isEngineeringArticle(item.url))
    .map((item, order) => {
      const source = candidates.find((candidate) => normalizeUrl(candidate.url) === normalizeUrl(item.url));
      return {
        url: normalizeUrl(item.url),
        titleHint: String(item.titleHint ?? item.text ?? source?.title ?? "").slice(0, 500),
        publishedAt: source?.publishedAt,
        source: item.source ?? SOURCE,
        order,
        depth: item.depth ?? 1,
      };
    })
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .map((article, order) => ({ ...article, order }));
  if (articles.length === 0) throw new Error("Gateway found no eligible Anthropic Engineering articles.");
  if (expandedCount !== articles.length) {
    throw new Error(`Expanded article count (${expandedCount}) does not match dated article count (${articles.length}); refusing a partial import.`);
  }
  return articles;
}

async function readSuiteState(articles) {
  const [collectionResult, itemResult] = await Promise.all([
    callTool(toolNames.get("listCollections"), { limit: 200 }),
    callTool(toolNames.get("listItems"), { limit: 1000 }),
  ]);
  const collection = (collectionResult.collections ?? []).find((item) => item.title === COLLECTION_TITLE
    && item.rootUrl
    && normalizeUrl(item.rootUrl) === normalizeUrl(SITE_URL));
  const wanted = new Set(articles.map((article) => articleKey(article.url)));
  const itemsByUrl = new Map();
  for (const item of itemResult.items ?? []) {
    const url = item.normalizedUrl ?? item.url;
    if (url && wanted.has(articleKey(url))) itemsByUrl.set(articleKey(url), item);
  }
  return { collection, itemsByUrl };
}

function collectionTarget(collection, article) {
  return {
    title: COLLECTION_TITLE,
    rootUrl: SITE_URL,
    strategy: collection ? "update" : "create",
    ...(collection?.collectionId ? { collectionId: collection.collectionId } : {}),
    orderIndex: article.order,
    depth: article.depth ?? 1,
    source: article.source ?? SOURCE,
  };
}

function browserSnapshotScript(expectedUrl) {
  return `JSON.stringify((()=>{const m=document.querySelector('article')||document.querySelector('main')||document.body;const meta={};for(const e of document.querySelectorAll('meta[name],meta[property]')){const k=e.name||e.getAttribute('property');if(k&&e.content)meta[k]=e.content}const canonical=document.querySelector('link[rel="canonical"]')?.href||location.href;const title=document.title;const lang=document.documentElement.lang||'en';const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');const html='<html lang="'+esc(lang)+'"><head><title>'+esc(title)+'</title><link rel="canonical" href="'+esc(canonical)+'"></head>'+m.outerHTML+'</html>';return {pageUrl:location.href,canonicalUrl:canonical,pageTitle:title,title,html,text:m.innerText,diagnostics:{htmlLength:html.length,textLength:m.innerText.length,shadowRootCount:0},capturedAt:new Date().toISOString(),meta,lang,ready:document.readyState,expectedUrl:${JSON.stringify(expectedUrl)}}})())`;
}

async function getBrowserSnapshot(tabId, article) {
  const expected = new URL(normalizeUrl(article.url));
  await executeBrowserJs(tabId, `location.href=${JSON.stringify(article.url)}; "navigation requested"`);
  const waitResult = await callTool(toolNames.get("wait"), {
    condition_js: `location.origin === ${JSON.stringify(expected.origin)} && location.pathname.replace(/\\/+$/, "") === ${JSON.stringify(expected.pathname)} && document.readyState === "complete" && (document.querySelector("article")||document.querySelector("main")||document.body).innerText.trim().length > 500`,
    timeout: 45,
    interval: 1,
    switch_tab_id: tabId,
  });
  if (waitResult?.status !== "success" || waitResult.value !== true) {
    throw new Error(`CDP did not confirm the article finished loading: ${article.url}`);
  }
  const snapshot = parseJson(await executeBrowserJs(tabId, browserSnapshotScript(article.url)));
  if (normalizeUrl(snapshot.pageUrl) !== normalizeUrl(article.url) || snapshot.text?.length <= 500) {
    throw new Error(`CDP returned an incomplete article: ${snapshot?.pageUrl ?? "unknown"}`);
  }
  if (snapshot.lang && !snapshot.lang.toLowerCase().startsWith("en")) {
    throw new Error(`Expected English content, but the page language is ${snapshot.lang}: ${article.url}`);
  }
  delete snapshot.ready;
  delete snapshot.expectedUrl;
  delete snapshot.lang;
  return snapshot;
}

async function saveOrAttach(article, collection, existingItem, tabId) {
  const target = collectionTarget(collection, article);
  if (existingItem?.state === "parsed" && existingItem.activeDocId) {
    const linked = await callTool(toolNames.get("saveToCollection"), {
      inputMode: "server_fetch",
      url: article.url,
      overwrite: false,
      collection: target,
    });
    if (!linked.status || linked.status.state !== "parsed" || !linked.collection?.collectionId) {
      throw new Error(`Existing article was not confirmed as attached to the collection: ${article.url}`);
    }
    return { result: linked, collection: linked.collection, action: "existing_article_attached_or_reordered" };
  }

  const snapshot = await getBrowserSnapshot(tabId, article);
  const saved = await callTool(toolNames.get("saveToCollection"), {
    inputMode: "browser_html",
    snapshot,
    overwrite: false,
    collection: target,
  });
  if ((!saved.saved && !saved.reusedExisting) || saved.status?.state !== "parsed" || !saved.collection?.collectionId) {
    throw new Error(`Suite did not confirm a parsed save: ${article.url}`);
  }
  return {
    result: saved,
    collection: saved.collection,
    action: saved.reusedExisting ? "existing_article_attached_or_reordered" : "article_saved_from_cdp",
  };
}

async function closeEngineeringTab(tab) {
  if (!tab?.targetId || !tab?.tabId || !toolNames.get("browserBatch")) return;
  try {
    await callTool(toolNames.get("browserBatch"), {
      tab_id: tab.tabId,
      commands: [{ cmd: "cdp", method: "Target.closeTarget", params: { targetId: tab.targetId } }],
      timeout: 10,
    });
  } catch {
    // Cleanup must not invalidate successful saves.
  }
}

async function run() {
  const dryRun = process.argv.includes("--dry-run");
  let browserTab;
  await mkdir(runtimeDir, { recursive: true });
  await writeLog("info", "run_started", { siteUrl: SITE_URL, gatewayUrl: GATEWAY_URL, dryRun });

  try {
    await connectGateway();
    browserTab = await openEngineeringTab();
    const articles = await discoverArticles(browserTab.tabId);
    const { collection: existingCollection, itemsByUrl } = await readSuiteState(articles);
    const newArticles = articles.filter((article) => itemsByUrl.get(articleKey(article.url))?.state !== "parsed");

    if (dryRun) {
      await writeLog("info", "dry_run_complete", {
        discoveredArticles: articles.length,
        knownParsedArticles: articles.length - newArticles.length,
        articlesNeedingCdpCapture: newArticles.length,
        collectionItemsAfterUpdate: articles.length,
        collectionId: existingCollection?.collectionId,
      });
      return 0;
    }

    let collection = existingCollection;
    const failures = [];
    let savedCount = 0;
    let linkedCount = 0;
    for (const article of articles) {
      try {
        const existingItem = itemsByUrl.get(articleKey(article.url));
        const { result, collection: updatedCollection, action } = await saveOrAttach(article, collection, existingItem, browserTab.tabId);
        collection = updatedCollection;
        if (action === "article_saved_from_cdp") savedCount += 1;
        else linkedCount += 1;
        await writeLog("info", action, {
          url: article.url,
          publishedAt: article.publishedAt,
          title: result.status?.title ?? article.titleHint,
          collectionId: collection.collectionId,
          state: result.status?.state,
        });
      } catch (error) {
        const message = String(error?.message ?? error).slice(0, 700);
        failures.push({ url: article.url, publishedAt: article.publishedAt, message });
        await writeLog("warn", "article_save_failed", { url: article.url, publishedAt: article.publishedAt, message });
      }
    }

    await writeLog(failures.length ? "warn" : "info", "run_complete", {
      discoveredArticles: articles.length,
      collectionItems: articles.length - failures.length,
      newArticlesSavedFromCdp: savedCount,
      existingArticlesAttachedOrReordered: linkedCount,
      failures: failures.length,
      collectionId: collection?.collectionId,
      errors: failures,
    });
    return failures.length ? 1 : 0;
  } finally {
    await closeEngineeringTab(browserTab);
    await client?.close().catch(() => {});
  }
}

run().then((exitCode) => {
  process.exitCode = exitCode;
}).catch(async (error) => {
  await writeLog("error", "run_failed", { message: String(error?.stack ?? error).slice(0, 2000) });
  process.exitCode = 1;
});
