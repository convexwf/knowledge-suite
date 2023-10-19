export interface HeadingSelectionState {
  level: number;
  checked: boolean;
}

export function applyCascadeSelection(
  rows: HeadingSelectionState[],
  changedIndex: number
): HeadingSelectionState[] {
  if (changedIndex < 0 || changedIndex >= rows.length) {
    return rows.map((row) => ({ ...row }));
  }

  const next = rows.map((row) => ({ ...row }));
  const targetLevel = next[changedIndex].level;
  const checked = next[changedIndex].checked;

  if (checked) {
    for (const descendantIndex of findDescendantIndices(next, changedIndex)) {
      next[descendantIndex].checked = true;
    }
    return next;
  }

  for (const descendantIndex of findDescendantIndices(next, changedIndex)) {
    next[descendantIndex].checked = false;
  }

  for (const ancestorIndex of findAncestorIndices(next, changedIndex)) {
    next[ancestorIndex].checked = false;
  }

  return next;
}

export function normalizeHeadingSelections(rows: HeadingSelectionState[]): HeadingSelectionState[] {
  let next = rows.map((row) => ({ ...row }));
  for (let i = 0; i < next.length; i += 1) {
    if (!next[i].checked) continue;
    next = applyCascadeSelection(next, i);
  }
  return next;
}

function findDescendantIndices(rows: HeadingSelectionState[], changedIndex: number): number[] {
  const descendants: number[] = [];
  const targetLevel = rows[changedIndex].level;
  for (let i = changedIndex + 1; i < rows.length; i += 1) {
    if (rows[i].level <= targetLevel) break;
    descendants.push(i);
  }
  return descendants;
}

function findAncestorIndices(rows: HeadingSelectionState[], changedIndex: number): number[] {
  const ancestors: number[] = [];
  let currentAncestorLevel = rows[changedIndex].level;
  for (let i = changedIndex - 1; i >= 0; i -= 1) {
    if (rows[i].level >= currentAncestorLevel) continue;
    ancestors.push(i);
    currentAncestorLevel = rows[i].level;
    if (currentAncestorLevel === 1) break;
  }
  return ancestors;
}
