/**
 * Feishu Wiki Crawler — BFS approach: crawls and discovers tree on the fly.
 * Usage: npx tsx scripts/feishu-crawl.ts <url> --connect
 */
import { chromium } from "playwright";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_DIR = resolve(__dirname, "..", "knowledge-store", "wiki-export");
const FEISHU_EXTRACT = readFileSync(resolve(__dirname, "feishu-extract.js"), "utf-8");

// ── Helpers ──────────────────────────────────────────────────────────
function san(f: string) { return f.replace(/[<>:"/\\|?*\n\r]/g, "").trim().slice(0, 100) || "untitled"; }
function wikiToken(u: string): string | null { const m = u.match(/\/wiki\/([A-Za-z0-9]+)/); return m ? m[1] : null; }

function sectionsToMarkdown(sections: any[], tokenHash?: Record<string, string>): string {
  const th = tokenHash || {};
  const l: string[] = [];
  for (const s of sections) {
    switch (s.type) {
      case "heading": l.push(`${"#".repeat(s.level ?? 2)} ${s.content ?? ""}`, ""); break;
      case "paragraph": l.push(s.content ?? "", ""); break;
      case "list":
        for (const it of (s.items ?? []) as Array<{ text: string; checked?: boolean; items?: string[] }>) {
          l.push(`${it.checked !== undefined ? (it.checked ? "- [x] " : "- [ ] ") : "- "}${it.text}`);
          if (it.items?.length) for (const n of it.items) l.push(`  - ${n}`);
        } l.push(""); break;
      case "code": l.push("```", s.content ?? "", "```", ""); break;
      case "blockquote": for (const ln of (s.content ?? "").split("\n")) l.push(`> ${ln}`); l.push(""); break;
      case "figure": {
        const a = (s.assets ?? []) as Array<{ alt?: string; source_url?: string }>;
        if (a[0]?.source_url) {
          const m = a[0].source_url.match(/\/medias\/([A-Za-z0-9]+)\/download/);
          if (m) { const tok = m[1]; const hash = th[tok] || tok.slice(0, 16); l.push(`![${hash}.png](${hash}.png)`, ""); }
        } break;
      }
      case "table": {
        const rows = (s.rows ?? []) as string[][];
        if (rows.length > 0) { l.push(`| ${rows[0].join(" | ")} |`, `| ${rows[0].map(() => "---").join(" | ")} |`);
          for (const r of rows.slice(1)) l.push(`| ${r.join(" | ")} |`); l.push(""); } break;
      }
    }
  }
  return l.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const url = args.find(a => a.startsWith("http"));
  if (!url) { console.log("Usage: npx tsx scripts/feishu-crawl.ts <url> --connect"); return; }
  const targetToken = wikiToken(url);
  if (!targetToken) { console.error("Invalid URL"); return; }

  console.log("[crawl] Connecting...");
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] || await ctx.newPage();

  // BFS queue: {token, parentTitle, path}  path = array of parent directory names
  type QueueItem = { token: string; parentTitle: string; path: string[] };
  const queue: QueueItem[] = [];
  const visited = new Set<string>();
  const treeMap: Record<string, { title: string; children: string[] }> = {};

  // Root: navigate to target URL first to get title and first tree
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });
  await page.waitForTimeout(3000);
  const rootTitle = await page.evaluate("(async()=>{var r=window.PageMain?.blockManager?.rootBlockModel;if(!r)return'';function o(a){return a&&a.length?a.map(function(x){return x.insert}).join('').replace(/\\n/g,'').trim():'';}return o(r.zoneState?.content?.ops)||r.zoneState?.allText?.replace(/\\n/g,'').trim()||'';})()");
  queue.push({ token: targetToken, parentTitle: "", path: [rootTitle || targetToken] });
  treeMap[targetToken] = { title: rootTitle || targetToken, children: [] };
  console.log(`[crawl] Root: ${rootTitle} (${targetToken.slice(0, 8)}...)`);

  const outDir = resolve(args.indexOf("--out") >= 0 ? args[args.indexOf("--out") + 1] : STORE_DIR, targetToken);
  const assetsDir = resolve(outDir, "assets");
  mkdirSync(assetsDir, { recursive: true });
  console.log(`[crawl] Output: ${outDir}/`);

  let ok = 0, fail = 0, totalImg = 0;

  while (queue.length > 0) {
    const item = queue.shift()!;
    if (visited.has(item.token)) continue;
    visited.add(item.token);

    const pageUrl = `https://my.feishu.cn/wiki/${item.token}`;
    const dir = resolve(outDir, ...item.path.slice(0, -1));
    const fname = san(item.path[item.path.length - 1] || item.token) + ".md";
    const fp = resolve(dir, fname);

    console.log(`\n[${visited.size}] 📄 ${item.path.join(" / ")} (${item.token.slice(0, 8)}...)`);

    try {
      // Navigate & capture tree/get_info response (to discover children)
      const childSet = new Set<string>();
      const respHandler = async (resp: any) => {
        if (resp.url().includes("tree/get_info")) {
          try {
            const j = await resp.json();
            const cm = j?.data?.tree?.child_map;
            const nd = j?.data?.tree?.nodes;
            if (cm && nd) {
              // Discover children of current token
              const kids: string[] = cm[item.token] || [];
              for (const k of kids) {
                const cnode = nd[k];
                if (cnode && !visited.has(k) && !childSet.has(k)) {
                  childSet.add(k);
                  // Set or ensure current token's entry with correct title
                  if (!treeMap[item.token]) treeMap[item.token] = { title: item.path[item.path.length - 1] || item.token, children: [] };
                  treeMap[item.token].children.push(k);
                  treeMap[k] = { title: cnode.title || k, children: [] };
                  queue.push({ token: k, parentTitle: item.path[item.path.length - 1], path: [...item.path, cnode.title || k] });
                }
              }
            }
          } catch { }
        }
      };
      page.on("response", respHandler);

      await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 10000 });
      await page.waitForTimeout(2000);

      // Skip extraction if already saved
      if (existsSync(fp)) {
        console.log(`  ⏭ already extracted`);
        page.off("response", respHandler);
        ok++;
        continue;
      }

      // Scroll to load lazy content
      await page.evaluate(async () => {
        const c = document.querySelector("#mainBox .bear-web-x-container");
        if (c) { for (let t = 0; t < 15; t++) { c.scrollTo({ top: c.scrollHeight, behavior: "smooth" }); await new Promise(r => setTimeout(r, 300)); } c.scrollTo({ top: 0, behavior: "instant" }); }
      });

      const raw = await page.evaluate(FEISHU_EXTRACT);
      page.off("response", respHandler);
      const r = JSON.parse(raw);

      if (!r.ok) { console.log(`  ⚠ ${r.error}`); fail++; continue; }

      // Save images
      let pageImg = 0;
      const tokenHash: Record<string, string> = {};
      if (r.imageData) {
        for (const [tok, val] of Object.entries(r.imageData)) {
          const h = typeof val === "string" ? tok.slice(0, 16) : ((val as any).hash || tok.slice(0, 16));
          const d = typeof val === "string" ? val as string : (val as any).data as string;
          tokenHash[tok] = h;
          const imgFile = resolve(assetsDir, `${h}.png`);
          if (!existsSync(imgFile)) writeFileSync(imgFile, Buffer.from(d, "base64"));
          pageImg++;
        }
      }
      if (pageImg > 0) { totalImg += pageImg; console.log(`  📷 ${pageImg} images`); }

      // Save markdown
      mkdirSync(dir, { recursive: true });
      writeFileSync(fp, sectionsToMarkdown(r.sections, tokenHash), "utf-8");
      console.log(`  ✅ ${r.sections?.length || 0} sections → ${fp}`);
      ok++;

      // Print discovered children
      if (childSet.size > 0) console.log(`  📁 ${childSet.size} child pages discovered`);
    } catch (err) { console.log(`  ❌ ${err instanceof Error ? err.message : String(err)}`); fail++; }
  }

  // ── Print full tree map ─────────────────────────────────────────────
  console.log(`\n${"═".repeat(50)}`);
  console.log(`FULL TREE MAP`);
  console.log(`${"═".repeat(50)}`);
  if (treeMap[targetToken]) {
    function printTree(token: string, depth: number) {
      const node = treeMap[token];
      if (!node) return;
      const prefix = "  ".repeat(depth) + (node.children.length > 0 ? "📁" : "📄");
      console.log(`${prefix} ${node.title || token.slice(0, 8)} (${token.slice(0, 8)}...)`);
      for (const c of node.children) printTree(c, depth + 1);
    }
    printTree(targetToken, 0);
  } else {
    console.log("(no tree - single page only)");
  }

  // ── Statistics ──────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(50)}`);
  console.log(`STATISTICS`);
  console.log(`${"═".repeat(50)}`);
  console.log(`  Pages extracted:  ${ok}`);
  console.log(`  Pages failed:     ${fail}`);
  console.log(`  Images saved:     ${totalImg}`);
  console.log(`  Total visited:    ${visited.size}`);
  console.log(`  Output dir:       ${outDir}/`);

  // Generate _index_.md in each directory with full nested tree
  if (treeMap[targetToken]) {
    let idxCount = 0;

    // Recursively write index and build nested tree display
    function writeIndexWithTree(token: string, dirPath: string[], linkPrefix: string) {
      const node = treeMap[token];
      if (!node || node.children.length === 0) return "";
      const lines: string[] = [];

      for (let i = 0; i < node.children.length; i++) {
        const c = node.children[i];
        const childTitle = treeMap[c]?.title || c;
        const childFile = `${san(childTitle)}.md`;
        const hasKids = (treeMap[c]?.children?.length || 0) > 0;

        const fullLink = linkPrefix + childFile;
        lines.push(`${i + 1}. [${childTitle}](${fullLink})`);
        if (hasKids) {
          const childSubDir = `${san(childTitle)}/`;
          const nested = writeIndexWithTree(c, [...dirPath, san(node.title)], linkPrefix + childSubDir);
          if (nested) {
            for (const nl of nested.split("\n")) {
              if (nl.trim()) lines.push("    " + nl);
            }
          }
        }
      }

      const content = [`# ${node.title || token}`, "", ...lines].join("\n") + "\n";
      const d = resolve(outDir, ...dirPath);
      mkdirSync(d, { recursive: true });
      writeFileSync(resolve(d, "_index_.md"), content, "utf-8");
      idxCount++;
      return lines.join("\n");
    }
    writeIndexWithTree(targetToken, [rootTitle], "./");
    console.log(`  _index_.md:        ${idxCount} files written`);
  }

  process.exit(0);
}
main().catch(err => { console.error(err); process.exit(1); });
