import { describe, expect, it } from "vitest";
import type { KnowledgeDocument } from "@uknowledge/knowledge-schema";
import { documentToMarkdown } from "./markdown.js";

describe("document markdown generation", () => {
  it("keeps section identities in JSON without exposing them in Markdown", () => {
    const document: KnowledgeDocument = {
      doc_id: "doc-1",
      meta: {
        title: "Clean document",
        source: { type: "html" },
        ingested_at: "2026-08-23T00:00:00.000Z"
      },
      sections: [
        { section_id: "heading-1", type: "heading", level: 2, content: "Heading" },
        { section_id: "paragraph-1", type: "paragraph", content: "Body" }
      ]
    };

    const markdown = documentToMarkdown(document);

    expect(document.sections.every((section) => section.section_id)).toBe(true);
    expect(markdown).toContain("## Heading");
    expect(markdown).toContain("Body");
    expect(markdown).not.toContain("section_id:");
  });
});
