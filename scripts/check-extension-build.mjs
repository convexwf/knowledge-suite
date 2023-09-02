import { access, readFile } from "node:fs/promises";

const content = await readFile("apps/knowledge-web-clipper/dist/content.js", "utf8");

if (/^\s*(import|export)\s/m.test(content)) {
  throw new Error("content.js must be a classic content script and cannot contain top-level import/export.");
}

for (const file of [
  "apps/knowledge-web-clipper/dist/options.html",
  "apps/knowledge-web-clipper/dist/options.css",
  "apps/knowledge-web-clipper/dist/options.js",
  "apps/knowledge-web-clipper/dist/vendor/katex/katex.min.css",
  "apps/knowledge-web-clipper/dist/vendor/katex/katex.min.js",
  "apps/knowledge-web-clipper/dist/vendor/katex/fonts/KaTeX_Main-Regular.woff2",
  "apps/knowledge-web-clipper/dist/vendor/markdown-it/markdown-it.min.js",
  "apps/knowledge-web-clipper/dist/vendor/dompurify/purify.min.js"
]) {
  await access(file);
}

console.log("extension build check passed");
