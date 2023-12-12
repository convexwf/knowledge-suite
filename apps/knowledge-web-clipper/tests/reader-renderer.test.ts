import { parseHTML } from "linkedom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderDocument } from "../src/reader-renderer.js";
import type { KnowledgeDocument } from "../src/types.js";

function installDom(): void {
  const { window } = parseHTML("<!doctype html><html><body></body></html>");
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("location", { href: "https://reader.test/" });
}

function documentModel(): KnowledgeDocument {
  return {
    doc_id: "doc-1",
    meta: {
      title: "Reader title",
      source: { type: "html" },
      ingested_at: "2026-08-23T00:00:00.000Z"
    },
    sections: [
      { section_id: "heading-1", type: "heading", level: 2, content: "Heading" },
      { section_id: "paragraph-1", type: "paragraph", content: "**bold** and [link](https://example.com)" },
      { section_id: "quote-1", type: "blockquote", content: "Quoted text" },
      {
        section_id: "list-1",
        type: "list",
        items: [{ text: "Parent", items: ["Child"] }]
      },
      { section_id: "code-1", type: "code", content: "const answer = 42;" },
      { section_id: "table-1", type: "table", rows: [["A", "B"], ["1", "2"]] },
      {
        section_id: "figure-1",
        type: "figure",
        assets: [
          { source_url: "https://example.com/one.png", alt: "One" },
          { source_url: "https://example.com/two.png", alt: "Two" }
        ],
        content: "Figure description"
      },
      { type: "paragraph", content: "No section identity" }
    ]
  };
}

describe("section-first reader renderer", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    installDom();
  });

  it("renders structured sections and binds every top-level block to its section", async () => {
    const target = document.createElement("main");
    await renderDocument(documentModel(), target);

    expect(target.querySelector("h1")?.textContent).toBe("Reader title");
    expect(target.querySelector("h2")?.dataset.sectionId).toBe("heading-1");
    expect(target.querySelector("strong")?.textContent).toBe("bold");
    expect(target.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
    expect(target.querySelector("blockquote")?.dataset.sectionId).toBe("quote-1");
    expect(target.querySelector("ul")?.dataset.sectionId).toBe("list-1");
    expect(target.querySelector("ul ul")?.textContent).toBe("Child");
    expect(target.querySelector("pre")?.dataset.sectionId).toBe("code-1");
    expect(target.querySelector("table")?.dataset.sectionId).toBe("table-1");

    const figureBlocks = Array.from(target.querySelectorAll("[data-section-id='figure-1']"));
    expect(figureBlocks).toHaveLength(3);
    expect(figureBlocks.filter((element) => element.tagName === "FIGURE")).toHaveLength(2);
    expect(figureBlocks.at(-1)?.tagName).toBe("P");
    expect(target.querySelector("p:last-child")?.hasAttribute("data-section-id")).toBe(false);
  });

  it("resolves stored assets without changing the section binding", async () => {
    const resolved: string[] = [];
    const objectUrls: string[] = [];
    const model = documentModel();
    const figure = model.sections.find((section) => section.type === "figure");
    if (!figure || figure.type !== "figure") throw new Error("figure fixture missing");
    figure.assets = [
      { path: "assets/asset-1", alt: "One" },
      { path: "assets/asset-2", alt: "Two" }
    ];
    const target = document.createElement("main");
    await renderDocument(model, target, {
      resolveAsset: async (assetId) => {
        resolved.push(assetId);
        return `blob:${assetId}`;
      },
      registerObjectUrl: (url) => objectUrls.push(url)
    });

    expect(resolved).toEqual(["asset-1", "asset-2"]);
    expect(objectUrls).toEqual(["blob:asset-1", "blob:asset-2"]);
    expect(Array.from(target.querySelectorAll("figure img")).map((image) => image.getAttribute("src")))
      .toEqual(["blob:asset-1", "blob:asset-2"]);
  });

  it("reports missing identities and empty legacy sections without blocking rendering", async () => {
    const diagnostics: string[] = [];
    const model = documentModel();
    model.sections.push({ type: "paragraph" });
    await renderDocument(model, document.createElement("main"), {
      onDiagnostic: (diagnostic) => diagnostics.push(`${diagnostic.kind}:${diagnostic.sectionIndex}`)
    });

    expect(diagnostics).toEqual(["missing_section_id:7", "missing_section_id:8", "empty_section:8"]);
  });
});
