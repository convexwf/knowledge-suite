import { readFileSync } from "node:fs";
import vm from "node:vm";

import { parseHTML } from "linkedom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const vendorRoot = new URL("../public/vendor/", import.meta.url);

function installPreviewDom(): void {
  const { window } = parseHTML("<!doctype html><html><body></body></html>");
  const context = vm.createContext({
    console,
    document: window.document,
    globalThis: window,
    self: window,
    window
  });

  vm.runInContext(
    readFileSync(new URL("markdown-it/markdown-it.min.js", vendorRoot), "utf8"),
    context
  );
  vm.runInContext(
    readFileSync(new URL("dompurify/purify.min.js", vendorRoot), "utf8"),
    context
  );

  vi.stubGlobal("window", window);
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("Element", window.Element);
  vi.stubGlobal("HTMLAnchorElement", window.HTMLAnchorElement);
  vi.stubGlobal("HTMLImageElement", window.HTMLImageElement);
  vi.stubGlobal("NodeFilter", { SHOW_ELEMENT: 1, SHOW_TEXT: 4 });
}

function renderHtml(fragment: DocumentFragment): string {
  const container = document.createElement("div");
  container.append(fragment);
  return container.innerHTML;
}

function renderContainer(fragment: DocumentFragment): HTMLDivElement {
  const container = document.createElement("div");
  container.append(fragment);
  return container;
}

describe("markdown preview renderer", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    installPreviewDom();
  });

  it("renders common Markdown blocks and inline emphasis", async () => {
    const { renderMarkdownPreview } = await import("../src/markdown-preview/render.js");

    const container = renderContainer(renderMarkdownPreview(`
---
title: Ignored
---

#### Useful fourth-level heading

**bold** and _italic_ and [**bold link**](https://example.com)

![Alt text](https://example.com/image.png)

| A | B |
| --- | --- |
| 1 | 2 |

> quoted **text**

\`\`\`ts
const x = 1;
\`\`\`
`));
    const html = container.innerHTML;

    expect(html).toContain("<h4>Useful fourth-level heading</h4>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
    expect(container.querySelector("a")?.getAttribute("target")).toBe("_blank");
    expect(container.querySelector("a")?.getAttribute("rel")).toBe("noreferrer");
    expect(html).toContain("<strong>bold link</strong>");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://example.com/image.png");
    expect(container.querySelector("img")?.getAttribute("loading")).toBe("lazy");
    expect(html).toContain("<table>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<code");
  });

  it("sanitizes unsafe HTML and URLs", async () => {
    const { renderMarkdownPreview } = await import("../src/markdown-preview/render.js");

    const html = renderHtml(renderMarkdownPreview(`
<script>alert(1)</script>

[bad](javascript:alert(1))

![bad](javascript:alert(1))
`));

    expect(html).not.toContain("<script");
    expect(html).not.toContain("href=\"javascript:");
    expect(html).not.toContain("src=\"javascript:");
    expect(html).not.toContain("onerror");
  });

  it("keeps math preview available without KaTeX", async () => {
    const { renderMarkdownPreview } = await import("../src/markdown-preview/render.js");

    const html = renderHtml(renderMarkdownPreview("Inline $E = mc^2$.\n\n$$\\frac{a}{b}$$"));

    expect(html).toContain("math-inline");
    expect(html).toContain("math-display");
    expect(html).toContain("mc<sup>2</sup>");
    expect(html).toContain("math-frac");
  });
});
