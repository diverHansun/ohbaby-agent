import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostLocalEnvironment } from "./host-local-environment.js";

const cleanupDirectories: string[] = [];

afterEach(async () => {
  for (const directory of cleanupDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

function normalizeForBoundary(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

describe("createHostLocalEnvironment", () => {
  it("allows relative writes inside a canonicalized temporary workspace", async () => {
    const workdir = await mkdtemp(path.join(tmpdir(), "ohbaby-host-local-"));
    cleanupDirectories.push(workdir);
    const environment = createHostLocalEnvironment(workdir);

    const resolved = await environment.resolvePathForWrite("inside.txt");
    const canonicalWorkdir = await realpath(workdir);

    expect(path.basename(resolved)).toBe("inside.txt");
    expect(
      path.relative(
        normalizeForBoundary(canonicalWorkdir),
        normalizeForBoundary(resolved),
      ),
    ).toBe("inside.txt");
  });

  it("does not require the workspace directory to exist at environment creation time", () => {
    const workdir = path.join(tmpdir(), "ohbaby-host-local-missing-workspace");

    expect(() => createHostLocalEnvironment(workdir)).not.toThrow();
  });

  it("allows explicit absolute paths outside the workspace", async () => {
    const workdir = await mkdtemp(path.join(tmpdir(), "ohbaby-host-local-"));
    const outside = await mkdtemp(path.join(tmpdir(), "ohbaby-host-outside-"));
    cleanupDirectories.push(workdir, outside);
    const outsideFile = path.join(outside, "note.txt");
    await writeFile(outsideFile, "external\n", "utf8");
    const environment = createHostLocalEnvironment(workdir);

    await expect(environment.resolvePathForExisting(outsideFile)).resolves.toBe(
      await realpath(outsideFile),
    );
    await mkdir(path.join(outside, "new-parent"));
    await expect(
      environment.resolvePathForWrite(
        path.join(outside, "new-parent", "new.txt"),
      ),
    ).resolves.toBe(
      path.join(await realpath(path.join(outside, "new-parent")), "new.txt"),
    );
  });
});
