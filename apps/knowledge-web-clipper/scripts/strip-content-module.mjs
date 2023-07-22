import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const contentPath = resolve(import.meta.dirname, "../dist/content.js");
const content = await readFile(contentPath, "utf8");

await writeFile(
  contentPath,
  content.replace(/^\s*export\s+\{\};\n?/m, ""),
  "utf8"
);
