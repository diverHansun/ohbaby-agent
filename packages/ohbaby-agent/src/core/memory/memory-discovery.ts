import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CONFIG_DIR_NAME, MEMORY_FILENAME } from "./constants.js";

export function getGlobalMemoryPath(): string {
  const configRoot =
    process.platform === "win32"
      ? (process.env.APPDATA ?? os.homedir())
      : (process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"));

  return path.join(configRoot, CONFIG_DIR_NAME, MEMORY_FILENAME);
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
