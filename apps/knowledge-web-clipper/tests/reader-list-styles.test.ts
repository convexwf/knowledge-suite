import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const itemsCss = readFileSync(new URL("../public/items.css", import.meta.url), "utf8");
const readerCss = readFileSync(new URL("../public/reader.css", import.meta.url), "utf8");
const itemsHtml = readFileSync(new URL("../public/items.html", import.meta.url), "utf8");
const readerHtml = readFileSync(new URL("../public/reader.html", import.meta.url), "utf8");
const itemsTs = readFileSync(new URL("../src/items.ts", import.meta.url), "utf8");

describe("reader list and reader style regressions", () => {
  it("uses chip filter groups instead of the old collection checkbox controls", () => {
    expect(itemsHtml).toContain('id="source-filter"');
    expect(itemsHtml).not.toContain('id="collection-filter"');
    expect(itemsHtml).not.toContain('id="hide-collection-items"');
    expect(itemsCss).toContain(".filter-chip");
    expect(itemsCss).toContain(".collection-row");
    expect(itemsCss).toContain(".collection-members-list");
    expect(itemsCss).not.toContain(".collection-card");
  });

  it("keeps collection cards aligned with item cards", () => {
    expect(itemsTs).toContain('avatar.textContent = "[i]"');
    expect(itemsTs).toContain("actions.append(detailsButton, readButton, itemsButton, more);");
    expect(itemsTs).toContain('detailsButton.title = "Collection details"');
    expect(itemsCss).toContain(".collection-actions");
    expect(itemsCss).toContain(".collection-items-button");
    expect(itemsCss).toContain(".collection-read-button");
    expect(itemsTs).toContain("`${sourceCounts.web} web`");
    expect(itemsTs).toContain("`${sourceCounts.epub} epub`");
    expect(itemsTs).toContain("`${sourceCounts.pdf} pdf`");
    expect(itemsTs).toContain("`${sourceCounts.collection} collection`");
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
