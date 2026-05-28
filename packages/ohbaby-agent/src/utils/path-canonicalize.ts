import fs from "node:fs/promises";
import path from "node:path";

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

function isMissingPathError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

export async function canonicalizePathTarget(
  inputPath: string,
): Promise<string> {
  const absolutePath = path.resolve(inputPath);
  const suffix: string[] = [];
  let current = absolutePath;

  for (;;) {
    try {
      const realPath = await fs.realpath(current);
      return suffix.length > 0
        ? path.join(realPath, ...suffix.reverse())
        : realPath;
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        return absolutePath;
      }
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}
