import { describe, expect, it } from "vitest";
import { readMarkdownDirectory, scanMarkdownImport } from "../src/markdown-import.js";

function file(name: string, content: string, relativePath?: string): File {
  const value = new File([content], name, { type: "text/markdown", lastModified: 123 });
  if (relativePath) {
    Object.defineProperty(value, "webkitRelativePath", { value: relativePath });
  }
  return value;
}

describe("scanMarkdownImport", () => {
  it("matches nested folder resources and resolves ../../ references", async () => {
    const markdown = file(
      "lesson.md",
      "# Lesson\n\n![image](../../images/001.png)\n",
      "GeekTime/course/chapter/lesson.md"
    );
    const image = file("001.png", "image", "GeekTime/images/001.png");
    const scan = await scanMarkdownImport({
      mode: "folder",
      sourceFiles: [markdown, image],
      resourceFiles: []
    });

    expect(scan.documents).toHaveLength(1);
    expect(scan.documents[0]?.relativePath).toBe("GeekTime/course/chapter/lesson.md");
    expect(scan.documents[0]?.assets.map((asset) => asset.relativePath)).toEqual(["GeekTime/images/001.png"]);
    expect(scan.missingAssetCount).toBe(0);
  });

  it("skips local resources when a custom folder does not contain the Markdown", async () => {
    const markdown = file("lesson.md", "![image](images/001.png)\n");
    const image = file("001.png", "image", "assets/images/001.png");
    const scan = await scanMarkdownImport({
      mode: "file",
      sourceFiles: [markdown],
      resourceFiles: [image]
    });

    expect(scan.documents[0]?.assets).toEqual([]);
    expect(scan.documents[0]?.warnings[0]).toContain("does not contain the current Markdown");
  });

  it("reports local image references when no resource folder is selected", async () => {
    const markdown = file("lesson.md", "# Lesson\n\n![image](images/001.png)\n");
    const scan = await scanMarkdownImport({
      mode: "file",
      sourceFiles: [markdown],
      resourceFiles: []
    });

    expect(scan.referencedAssetCount).toBe(1);
    expect(scan.matchedAssetCount).toBe(0);
    expect(scan.missingAssetCount).toBe(0);
    expect(scan.documents[0]?.warnings[0]).toContain("No resource folder selected");
  });

  it("matches a single selected Markdown file by content when metadata differs", async () => {
    const selected = file("lesson.md", "# Same\n");
    const resourceCopy = file("lesson.md", "# Same\n", "root/docs/lesson.md");
    const scan = await scanMarkdownImport({
      mode: "file",
      sourceFiles: [selected],
      resourceFiles: [resourceCopy]
    });

    expect(scan.documents[0]?.relativePath).toBe("root/docs/lesson.md");
  });

  it("reads a directory handle without requiring a webkitRelativePath property", async () => {
    const markdown = file("lesson.md", "# Lesson");
    const image = file("001.png", "image");
    const docs = {
      name: "docs",
      values: async function* () {
        yield { kind: "file" as const, name: "lesson.md", getFile: async () => markdown };
      }
    };
    const root = {
      name: "root",
      values: async function* () {
        yield { kind: "directory" as const, name: "docs", values: docs.values };
        yield { kind: "file" as const, name: "001.png", getFile: async () => image };
      }
    };

    const result = await readMarkdownDirectory(root);
    expect(result.files).toEqual([markdown, image]);
    expect(result.relativePaths.get(markdown)).toBe("docs/lesson.md");
    expect(result.relativePaths.get(image)).toBe("001.png");
  });
});
