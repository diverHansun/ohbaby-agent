import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstanceStore } from "./instance-store.js";
import {
  resolveWorkspaceScope,
  WorkspaceScopeError,
} from "./workspace-scope.js";

describe("InstanceStore", () => {
  it("deduplicates concurrent loads for the same canonical scope", async () => {
    let releaseCreate: (() => void) | undefined;
    const create = vi.fn(
      () =>
        new Promise<{ dispose(): void }>((resolve) => {
          releaseCreate = (): void => {
            resolve({ dispose: vi.fn() });
          };
        }),
    );
    const store = new InstanceStore({
      create,
      resolveScope: (): Promise<string> => Promise.resolve("/repo"),
    });

    const first = store.load("/repo/a");
    const second = store.load("/repo/b");
    await vi.waitFor((): void => {
      expect(create).toHaveBeenCalledTimes(1);
    });
    releaseCreate?.();

    await expect(first).resolves.toBe(await second);
    expect(store.loadedScopeKeys()).toEqual(["/repo"]);
  });

  it("evicts a failed creation so a later load can retry", async () => {
    const instance = { dispose: vi.fn() };
    const create = vi
      .fn<() => Promise<typeof instance>>()
      .mockRejectedValueOnce(new Error("load failed"))
      .mockResolvedValueOnce(instance);
    const store = new InstanceStore({
      create,
      resolveScope: (): Promise<string> => Promise.resolve("/repo"),
    });

    await expect(store.load("/repo")).rejects.toThrow("load failed");
    await expect(store.load("/repo")).resolves.toBe(instance);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("disposes every successfully loaded instance", async () => {
    const disposeA = vi.fn();
    const disposeB = vi.fn();
    const store = new InstanceStore({
      create: (scopeKey: string): Promise<{ dispose(): void }> =>
        Promise.resolve({ dispose: scopeKey === "/a" ? disposeA : disposeB }),
      resolveScope: (directory: string): Promise<string> =>
        Promise.resolve(directory),
    });
    await Promise.all([store.load("/a"), store.load("/b")]);

    await store.disposeAll();

    expect(disposeA).toHaveBeenCalledTimes(1);
    expect(disposeB).toHaveBeenCalledTimes(1);
    expect(store.loadedScopeKeys()).toEqual([]);
  });
});

describe("resolveWorkspaceScope", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupDirs
        .splice(0)
        .map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  it("canonicalizes a nested directory to its git root", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohbaby-workspace-"));
    cleanupDirs.push(root);
    const nested = join(root, "packages", "app");
    await mkdir(join(root, ".git"));
    await mkdir(nested, { recursive: true });

    await expect(resolveWorkspaceScope(nested)).resolves.toBe(
      await resolveWorkspaceScope(root),
    );
  });

  it("rejects missing, relative, unavailable, and non-directory inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohbaby-workspace-"));
    cleanupDirs.push(root);
    const file = join(root, "file.txt");
    await writeFile(file, "not a directory", "utf8");

    await expect(resolveWorkspaceScope(" ")).rejects.toMatchObject({
      code: "directory-required",
    } satisfies Partial<WorkspaceScopeError>);
    await expect(resolveWorkspaceScope("relative/path")).rejects.toMatchObject({
      code: "directory-must-be-absolute",
    } satisfies Partial<WorkspaceScopeError>);
    await expect(
      resolveWorkspaceScope(join(root, "missing")),
    ).rejects.toMatchObject({ code: "directory-unavailable" });
    await expect(resolveWorkspaceScope(file)).rejects.toMatchObject({
      code: "directory-not-directory",
    });
  });
});
