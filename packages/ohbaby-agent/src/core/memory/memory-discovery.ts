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

async function canonicalPath(filePath: string): Promise<string> {
  try {
    return await fs.realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

export async function findProjectMemoryPath(
  startDirectory: string,
  projectRoot: string,
): Promise<string | null> {
  const root = await canonicalPath(projectRoot);
  let current = await canonicalPath(startDirectory);
  if (!isWithin(root, current)) {
    return null;
  }

  for (;;) {
    const candidate = path.join(current, MEMORY_FILENAME);
    try {
      const canonicalCandidate = await fs.realpath(candidate);
      if (isWithin(root, canonicalCandidate)) {
        return canonicalCandidate;
      }
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
