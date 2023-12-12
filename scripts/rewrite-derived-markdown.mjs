#!/usr/bin/env node

import { resolve } from "node:path";
import { rewriteMarkdownDerivatives } from "../apps/knowledge-ingest-server/dist/markdown-maintenance.js";

const args = process.argv.slice(2);
const write = args.includes("--write");
const storeArgIndex = args.indexOf("--store");
const store = resolve(storeArgIndex >= 0 ? args[storeArgIndex + 1] ?? "" : process.env.KNOWLEDGE_STORE ?? "knowledge-store");

if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: npm run markdown:rewrite [-- --store <path>] [--write]");
  console.log("Default mode is dry-run; --write updates markdown files from Document JSON.");
  process.exit(0);
}

if (!store || store === resolve(".")) {
  throw new Error("A concrete --store path or KNOWLEDGE_STORE value is required.");
}

const report = await rewriteMarkdownDerivatives(store, { write });
console.log(JSON.stringify(report, null, 2));
