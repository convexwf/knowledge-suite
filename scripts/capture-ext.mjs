#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DEFAULT_SERVER = process.env.KNOWLEDGE_SERVER_URL || "http://127.0.0.1:18765";
const DEFAULT_TOKEN = process.env.KNOWLEDGE_TOKEN || "dev-token";

const USAGE = `Usage: node scripts/capture-ext.mjs <url> [options]

  --save              Persist into the knowledge store (default: preview only)
  --owner <name>      Owner for saved items (default: master, or the existing owner)
  --wait-ms <ms>      Max stabilization wait inside the extension (default 8000)
  --server <url>      knowledge-ingest-server base URL (default ${DEFAULT_SERVER})
  --token <token>     API token (default $KNOWLEDGE_TOKEN or dev-token)
  --out <dir>         Output directory (default tmp/captures/<timestamp>)
  --quiet             Print a single summary line instead of JSON
`;

function parseArgs(argv) {
  const args = {
    url: "",
    save: false,
    owner: undefined,
    quiet: false,
    server: DEFAULT_SERVER,
    token: DEFAULT_TOKEN,
    waitMs: undefined,
    out: undefined
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--save") args.save = true;
    else if (arg === "--owner") args.owner = argv[++index];
    else if (arg === "--quiet") args.quiet = true;
    else if (arg === "--server") args.server = argv[++index];
    else if (arg === "--token") args.token = argv[++index];
    else if (arg === "--wait-ms") args.waitMs = Number(argv[++index]);
    else if (arg === "--out") args.out = argv[++index];
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (!args.url) args.url = arg;
  }
  return args;
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.url) {
    process.stderr.write(USAGE);
    process.exit(args.help ? 0 : 1);
  }

  const outDir = args.out ? resolve(args.out) : join(process.cwd(), "tmp", "captures", timestampSlug());
  mkdirSync(outDir, { recursive: true });

  const endpoint = `${args.server.replace(/\/$/, "")}/api/capture`;
  const payload = { url: args.url, save: args.save };
  if (args.owner) payload.owner = args.owner;
  if (Number.isFinite(args.waitMs)) payload.waitMs = args.waitMs;

  const startedAt = Date.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${args.token}` },
    body: JSON.stringify(payload)
  });
  const responseText = await response.text();

  if (!response.ok) {
    let parsed = null;
    try { parsed = JSON.parse(responseText); } catch { /* keep raw text */ }
    writeFileSync(join(outDir, "error.json"), responseText, "utf8");
    const message = parsed?.message || parsed?.error || responseText.slice(0, 400);
    process.stderr.write(`capture failed (${response.status}): ${message}\n`);
    if (parsed?.textSample) {
      process.stderr.write(`page text: ${String(parsed.textSample).replace(/\s+/g, " ").slice(0, 300)}\n`);
    }
    if (parsed?.error === "agent_unavailable") {
      process.stderr.write("Hint: load apps/knowledge-capture-relay in chrome://extensions and keep Chrome running.\n");
      process.exit(3);
    }
    process.exit(response.status === 422 ? 2 : 1);
  }

  const result = JSON.parse(responseText);
  const markdown = result.markdown || "";
  writeFileSync(join(outDir, args.save ? "save.json" : "preview.json"), JSON.stringify(result, null, 2), "utf8");
  writeFileSync(join(outDir, "page.md"), markdown, "utf8");

  const summary = {
    ok: true,
    url: result.status?.normalizedUrl || args.url,
    title: result.document?.meta?.title || result.status?.displayTitle || "",
    snapshotSource: "dom",
    selectedCandidateId: result.selectedCandidateId,
    markdownLength: markdown.length,
    saved: Boolean(args.save && result.saved),
    owner: args.owner,
    outDir,
    markdownPath: join(outDir, "page.md"),
    waitedMs: Date.now() - startedAt,
    domLength: result.capture?.domLength ?? 0,
    textLength: result.capture?.textLength ?? 0
  };
  writeFileSync(join(outDir, "meta.json"), JSON.stringify(summary, null, 2), "utf8");

  if (args.quiet) {
    process.stdout.write(`ok ${summary.title} md=${summary.markdownLength} saved=${summary.saved ? summary.outDir : "-"}\n`);
    return;
  }
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
}

main().catch((error) => {
  process.stderr.write(`${error && error.message || error}\n`);
  process.exit(1);
});
