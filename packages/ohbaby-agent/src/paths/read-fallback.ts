import { access } from "node:fs/promises";

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/**
 * Resolve a read-only compatibility path. The preferred path always wins,
 * including when it is malformed or unreadable; legacy is considered only
 * when the preferred path does not exist.
 */
export async function resolveReadPathWithLegacy(
  preferredPath: string,
  legacyPaths: readonly string[],
): Promise<string> {
  if (await pathExists(preferredPath)) {
    return preferredPath;
  }
  for (const legacyPath of legacyPaths) {
    if (await pathExists(legacyPath)) {
      return legacyPath;
    }
  }
  return preferredPath;
}
