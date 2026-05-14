import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  createStorage,
  InvalidStorageKeyError,
  NotFoundError,
  StorageWriteError,
} from "./index.js";

const cleanupPaths: string[] = [];

async function tempRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ohbaby-storage-"));
  cleanupPaths.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("services/storage", () => {
  it("writes and reads UTF-8 text by storage key", async () => {
    const storage = createStorage({ rootDir: await tempRoot() });

    await storage.writeText(["tasks", "task_1", "stdout"], "hello\n世界");

    await expect(
      storage.readText(["tasks", "task_1", "stdout"]),
    ).resolves.toBe("hello\n世界");
  });

  it("writes and reads bytes without changing content", async () => {
    const storage = createStorage({ rootDir: await tempRoot() });
    const bytes = new Uint8Array([0, 1, 2, 255]);

    await storage.writeBytes(["artifacts", "blob"], bytes);

    await expect(storage.readBytes(["artifacts", "blob"])).resolves.toEqual(
      bytes,
    );
  });

  it("writes, reads, and updates readable JSON", async () => {
    const storage = createStorage({ rootDir: await tempRoot() });
    const key = ["debug", "state"];

    await storage.writeJson(key, { count: 1, items: ["a"] });
    const updated = await storage.updateJson<{
      count: number;
      items: string[];
    }>(key, (draft) => {
      draft.count += 1;
      draft.items.push("b");
    });

    expect(updated).toEqual({ count: 2, items: ["a", "b"] });
    await expect(storage.readJson(key)).resolves.toEqual(updated);
    await expect(storage.readText(key)).resolves.toContain('\n  "count": 2');
  });

  it("throws NotFoundError when reading a missing object", async () => {
    const storage = createStorage({ rootDir: await tempRoot() });

    await expect(storage.readText(["missing"])).rejects.toThrow(NotFoundError);
  });

  it("rejects storage keys that escape or contain path separators", async () => {
    const storage = createStorage({ rootDir: await tempRoot() });
    const invalidKeys = [
      [],
      [".."],
      ["."],
      [""],
      ["task/one"],
      ["task\\one"],
      ["C:escape"],
      ["a:b"],
      [".tmp-user-object"],
    ];

    for (const key of invalidKeys) {
      await expect(storage.writeText(key, "bad")).rejects.toThrow(
        InvalidStorageKeyError,
      );
    }
  });

  it("lists keys below a prefix and ignores siblings", async () => {
    const storage = createStorage({ rootDir: await tempRoot() });
    await storage.writeText(["snapshot", "patches", "a"], "a");
    await storage.writeText(["snapshot", "patches", "b"], "b");
    await storage.writeText(["tasks", "t1", "stdout"], "stdout");

    await expect(storage.list(["snapshot"])).resolves.toEqual([
      ["snapshot", "patches", "a"],
      ["snapshot", "patches", "b"],
    ]);
  });

  it("does not expose temporary files through list", async () => {
    const rootDir = await tempRoot();
    const storage = createStorage({ rootDir });
    await storage.writeText(["snapshot", "patches", "a"], "a");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(join(rootDir, "snapshot", "patches", ".tmp-leftover"), "tmp"),
    );

    await expect(storage.list(["snapshot"])).resolves.toEqual([
      ["snapshot", "patches", "a"],
    ]);
  });

  it("checks existence and removes objects idempotently", async () => {
    const storage = createStorage({ rootDir: await tempRoot() });
    const key = ["tasks", "task_1", "stderr"];

    await expect(storage.exists(key)).resolves.toBe(false);
    await storage.writeText(key, "err");
    await expect(storage.exists(key)).resolves.toBe(true);
    await expect(storage.exists(["tasks"])).resolves.toBe(false);
    await storage.remove(key);
    await expect(storage.exists(key)).resolves.toBe(false);
    await expect(storage.remove(key)).resolves.toBeUndefined();
  });

  it("rejects top-level undefined JSON values", async () => {
    const storage = createStorage({ rootDir: await tempRoot() });

    await expect(storage.writeJson(["debug", "undefined"], undefined)).rejects
      .toThrow(/JSON/);
  });

  it("keeps old content if an atomic write fails before replace", async () => {
    const rootDir = await tempRoot();
    let failWrites = false;
    const storage = createStorage({
      rootDir,
      writeFile: async (path, data) => {
        if (failWrites && path.includes(".tmp-")) {
          throw new Error("disk full");
        }
        await import("node:fs/promises").then((fs) =>
          fs.writeFile(path, data),
        );
      },
    });
    const key = ["snapshot", "patches", "patch_1"];

    await storage.writeText(key, "old");
    failWrites = true;
    await expect(storage.writeText(key, "new")).rejects.toThrow(
      StorageWriteError,
    );

    await expect(storage.readText(key)).resolves.toBe("old");
    await expect(
      readFile(join(rootDir, "snapshot", "patches", "patch_1"), "utf8"),
    ).resolves.toBe("old");
  });

  it("serializes concurrent updateJson calls for a single key", async () => {
    const storage = createStorage({ rootDir: await tempRoot() });
    const key = ["debug", "counter"];
    await storage.writeJson(key, { count: 0 });

    await Promise.all(
      Array.from({ length: 10 }, () =>
        storage.updateJson<{ count: number }>(key, (draft) => {
          draft.count += 1;
        }),
      ),
    );

    await expect(storage.readJson(key)).resolves.toEqual({ count: 10 });
  });
});
