import fs from "node:fs/promises";
import path from "node:path";
import {
  resolveOhbabyHome,
  type OhbabyPathOptions,
} from "../../paths/index.js";
import { MEMORY_FILENAME } from "./constants.js";

export function getGlobalMemoryPath(options: OhbabyPathOptions = {}): string {
  return path.join(resolveOhbabyHome(options), MEMORY_FILENAME);
}

export async function findProjectMemoryPath(
  startDirectory: string,
  projectRoot: string,
): Promise<string | null> {
  const root = path.resolve(projectRoot);
  let current = path.resolve(startDirectory);

  for (;;) {
    const candidate = path.join(current, MEMORY_FILENAME);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Continue walking upward until project root or filesystem root.
    }

    if (current === root) {
      return null;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}
