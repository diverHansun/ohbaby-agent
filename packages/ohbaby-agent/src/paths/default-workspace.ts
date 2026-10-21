import fs from "node:fs";
import path from "node:path";
import { resolveOhbabyHome, type OhbabyPathOptions } from "./ohbaby-home.js";

export const DEFAULT_WORKSPACE_DIR_MODE = 0o700;

/** Real working directory for sessions created without a selected project. */
export function resolveDefaultWorkspaceDirectory(
  options: OhbabyPathOptions = {},
): string {
  return path.join(resolveOhbabyHome(options), "workspace", "default");
}

function canonicalDirectory(directory: string): string {
  try {
    return fs.realpathSync.native(directory);
  } catch {
    return path.resolve(directory);
  }
}

/** Creates the directory when missing; existing contents and modes stay unchanged. */
export async function ensureDefaultWorkspaceDirectory(
  options: OhbabyPathOptions = {},
): Promise<string> {
  const directory = resolveDefaultWorkspaceDirectory(options);
  await fs.promises.mkdir(directory, {
    mode: DEFAULT_WORKSPACE_DIR_MODE,
    recursive: true,
  });
  return fs.promises.realpath(directory);
}

export function isDefaultWorkspaceDirectory(
  directory: string,
  options: OhbabyPathOptions = {},
): boolean {
  return (
    canonicalDirectory(directory) ===
    canonicalDirectory(resolveDefaultWorkspaceDirectory(options))
  );
}

/**
 * Returns the canonical default workspace when `directory` is inside it.
 * Upward searches (Git root, repository detection) must stop there so a
 * repository in a parent such as $HOME never absorbs the default workspace.
 */
export function defaultWorkspaceBoundary(
  directory: string,
  options: OhbabyPathOptions = {},
): string | undefined {
  const root = canonicalDirectory(resolveDefaultWorkspaceDirectory(options));
  const relative = path.relative(root, canonicalDirectory(directory));
  return relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
    ? root
    : undefined;
}

export function isSameCanonicalDirectory(left: string, right: string): boolean {
  return canonicalDirectory(left) === canonicalDirectory(right);
}
