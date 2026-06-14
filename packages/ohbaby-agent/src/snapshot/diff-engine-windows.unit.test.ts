import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

const cleanupPaths: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanupPaths.push(directory);
  return directory;
}

afterEach(async () => {
  vi.doUnmock("node:child_process");
  vi.resetModules();
  await Promise.all(
    cleanupPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("GitSnapshotEngine Windows process launching", () => {
  it("hides every git sidecar process window", async () => {
    const optionsSeen: unknown[] = [];
    const execFile = vi.fn();
    Object.assign(execFile, {
      [promisify.custom]: (
        _file: string,
        args: readonly string[],
        options: unknown,
      ) => {
        optionsSeen.push(options);
        if (args.includes("write-tree")) {
          return Promise.resolve({
            stderr: "",
            stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
          });
        }
        if (args.includes("commit-tree")) {
          return Promise.resolve({
            stderr: "",
            stdout: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n",
          });
        }
        return Promise.resolve({ stderr: "", stdout: "" });
      },
    });
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("node:child_process")>();
      return { ...actual, execFile };
    });
    const { GitSnapshotEngine } = await import("./diff-engine.js");
    const snapshotRoot = await tempDir("ohbaby-snapshot-root-");
    const workdir = await tempDir("ohbaby-snapshot-workdir-");
    const engine = new GitSnapshotEngine({ snapshotRoot });

    await expect(
      engine.recordBaseline("checkpoint_1", workdir),
    ).resolves.toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

    expect(optionsSeen.length).toBeGreaterThan(0);
    expect(optionsSeen).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ windowsHide: true }),
      ]),
    );
    expect(
      optionsSeen.every(
        (options) =>
          typeof options === "object" &&
          options !== null &&
          "windowsHide" in options &&
          (options as { readonly windowsHide?: unknown }).windowsHide === true,
      ),
    ).toBe(true);
  });
});
