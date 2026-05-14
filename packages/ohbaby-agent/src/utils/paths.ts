import fs from "node:fs";
import path from "node:path";

function normalizeForComparison(value: string): string {
  const normalized = normalizePath(value);
  const withoutTrailingSeparator =
    normalized.length > path.parse(normalized).root.length
      ? normalized.replace(/[\\/]+$/u, "")
      : normalized;

  return process.platform === "win32"
    ? withoutTrailingSeparator.toLowerCase()
    : withoutTrailingSeparator;
}

export function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return path.normalize(resolved);
  }
}

export function containsOrEqual(parent: string, child: string): boolean {
  const normalizedParent = normalizeForComparison(parent);
  const normalizedChild = normalizeForComparison(child);
  if (normalizedParent === normalizedChild) {
    return true;
  }
  const relative = path.relative(normalizedParent, normalizedChild);

  return (
    relative !== "" &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

export function contains(parent: string, child: string): boolean {
  return (
    normalizeForComparison(parent) !== normalizeForComparison(child) &&
    containsOrEqual(parent, child)
  );
}

export function overlaps(first: string, second: string): boolean {
  return containsOrEqual(first, second) || containsOrEqual(second, first);
}
