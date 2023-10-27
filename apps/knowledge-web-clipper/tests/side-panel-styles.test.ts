import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const sidePanelCss = readFileSync(new URL("../public/side-panel.css", import.meta.url), "utf8");

describe("side panel stylesheet regressions", () => {
  it("keeps rendered preview content inheriting the reading scale", () => {
    expect(sidePanelCss).toContain(".preview-output p,");
    expect(sidePanelCss).toContain(".preview-output li,");
    expect(sidePanelCss).toContain("font-size: inherit;");
    expect(sidePanelCss).toContain("line-height: inherit;");
    expect(sidePanelCss).toContain("color: inherit;");
  });

  it("renders save feedback as toast instead of toolbar detail copy", () => {
    expect(sidePanelCss).toContain(".status-toast");
    expect(sidePanelCss).toContain("position: fixed;");
    expect(sidePanelCss).toContain("bottom: 16px;");
  });

  it("keeps diagnostics disclosure present with near-zero layout height", () => {
    expect(sidePanelCss).toContain(".diagnostics-toggle-row");
    expect(sidePanelCss).toContain("height: 0;");
    expect(sidePanelCss).toContain("overflow: visible;");
    expect(sidePanelCss).toContain(".diagnostics-toggle");
  });
});
