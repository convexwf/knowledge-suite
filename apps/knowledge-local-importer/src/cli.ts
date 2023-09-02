import { resolve } from "node:path";
import { loadConfig } from "@uknowledge/knowledge-ingest-server/local-import-api.js";
import { ImportOptions, SourceType } from "./types.js";

interface ParsedCli {
  command: SourceType;
  options: ImportOptions;
}

export function parseCli(argv: string[]): ParsedCli {
  const [commandArg, ...rest] = argv;
  const command = parseCommand(commandArg);
  const values = flags(rest);
  const config = loadConfig();
  const root = stringFlag(values, "root");
  const file = stringFlag(values, "file");
  const options: ImportOptions = {
    sourceType: command,
    root: root ? resolve(root) : undefined,
    file: file ? resolve(file) : undefined,
    storeRoot: resolve(stringFlag(values, "store-root") ?? config.storeRoot),
    reportDir: resolve(stringFlag(values, "report-dir") ?? "tmp/local-import-reports"),
    dryRun: booleanFlag(values, "dry-run"),
    skipExisting: !booleanFlag(values, "no-skip-existing"),
    concurrency: boundedConcurrency(numberFlag(values, "concurrency") ?? 2),
    tags: tagsFlag(values, "tags")
  };

  if ((command === "calibre" || command === "html") && !options.root) {
    throw new Error(`--root is required for ${command} imports`);
  }
  if (command === "urls" && !options.file) {
    throw new Error("--file is required for urls imports");
  }
  return { command, options };
}

function parseCommand(value: string | undefined): SourceType {
  if (value === "calibre" || value === "html" || value === "urls") {
    return value;
  }
  throw new Error("Usage: knowledge-local-importer <calibre|html|urls> [--root path|--file path]");
}

function flags(args: string[]): Map<string, string | true> {
  const result = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const raw = arg.slice(2);
    const [key, inlineValue] = raw.split("=", 2);
    if (inlineValue !== undefined) {
      result.set(key, inlineValue);
      continue;
    }
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      result.set(key, next);
      index += 1;
    } else {
      result.set(key, true);
    }
  }
  return result;
}

function stringFlag(values: Map<string, string | true>, key: string): string | undefined {
  const value = values.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanFlag(values: Map<string, string | true>, key: string): boolean {
  return values.has(key);
}

function numberFlag(values: Map<string, string | true>, key: string): number | undefined {
  const value = stringFlag(values, key);
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function tagsFlag(values: Map<string, string | true>, key: string): string[] {
  const value = stringFlag(values, key);
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

function boundedConcurrency(value: number): number {
  return Math.min(Math.max(Math.trunc(value) || 1, 1), 8);
}
