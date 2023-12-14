import { describe, expect, it } from "vitest";
import { documentToMarkdown } from "./markdown.js";
import { parseMarkdown } from "./markdown-import.js";

describe("parseMarkdown", () => {
  it("maps frontmatter and GFM blocks into sections", async () => {
    const parsed = await parseMarkdown(Buffer.from([
      "---",
      "title: Course title",
      "tags: [one, two]",
      "source_zip: original.zip",
      "---",
      "",
      "# Course title",
      "",
      "## 目录",
      "",
      "- [Chapter](#chapter)",
      "",
      "```ts",
      "const answer = 42;",
      "```",
      "",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      ""
    ].join("\n"), "utf8"), { sourceUri: "course.md" });

    expect(parsed.itemId).toMatch(/^markdown:sha256:/);
    expect(parsed.document.meta.title).toBe("Course title");
    expect(parsed.document.meta.tags).toEqual(["one", "two"]);
    expect(parsed.rawdoc.metadata?.frontmatter).toEqual({
      title: "Course title",
      tags: ["one", "two"],
      source_zip: "original.zip"
    });
    expect(parsed.document.sections.map((section) => section.type)).toEqual([
      "heading", "heading", "list", "code", "table"
    ]);
    expect(parsed.document.sections.every((section) => section.section_id)).toBe(true);
    expect(parsed.document.sections[1]?.anchor_id).toBe("目录");
    expect(parsed.document.sections[3]?.language).toBe("ts");
    await parsed.cleanup();
  });

  it("resolves nested local assets relative to the Markdown path", async () => {
    const parsed = await parseMarkdown(Buffer.from("![one](../../images/001.png)\n", "utf8"), {
      sourceUri: "lesson.md",
      relativePath: "course/chapter/lesson.md",
      assets: [{ filename: "images/001.png", bytes: Buffer.from("image") }]
    });

    const asset = parsed.document.sections[0]?.assets?.[0];
    expect(asset?.relative_path).toBe("images/001.png");
    expect(asset?.path).toMatch(/knowledge-markdown-[^/]+\/assets\/images\/001\.png$/);
    expect(parsed.warnings).toEqual([]);
    await parsed.cleanup();
  });

  it("reports missing local assets without blocking text import", async () => {
    const parsed = await parseMarkdown(Buffer.from("# Title\n\n![missing](images/missing.png)\n", "utf8"), {
      sourceUri: "lesson.md",
      relativePath: "lesson.md"
    });

    expect(parsed.document.sections.some((section) => section.type === "heading")).toBe(true);
    expect(parsed.document.sections.some((section) => section.type === "figure")).toBe(false);
    expect(parsed.warnings).toContain("Missing local image: images/missing.png");
    await parsed.cleanup();
  });

  it("does not emit section_id protocol comments in derived Markdown", async () => {
    const parsed = await parseMarkdown(Buffer.from("<!-- section_id:old -->\n# Title\n\nBody\n", "utf8"), {
      sourceUri: "lesson.md"
    });
    const output = documentToMarkdown(parsed.document);
    expect(output).toContain("# Title");
    expect(output).not.toContain("section_id:");
    await parsed.cleanup();
  });
});
