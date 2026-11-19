import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  acquireUninstallLock,
  removeOwnedLauncher,
  removeShellPathBlock,
  validateUninstallDirectory,
} from "./script-uninstall.js";
import { PATH_END, PATH_START, planUninstall } from "./uninstall-plan.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ohbaby-uninstall-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("protects data inside custom installation directories and shares the installer lock", async () => {
  const installDir = join(root, "install");
  await mkdir(join(installDir, "releases"), { recursive: true });
  await writeFile(join(installDir, "current"), "0.1.18\n");
  await expect(
    validateUninstallDirectory(installDir, [root, join(root, "data")]),
  ).resolves.toBeUndefined();
  await expect(
    validateUninstallDirectory(installDir, [
      join(installDir, "data", "ohbaby.db"),
    ]),
  ).rejects.toThrow("protected");
  const release = await acquireUninstallLock(installDir);
  await expect(
    readFile(join(`${installDir}.lock`, "pid"), "utf8"),
  ).resolves.toBe(`${String(process.pid)}\n`);
  await expect(acquireUninstallLock(installDir)).rejects.toThrow(
    "Another installation",
  );
  await release();
  await mkdir(`${installDir}.lock.reclaim`);
  await expect(acquireUninstallLock(installDir)).rejects.toThrow(
    "recovery is in progress",
  );
  await expect(
    readFile(join(`${installDir}.lock`, "pid"), "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("removes only marked shell settings and launchers owned by the current installation", async () => {
  const path = join(root, ".zshrc");
  await writeFile(
    path,
    `user before\r\n${PATH_START}\r\nexport PATH=...\r\n${PATH_END}\r\nuser after\r\n`,
  );
  await removeShellPathBlock(path, false);
  await expect(readFile(path, "utf8")).resolves.toBe(
    "user before\r\nuser after\r\n",
  );

  const launcher = join(root, "launcher");
  const script =
    "#!/bin/sh\n# ohbaby-launcher 1\nOHBABY_INSTALL_DIR='/somewhere/else'\n";
  await writeFile(launcher, script);
  await removeOwnedLauncher(launcher, join(root, "install"));
  await expect(readFile(launcher, "utf8")).resolves.toBe(script);
  await removeOwnedLauncher(launcher, "/somewhere/else");
  await expect(readFile(launcher, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("leaves Windows installation deletion to the user", () => {
  expect(
    planUninstall(
      { kind: "script", installDir: "C:\\Users\\A B\\install" },
      "win32",
      "C:\\Users\\A B",
    ),
  ).toEqual([
    { kind: "windows-path", path: "C:\\Users\\A B\\install\\bin" },
    { kind: "windows-manual", path: "C:\\Users\\A B\\install" },
  ]);
});
