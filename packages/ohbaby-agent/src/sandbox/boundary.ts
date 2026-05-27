import path from "node:path";
import type { SandboxPathBoundary } from "./types.js";

function normalizeForComparison(inputPath: string): string {
  const normalized = path.normalize(path.resolve(inputPath));
  const root = path.parse(normalized).root;
  const withoutTrailingSeparator =
    normalized.length > root.length
      ? normalized.replace(/[\\/]+$/u, "")
      : normalized;

  return process.platform === "win32"
    ? withoutTrailingSeparator.toLowerCase()
    : withoutTrailingSeparator;
}

export function containsOrEqualPath(parent: string, child: string): boolean {
  const normalizedParent = normalizeForComparison(parent);
  const normalizedChild = normalizeForComparison(child);
  if (normalizedParent === normalizedChild) {
    return true;
  }
  const relative = path.relative(normalizedParent, normalizedChild);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

export function classifySandboxPath(input: {
  readonly absolutePath: string;
  readonly workdir: string;
}): SandboxPathBoundary {
  return containsOrEqualPath(input.workdir, input.absolutePath)
    ? "inside"
    : "outside";
}
