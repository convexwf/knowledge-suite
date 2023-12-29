import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { buildSectionElementIndex, sectionIdAtReadingLine } from "../src/reader-progress.js";

describe("reader section progress helpers", () => {
  it("indexes the first rendered element for each section ID", () => {
    const { document } = parseHTML("<!doctype html><html><body><main></main></body></html>");
    const root = document.querySelector("main") as HTMLElement;
    root.innerHTML = `
      <figure data-section-id="figure-1"></figure>
      <p data-section-id="figure-1">caption</p>
      <p data-section-id="paragraph-1">text</p>
    `;

    const index = buildSectionElementIndex(root);

    expect(index.size).toBe(2);
    expect(index.get("figure-1")).toBe(root.firstElementChild);
    expect(index.get("paragraph-1")).toBe(root.lastElementChild);
  });

  it("finds the section at the reading line without scanning the index", () => {
    const { document } = parseHTML("<!doctype html><html><body><main><p data-section-id=\"target\">text</p></main></body></html>");
    const root = document.querySelector("main") as HTMLElement;
    const target = root.firstElementChild as HTMLElement;
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
      x: 20,
      y: 0,
      left: 20,
      top: 0,
      right: 420,
      bottom: 1000,
      width: 400,
      height: 1000,
      toJSON: () => ({})
    } as DOMRect);
    const elementAtPoint = vi.fn(() => target);
    const index = new Map([["target", target]]);

    expect(sectionIdAtReadingLine(root, index, elementAtPoint, 800)).toBe("target");
    expect(elementAtPoint).toHaveBeenCalledWith(220, 140);
  });

  it("supports direct section lookup in a document with ten thousand sections", () => {
    const { document } = parseHTML("<!doctype html><html><body><main></main></body></html>");
    const root = document.querySelector("main") as HTMLElement;
    for (let index = 0; index < 10_000; index += 1) {
      const section = document.createElement("p");
      section.dataset.sectionId = `section-${index}`;
      root.append(section);
    }
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
      x: 20,
      y: 0,
      left: 20,
      top: 0,
      right: 420,
      bottom: 1000,
      width: 400,
      height: 1000,
      toJSON: () => ({})
    } as DOMRect);
    const index = buildSectionElementIndex(root);
    const target = index.get("section-9999")!;
    const elementAtPoint = vi.fn(() => target);

    expect(index.size).toBe(10_000);
    expect(sectionIdAtReadingLine(root, index, elementAtPoint, 800)).toBe("section-9999");
    expect(elementAtPoint).toHaveBeenCalledTimes(1);
  });

  it("returns no section when the reading line misses rendered sections", () => {
    const { document } = parseHTML("<!doctype html><html><body><main></main></body></html>");
    const root = document.querySelector("main") as HTMLElement;
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
      x: 20,
      y: 0,
      left: 20,
      top: 0,
      right: 420,
      bottom: 1000,
      width: 400,
      height: 1000,
      toJSON: () => ({})
    } as DOMRect);

    expect(sectionIdAtReadingLine(root, new Map(), () => null, 800)).toBeNull();
  });
});
