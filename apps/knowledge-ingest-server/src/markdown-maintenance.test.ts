import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rewriteMarkdownDerivatives } from "./markdown-maintenance.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("markdown derivative maintenance", () => {
  it("reports legacy files in dry-run mode and rewrites them explicitly", async () => {
    const root = await mkdtemp(join("/tmp", "knowledge-markdown-maintenance-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "documents"));
    await mkdir(join(root, "markdown"));
    await writeFile(join(root, "documents", "doc-1.json"), JSON.stringify({
      doc_id: "doc-1",
      meta: {
        title: "Maintenance document",
        source: { type: "html" },
        ingested_at: "2026-08-23T00:00:00.000Z"
      },
      sections: [{ section_id: "section-1", type: "paragraph", content: "Body" }]
    }));
    await writeFile(join(root, "markdown", "doc-1.md"), "<!-- section_id:section-1 -->\nold\n");
    await writeFile(join(root, "markdown", "orphan.md"), "orphan\n");

    const dryRun = await rewriteMarkdownDerivatives(root);
    expect(dryRun.write).toBe(false);
    expect(dryRun.rewritable).toBe(1);
    expect(dryRun.missingDocument).toBe(1);
    expect(await readFile(join(root, "markdown", "doc-1.md"), "utf8"))
      .toContain("<!-- section_id:section-1 -->");

    const applied = await rewriteMarkdownDerivatives(root, { write: true });
    expect(applied.rewritten).toBe(1);
    expect(applied.skipped).toBe(0);
    expect(applied.missingDocument).toBe(1);
    expect(await readFile(join(root, "markdown", "doc-1.md"), "utf8"))
      .not.toContain("section_id:");
  });
});
