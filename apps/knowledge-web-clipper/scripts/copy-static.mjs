import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const files = [
  ["public/manifest.json", "dist/manifest.json"],
  ["public/side-panel.html", "dist/side-panel.html"],
  ["public/side-panel.css", "dist/side-panel.css"],
  ["public/options.html", "dist/options.html"],
  ["public/options.css", "dist/options.css"]
];

await mkdir(resolve(root, "dist"), { recursive: true });

for (const [from, to] of files) {
  await mkdir(dirname(resolve(root, to)), { recursive: true });
  await cp(resolve(root, from), resolve(root, to), { recursive: true });
}
