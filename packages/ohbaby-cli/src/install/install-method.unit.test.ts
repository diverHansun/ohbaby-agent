import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { detectInstallMethod } from "./install-method.js";
import { readSingleLine } from "./text-file.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ohbaby-install-method-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("accepts the script marker only for a CLI under that install directory", async () => {
  const installDir = join(root, "install");
  const packageDirectory = join(
    installDir,
    "releases",
    "0.1.18",
    "node_modules",
    "ohbaby-cli",
  );
  await mkdir(packageDirectory, { recursive: true });
  const env = { OHBABY_INSTALL_DIR: installDir };
  expect(detectInstallMethod({ packageDirectory, env })).toEqual({
    kind: "script",
    installDir: await realpath(installDir),
  });
  const checkout = join(root, "checkout");
  await mkdir(checkout);
  expect(detectInstallMethod({ packageDirectory: checkout, env })).toEqual({
    kind: "other",
  });
});

it("identifies global npm and ignores local package installations", async () => {
  const windows = process.platform === "win32";
  const prefix = join(root, "npm-prefix");
  const directory = join(
    prefix,
    ...(windows ? [] : ["lib"]),
    "node_modules",
    "ohbaby-cli",
  );
  await mkdir(directory, { recursive: true });
  if (windows) {
    const shim = join(prefix, "ohbaby.cmd");
    await writeFile(shim, "pnpm managed shim");
    expect(
      detectInstallMethod({ packageDirectory: directory, env: {} }),
    ).toEqual({ kind: "other" });
    await writeFile(
      shim,
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\node_modules\\ohbaby-cli\\dist\\bin.js" %*\r\n',
    );
  } else {
    const bin = join(prefix, "bin");
    await mkdir(bin);
    await mkdir(join(directory, "dist"));
    const entry = join(directory, "dist", "bin.js");
    await writeFile(entry, "");
    await writeFile(join(bin, "unrelated"), "");
    const launcher = join(bin, "ohbaby");
    await symlink("unrelated", launcher);
    expect(
      detectInstallMethod({ packageDirectory: directory, env: {} }),
    ).toEqual({ kind: "other" });
    await rm(launcher);
    await symlink(entry, launcher);
  }
  expect(detectInstallMethod({ packageDirectory: directory, env: {} })).toEqual(
    {
      kind: "npm",
      prefix: await realpath(prefix),
    },
  );
  const local = join(root, "project", "node_modules", "ohbaby-cli");
  await mkdir(local, { recursive: true });
  expect(detectInstallMethod({ packageDirectory: local, env: {} })).toEqual({
    kind: "other",
  });
});

it("reads text pointers written with a BOM and Windows newline", async () => {
  const path = join(root, "current");
  await writeFile(path, "\uFEFF0.1.18\r\n");
  expect(readSingleLine(path)).toBe("0.1.18");
});
