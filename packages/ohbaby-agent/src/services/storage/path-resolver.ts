import { mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { resolveOhbabyDataRoot } from "../../paths/index.js";
import { InvalidStorageKeyError } from "./errors.js";
import type { StorageKey } from "./types.js";

function defaultStorageRoot(): string {
  if (process.env.OHBABY_STORAGE_ROOT) {
    return process.env.OHBABY_STORAGE_ROOT;
  }
  return join(resolveOhbabyDataRoot(), "storage");
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
