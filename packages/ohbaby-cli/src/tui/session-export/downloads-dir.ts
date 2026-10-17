import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface DownloadsDirInput {
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homedir?: string;
  readonly readFile?: (file: string) => string | undefined;
}

function readTextFile(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Accepts only an absolute path, optionally prefixed by $HOME. Values are never
 * shell-evaluated, so other variables, `~` and command substitution are rejected.
 */
function xdgPath(value: string | undefined, home: string): string | undefined {
  if (value === undefined) return undefined;
  let resolved = value.trim();
  const homePrefix = /^(\$HOME|\$\{HOME\})(?=\/|$)/.exec(resolved);
  if (homePrefix) resolved = home + resolved.slice(homePrefix[0].length);
  if (resolved.length === 0 || /[$`]/.test(resolved)) return undefined;
  return path.posix.isAbsolute(resolved)
    ? path.posix.normalize(resolved)
    : undefined;
}

function userDirsDownload(contents: string | undefined): string | undefined {
  if (contents === undefined) return undefined;
  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*XDG_DOWNLOAD_DIR\s*=\s*"([^"]*)"\s*$/.exec(line);
    if (match) return match[1];
  }
  return undefined;
}

/** Downloads directory per docs/services/session-export/dfd-interface.md §2.4. */
export function resolveDownloadsDir(input: DownloadsDirInput = {}): string {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const home = input.homedir ?? homedir();
  const readFile = input.readFile ?? readTextFile;

  if (platform === "win32") return path.win32.join(home, "Downloads");
  if (platform !== "linux") return path.posix.join(home, "Downloads");

  const fromEnv = xdgPath(env.XDG_DOWNLOAD_DIR, home);
  if (fromEnv !== undefined) return fromEnv;
  const configHome =
    xdgPath(env.XDG_CONFIG_HOME, home) ?? path.posix.join(home, ".config");
  const fromUserDirs = xdgPath(
    userDirsDownload(readFile(path.posix.join(configHome, "user-dirs.dirs"))),
    home,
  );
  return fromUserDirs ?? path.posix.join(home, "Downloads");
}
