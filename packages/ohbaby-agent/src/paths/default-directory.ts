import fs from "node:fs";
import path from "node:path";
import { resolveOhbabyHome, type OhbabyPathOptions } from "./ohbaby-home.js";

export const DEFAULT_DIRECTORY_MODE = 0o700;

/** Real working directory for sessions created without a selected workspace. */
export function resolveDefaultDirectory(
  options: OhbabyPathOptions = {},
): string {
  // Keep the historical on-disk path so existing user files stay in place.
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
export async function ensureDefaultDirectory(
  options: OhbabyPathOptions = {},
): Promise<string> {
  const directory = resolveDefaultDirectory(options);
  await fs.promises.mkdir(directory, {
    mode: DEFAULT_DIRECTORY_MODE,
    recursive: true,
  });
  return fs.promises.realpath(directory);
}

export function isDefaultDirectory(
  directory: string,
  options: OhbabyPathOptions = {},
): boolean {
  return (
    canonicalDirectory(directory) ===
    canonicalDirectory(resolveDefaultDirectory(options))
  );
}

/**
 * Returns the canonical default directory when `directory` is inside it.
 * Upward searches (Git root, repository detection) must stop there so a
 * repository in a parent such as $HOME never absorbs the default directory.
 */
export function defaultDirectoryBoundary(
  directory: string,
  options: OhbabyPathOptions = {},
): string | undefined {
  const root = canonicalDirectory(resolveDefaultDirectory(options));
  const relative = path.relative(root, canonicalDirectory(directory));
  return relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
    ? root
    : undefined;
}

export function isSameCanonicalDirectory(left: string, right: string): boolean {
  return canonicalDirectory(left) === canonicalDirectory(right);
}
