import { describe, expect, it } from "vitest";

import { applyCascadeSelection, normalizeHeadingSelections } from "../src/heading-cascade.js";

describe("heading cascade selection", () => {
  it("checks only descendants for a selected h1 without touching sibling trees", () => {
    const next = applyCascadeSelection([
      { level: 1, checked: true },
      { level: 2, checked: false },
      { level: 3, checked: false },
      { level: 1, checked: false },
      { level: 2, checked: false }
    ], 0);

    expect(next.map((row) => row.checked)).toEqual([true, true, true, false, false]);
  });

  it("checks descendants for a selected h2 without checking its h1 ancestor", () => {
    const next = applyCascadeSelection([
      { level: 1, checked: false },
      { level: 2, checked: true },
      { level: 3, checked: false }
    ], 1);

    expect(next.map((row) => row.checked)).toEqual([false, true, true]);
  });

  it("unchecks only the current branch ancestors and descendants", () => {
    const next = applyCascadeSelection([
      { level: 1, checked: true },
      { level: 2, checked: true },
      { level: 1, checked: true },
      { level: 2, checked: false },
      { level: 3, checked: true }
    ], 3);

    expect(next.map((row) => row.checked)).toEqual([true, true, false, false, false]);
  });

  it("normalizes default checked headings so selected parents force descendants on", () => {
    const next = normalizeHeadingSelections([
      { level: 1, checked: true },
      { level: 2, checked: true },
      { level: 3, checked: false },
      { level: 1, checked: false },
      { level: 2, checked: true },
      { level: 3, checked: false }
    ]);

    expect(next.map((row) => row.checked)).toEqual([true, true, true, false, true, true]);
  });
});
