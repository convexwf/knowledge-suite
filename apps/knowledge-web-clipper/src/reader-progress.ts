export type SectionElementIndex = Map<string, HTMLElement>;

export function buildSectionElementIndex(root: ParentNode): SectionElementIndex {
  const index: SectionElementIndex = new Map();
  for (const element of Array.from(root.querySelectorAll<HTMLElement>("[data-section-id]"))) {
    const sectionId = element.dataset.sectionId;
    if (sectionId && !index.has(sectionId)) {
      index.set(sectionId, element);
    }
  }
  return index;
}

export function sectionIdAtReadingLine(
  root: HTMLElement,
  sectionIndex: ReadonlyMap<string, HTMLElement>,
  elementAtPoint: (x: number, y: number) => Element | null,
  viewportHeight: number,
  readingLine = 140
): string | null {
  if (sectionIndex.size === 0 || viewportHeight <= 0) return null;
  const bounds = root.getBoundingClientRect();
  if (bounds.width <= 0) return null;

  const x = bounds.left + bounds.width / 2;
  const y = Math.min(Math.max(readingLine, 0), viewportHeight - 1);
  for (const offset of [0, -20, 20, -40, 40]) {
    const probeY = y + offset;
    if (probeY < 0 || probeY >= viewportHeight) continue;
    let element = elementAtPoint(x, probeY);
    while (element && element !== root) {
      const sectionId = (element as HTMLElement).dataset?.sectionId;
      if (sectionId && sectionIndex.has(sectionId)) return sectionId;
      element = element.parentElement;
    }
  }
  return null;
}
