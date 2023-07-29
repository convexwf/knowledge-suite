import { resolve, sep } from "node:path";

export function resolveInsideRoot(root: string, relativePath: string): string {
  if (!relativePath || relativePath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(relativePath)) {
    throw new Error(`Unsafe relative path: ${relativePath}`);
  }

  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, relativePath);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`Path escapes knowledge store: ${relativePath}`);
  }
  return resolvedPath;
}
