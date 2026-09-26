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

// Only resource keys use this cache; execution and permission paths retain their
// real spelling. Unknown volume behavior stays conservative for this process.
const caseSensitiveVolumes = new Map<number, Promise<boolean>>();

async function resourceCaseSensitive(
  device: number,
  existingPath: string,
): Promise<boolean> {
  const cached = caseSensitiveVolumes.get(device);
  if (cached) return cached;
  const probe = (async (): Promise<boolean> => {
    let current = existingPath;
    while (path.dirname(current) !== current) {
      const parent = path.dirname(current);
      const parentStat = await fs.stat(parent);
      const name = path.basename(current);
      const alternate = name.replace(/[a-zA-Z]/u, (letter) =>
        letter === letter.toLowerCase()
          ? letter.toUpperCase()
          : letter.toLowerCase(),
      );
      if (parentStat.dev === device && alternate !== name) {
        const original = await fs.stat(current);
        try {
          const alias = await fs.stat(path.join(parent, alternate));
          return alias.dev !== original.dev || alias.ino !== original.ino;
        } catch (error) {
          if (errorCode(error) === "ENOENT") return true;
          return false;
        }
      }
      if (parentStat.dev !== device) return false;
      current = parent;
    }
    return false;
  })().catch(() => false);
  caseSensitiveVolumes.set(device, probe);
  return probe;
}

/** Canonical resource identity, never a path to pass to filesystem operations. */
export async function canonicalizeResourcePath(
  inputPath: string,
): Promise<string> {
  const target = await canonicalizePathTarget(inputPath);
  if (process.platform === "win32") return target.toLowerCase();
  if (process.platform !== "darwin") return target;

  let existing = target;
  const missing: string[] = [];
  let existingStat;
  for (;;) {
    try {
      existingStat = await fs.stat(existing);
      break;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
  const sensitive = await resourceCaseSensitive(existingStat.dev, existing);
  const parts = missing.map((part) => (sensitive ? part : part.toLowerCase()));
  let current = existing;
  while (path.dirname(current) !== current) {
    const parent = path.dirname(current);
    const parentStat = await fs.stat(parent);
    const parentSensitive = await resourceCaseSensitive(
      parentStat.dev,
      current,
    );
    const name = path.basename(current);
    parts.unshift(parentSensitive ? name : name.toLowerCase());
    current = parent;
  }
  return path.join(current, ...parts);
}
