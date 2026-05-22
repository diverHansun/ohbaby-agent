import { mkdir } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { InvalidStorageKeyError } from "./errors.js";
import type { StorageKey } from "./types.js";

const APP_DIR_NAME = "ohbaby-agent";

function defaultStorageRoot(): string {
  if (process.env.OHBABY_STORAGE_ROOT) {
    return process.env.OHBABY_STORAGE_ROOT;
  }
  if (process.env.XDG_DATA_HOME) {
    return join(process.env.XDG_DATA_HOME, APP_DIR_NAME, "storage");
  }
  if (platform() === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      APP_DIR_NAME,
      "storage",
    );
  }
  if (platform() === "win32") {
    return join(
      process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
      APP_DIR_NAME,
      "storage",
    );
  }
  return join(homedir(), ".local", "share", APP_DIR_NAME, "storage");
}

export class PathResolver {
  readonly rootDir: string;

  constructor(rootDir?: string) {
    this.rootDir = resolve(rootDir ?? defaultStorageRoot());
  }

  validate(key: StorageKey): void {
    if (key.length === 0) {
      throw new InvalidStorageKeyError(
        key,
        "key must contain at least one segment",
      );
    }
    for (const segment of key) {
      if (segment.length === 0) {
        throw new InvalidStorageKeyError(key, "segments cannot be empty");
      }
      if (segment === "." || segment === "..") {
        throw new InvalidStorageKeyError(key, "segments cannot be dot paths");
      }
      if (segment.startsWith(".tmp-")) {
        throw new InvalidStorageKeyError(
          key,
          "segments cannot use storage internal temporary prefixes",
        );
      }
      if (segment.includes("/") || segment.includes("\\")) {
        throw new InvalidStorageKeyError(
          key,
          "segments cannot contain path separators",
        );
      }
      if (segment.includes(":")) {
        throw new InvalidStorageKeyError(
          key,
          "segments cannot contain drive or protocol separators",
        );
      }
    }
  }

  resolve(key: StorageKey): string {
    this.validate(key);
    const path = resolve(this.rootDir, ...key);
    const relation = relative(this.rootDir, path);
    if (
      relation === "" ||
      relation === ".." ||
      relation.startsWith(`..${sep}`) ||
      resolve(path) !== path
    ) {
      throw new InvalidStorageKeyError(
        key,
        "resolved path escapes storage root",
      );
    }
    return path;
  }

  toKey(path: string): StorageKey {
    const relation = relative(this.rootDir, path);
    if (relation === ".." || relation.startsWith(`..${sep}`)) {
      throw new InvalidStorageKeyError([path], "path escapes storage root");
    }
    return relation.split(sep).filter(Boolean);
  }

  async ensureParent(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
  }
}
