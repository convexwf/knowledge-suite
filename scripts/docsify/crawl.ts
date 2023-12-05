#!/usr/bin/env npx tsx
/**
 * Docsify wiki crawler — fetch _sidebar.md, parse nested tree,
 * download all .md files, save with hierarchy.
 *
 * Usage:
 *   npx tsx scripts/docsify/crawl.ts <docsify-url>
 *
 * Example:
 *   npx tsx scripts/docsify/crawl.ts https://hello-agents.datawhale.cc
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_DIR = resolve(__dirname, "..", "..", "knowledge-store", "wiki-export");

// ── Helpers ──────────────────────────────────────────────────────────
function san(f: string) { return f.replace(/[<>:"/\\|?*\n\r]/g, "").trim().slice(0, 100) || "untitled"; }

interface TreeNode {
  title: string;
  url: string;
  children: TreeNode[];
}

async function fetchText(url: string): Promise<string> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
  return resp.text();
}

/** Parse a docsify _sidebar.md into a tree structure.
 *  Also returns a url→sidebarPath map for correct directory layout. */
function parseSidebar(md: string, baseUrl: string): { tree: TreeNode[]; urlPath: Map<string, string[]> } {
  const roots: TreeNode[] = [];
  const stack: { depth: number; node: TreeNode; path: string[] }[] = [];
  const urlPath = new Map<string, string[]>();

  for (const line of md.split("\n")) {
    const m = line.match(/^(\s*)[-*]\s+\[(.+?)\]\((.+?)\)|^(\s*)[-*]\s+<strong>(.+?)<\/strong>/);
    if (!m) continue;

    const indent = m[1]?.length ?? m[4]?.length ?? 0;
    const depth = Math.floor(indent / 2);
    const isBold = m[4] !== undefined;
    const title = (m[2] ?? m[5] ?? "").trim();
    const url = m[3] ? new URL(m[3], baseUrl).toString() : "";

    const node: TreeNode = { title, url, children: [] };

    if (depth === 0 && !isBold) {
      roots.push(node);
      stack.length = 0;
      stack.push({ depth: 0, node, path: [] });
      if (url) urlPath.set(url, []);
    } else {
      while (stack.length > 0 && stack[stack.length - 1].depth >= depth) stack.pop();
      const parent = stack[stack.length - 1];
      if (parent) {
        parent.node.children.push(node);
        const myPath = isBold ? [...parent.path, san(title)] : parent.path;
        stack.push({ depth, node, path: myPath });
        if (url) urlPath.set(url, myPath);
      } else {
        roots.push(node);
        const myPath = isBold ? [san(title)] : [];
        stack.push({ depth, node, path: myPath });
        if (url) urlPath.set(url, myPath);
      }
    }
  }
  return { tree: roots, urlPath };
}

function printTree(nodes: TreeNode[], d: number) {
  for (const n of nodes) {
    const prefix = "  ".repeat(d) + (n.children.length || !n.url ? "📁" : "📄");
    console.log(`${prefix} ${n.title}${n.url ? " → " + n.url.replace(/^.*\//, "") : ""}`);
    if (n.children.length) printTree(n.children, d + 1);
  }
}

async function main() {
  const arg = process.argv[2];
  if (!arg?.startsWith("http")) { console.log("Usage: npx tsx scripts/docsify/crawl.ts <url>"); return; }

  const baseUrl = arg.endsWith("/") ? arg.slice(0, -1) : arg;
  const host = new URL(baseUrl).hostname;
  const outDir = resolve(STORE_DIR, "docsify", host);

  console.log(`[docsify] Fetching ${baseUrl}/_sidebar.md ...`);
  const sidebarMd = await fetchText(`${baseUrl}/_sidebar.md`);
  const { tree, urlPath } = parseSidebar(sidebarMd, baseUrl);

  console.log(`\n[docsify] Tree:`);
  printTree(tree, 0);

  // Collect all non-empty URLs
  const urls: string[] = [];
  function collect(n: TreeNode) {
    if (n.url) urls.push(n.url);
    for (const c of n.children) collect(c);
  }
  for (const r of tree) collect(r);

  console.log(`\n[docsify] Downloading ${urls.length} pages...`);
  let ok = 0, fail = 0;

  for (const u of urls) {
    const path = urlPath.get(u) ?? [];
    const fname = san(decodeURIComponent(u.split("/").pop() || "index"));
    const dir = resolve(outDir, ...path);
    const fp = resolve(dir, fname);

    if (existsSync(fp)) { console.log(`  ⏭ ${path.join("/") + "/" + fname}`); ok++; continue; }
    try {
      const md = await fetchText(u);
      mkdirSync(dir, { recursive: true });
      writeFileSync(fp, md, "utf-8");
      console.log(`  ✅ ${path.join("/") + "/" + fname} (${md.length} chars)`);
      ok++;
    } catch (e) {
      console.log(`  ❌ ${path.join("/") + "/" + fname}: ${e instanceof Error ? e.message : String(e)}`);
      fail++;
    }
  }

  // Generate _index_.md (flat at root level, no subdirectory indices needed
  // since the tree uses <strong> section headers, not nested directories)
  const d = resolve(outDir);
  const lines = [`# ${host}`, ""];
  function buildIndexLines(node: TreeNode, prefix: string): string[] {
    const ls: string[] = [];
    node.children.forEach((c, i) => {
      const hasUrl = !!c.url;
      const file = hasUrl ? san(decodeURIComponent(c.url.split("/").pop() || "")) || c.title : "";
      ls.push(`${prefix}${i + 1}. [${c.title}](${hasUrl ? file : ""})`);
      if (c.children.length) {
        buildIndexLines(c, prefix + "    ").forEach(l => ls.push(l));
      }
    });
    return ls;
  }
  for (const r of tree) {
    const hasUrl = !!r.url;
    const file = hasUrl ? san(decodeURIComponent(r.url.split("/").pop() || "")) || r.title : "";
    lines.push(`1. [${r.title}](${hasUrl ? file : ""})`);
    if (r.children.length) {
      buildIndexLines(r, "    ").forEach(l => lines.push(l));
    }
  }
  writeFileSync(resolve(d, "_index_.md"), lines.join("\n") + "\n", "utf-8");

  console.log(`\n[docsify] ${ok} saved, ${fail} failed → ${outDir}/`);
}

main().catch(err => { console.error(err); process.exit(1); });
