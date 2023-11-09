import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const itemsCss = readFileSync(new URL("../public/items.css", import.meta.url), "utf8");
const readerCss = readFileSync(new URL("../public/reader.css", import.meta.url), "utf8");
const itemsHtml = readFileSync(new URL("../public/items.html", import.meta.url), "utf8");
const readerHtml = readFileSync(new URL("../public/reader.html", import.meta.url), "utf8");

describe("reader list and reader style regressions", () => {
  it("uses chip filter groups instead of the old collection checkbox controls", () => {
    expect(itemsHtml).toContain('id="structure-filter"');
    expect(itemsHtml).toContain('id="source-filter"');
    expect(itemsHtml).not.toContain('id="collection-filter"');
    expect(itemsHtml).not.toContain('id="hide-collection-items"');
    expect(itemsCss).toContain(".filter-chip");
    expect(itemsCss).toContain(".collection-item-index");
  });

  it("keeps collection navigation as floating hidden-by-default controls", () => {
    expect(readerHtml).toContain('id="collection-nav"');
    expect(readerHtml).toContain('hidden aria-label="Previous in collection"');
    expect(readerCss).toContain("position: fixed;");
    expect(readerCss).toContain("pointer-events: none;");
    expect(readerCss).toContain("#prev-in-collection");
    expect(readerCss).toContain("#next-in-collection");
    expect(readerCss).toContain(".reader-collection-link");
  });
});
