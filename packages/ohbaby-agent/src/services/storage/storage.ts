import type { Dirent } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile as defaultWriteFile,
} from "node:fs/promises";
import { atomicWrite } from "./atomic-writer.js";
import { NotFoundError } from "./errors.js";
import { KeyLockManager } from "./lock-manager.js";
import { PathResolver } from "./path-resolver.js";
import type { Storage, StorageKey, StorageOptions } from "./types.js";

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function sortKeys(left: StorageKey, right: StorageKey): number {
  return left.join("\0").localeCompare(right.join("\0"));
}

const GLOBAL_LOCK_MANAGER = new KeyLockManager();

export function createStorage(options: StorageOptions = {}): Storage {
  const resolver = new PathResolver(options.rootDir);
  const lockManager = GLOBAL_LOCK_MANAGER;
  const writeFile = options.writeFile ?? defaultWriteFile;

  function lockKey(path: string): string {
    return options.caseInsensitivePaths ? path.toLowerCase() : path;
  }

  function encodeJson(value: unknown): string {
    if (value === undefined) {
      throw new TypeError("Storage JSON value must be JSON-serializable");
    }
    const content = JSON.stringify(value, null, 2);
    return `${content}\n`;
  }

  async function readBytesInternal(key: StorageKey): Promise<Uint8Array> {
    const path = resolver.resolve(key);
    try {
      const buffer = await readFile(path);
      return new Uint8Array(buffer);
    } catch (error) {
      if ((error as { readonly code?: unknown }).code === "ENOENT") {
        throw new NotFoundError(key);
      }
      throw error;
    }
  }

  async function writeBytesInternal(
    key: StorageKey,
    content: Uint8Array,
  ): Promise<void> {
    const path = resolver.resolve(key);
    await resolver.ensureParent(path);
    await lockManager.exclusive(lockKey(path), () =>
      atomicWrite({ key, targetPath: path, data: content, writeFile }),
    );
  }

  async function collectKeys(directory: string): Promise<StorageKey[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as { readonly code?: unknown }).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const keys: StorageKey[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".tmp-")) {
        continue;
      }
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        keys.push(...(await collectKeys(path)));
      } else if (entry.isFile()) {
        keys.push(resolver.toKey(path));
      }
    }
    return keys;
  }

  return {
    async readText(key: StorageKey): Promise<string> {
      const bytes = await readBytesInternal(key);
      return Buffer.from(bytes).toString("utf8");
    },

    async writeText(
      key: StorageKey,
      content: string,
    ): Promise<void> {
      await writeBytesInternal(key, Buffer.from(content, "utf8"));
    },

    readBytes(key: StorageKey): Promise<Uint8Array> {
      return readBytesInternal(key);
    },

    writeBytes(
      key: StorageKey,
      content: Uint8Array,
    ): Promise<void> {
      return writeBytesInternal(key, content);
    },

    async readJson<T>(key: StorageKey): Promise<T> {
      return JSON.parse(await this.readText(key)) as T;
    },

    async writeJson(
      key: StorageKey,
      value: unknown,
    ): Promise<void> {
      await this.writeText(key, encodeJson(value));
    },

    async updateJson<T>(key: StorageKey, fn: (draft: T) => void): Promise<T> {
      const path = resolver.resolve(key);
      return lockManager.exclusive(lockKey(path), async () => {
        const current = JSON.parse(
          Buffer.from(await readBytesInternal(key)).toString("utf8"),
        ) as T;
        const draft = cloneJson(current);
        fn(draft);
        await resolver.ensureParent(path);
        await atomicWrite({
          key,
          targetPath: path,
          data: encodeJson(draft),
          writeFile,
        });
        return draft;
      });
    },

    async exists(key: StorageKey): Promise<boolean> {
      const path = resolver.resolve(key);
      try {
        const stats = await stat(path);
        return stats.isFile();
      } catch (error) {
        if ((error as { readonly code?: unknown }).code === "ENOENT") {
          return false;
        }
        throw error;
      }
    },

    async remove(key: StorageKey): Promise<void> {
      const path = resolver.resolve(key);
      await lockManager.exclusive(lockKey(path), () =>
        rm(path, { force: true }),
      );
    },

    async list(prefix: StorageKey): Promise<StorageKey[]> {
      const path = resolver.resolve(prefix);
      await mkdir(resolver.rootDir, { recursive: true });
      const keys = await collectKeys(path);
      return keys.sort(sortKeys);
    },
  };
}
