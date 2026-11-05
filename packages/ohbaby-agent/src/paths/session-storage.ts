import fs from "node:fs/promises";
import path from "node:path";
import { resolveOhbabyHome, type OhbabyPathOptions } from "./ohbaby-home.js";

export const SUBAGENTS_DIR = "subagents";
export const SCRATCH_DIR = "scratch";
export const TOOL_RESULTS_DIR = "tool-results";

export class InvalidSessionStorageIdError extends Error {
  constructor() {
    super(
      "Session storage ID must contain 1–128 letters, digits, underscores or hyphens",
    );
    this.name = "InvalidSessionStorageIdError";
  }
}

export function resolveSessionStorageRoot(
  options: OhbabyPathOptions = {},
): string {
  return path.join(resolveOhbabyHome(options), "sessions");
}

export function resolveSessionStorageDir(
  ownerSessionId: string,
  options: OhbabyPathOptions = {},
): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(ownerSessionId))
    throw new InvalidSessionStorageIdError();
  return path.join(resolveSessionStorageRoot(options), ownerSessionId);
}

export async function ensureSessionStorage(
  ownerSessionId: string,
  options: OhbabyPathOptions = {},
): Promise<string> {
  const directory = resolveSessionStorageDir(ownerSessionId, options);
  const scratch = path.join(directory, SCRATCH_DIR);
  await fs.mkdir(scratch, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(scratch)).isSymbolicLink()) {
    throw new Error("Session scratch directory must not be a symbolic link");
  }
  if (process.platform !== "win32") {
    await fs.chmod(directory, 0o700);
    await fs.chmod(scratch, 0o700);
  }
  return fs.realpath(directory);
}
