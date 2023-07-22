import { readFile } from "node:fs/promises";

const content = await readFile("apps/knowledge-web-clipper/dist/content.js", "utf8");

if (/^\s*(import|export)\s/m.test(content)) {
  throw new Error("content.js must be a classic content script and cannot contain top-level import/export.");
}

console.log("extension build check passed");
