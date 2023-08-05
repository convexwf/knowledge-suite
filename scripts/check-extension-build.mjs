import { access, readFile } from "node:fs/promises";

const content = await readFile("apps/knowledge-web-clipper/dist/content.js", "utf8");

if (/^\s*(import|export)\s/m.test(content)) {
  throw new Error("content.js must be a classic content script and cannot contain top-level import/export.");
}

for (const file of [
  "apps/knowledge-web-clipper/dist/options.html",
  "apps/knowledge-web-clipper/dist/options.css",
  "apps/knowledge-web-clipper/dist/options.js"
]) {
  await access(file);
}

console.log("extension build check passed");
