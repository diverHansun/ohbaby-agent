import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ensureSessionStorage,
  resolveSessionStorageDir,
  resolveSessionStorageRoot,
  InvalidSessionStorageIdError,
} from "./session-storage.js";
let home: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-session-storage-"));
  vi.stubEnv("OHBABY_HOME", home);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});
it("prepares only scratch at a canonical private owner directory and preserves existing files", async () => {
  expect(resolveSessionStorageRoot()).toBe(path.join(home, "sessions"));
  expect(resolveSessionStorageDir("session_1")).toBe(
    path.join(home, "sessions", "session_1"),
  );
  const directory = await ensureSessionStorage("session_1");
  expect(directory).toBe(
    await fs.realpath(path.join(home, "sessions", "session_1")),
  );
  expect(await fs.readdir(directory)).toEqual(["scratch"]);
  if (process.platform !== "win32")
    for (const target of [directory, path.join(directory, "scratch")])
      expect((await fs.stat(target)).mode & 0o777).toBe(0o700);
  await fs.writeFile(path.join(directory, "scratch", "keep.txt"), "keep");
  await ensureSessionStorage("session_1");
  expect(
    await fs.readFile(path.join(directory, "scratch", "keep.txt"), "utf8"),
  ).toBe("keep");
  await expect(
    fs.stat(path.join(home, "sessions", "never_run")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
it.each(["", "..", "a/b", "a\\b", "x".repeat(129)])(
  "rejects unsafe owner ID %s",
  (id) => {
    expect(() => resolveSessionStorageDir(id)).toThrow(
      InvalidSessionStorageIdError,
    );
  },
);

it("rejects a redirected scratch root before chmod or exposing system reports as writable scratch", async () => {
  const directory = path.join(home, "sessions", "owner");
  const reports = path.join(directory, "subagents");
  await fs.mkdir(reports, { recursive: true, mode: 0o755 });
  await fs.writeFile(path.join(reports, "report.txt"), "system record");
  await fs.symlink(reports, path.join(directory, "scratch"), "junction");
  const mode = (await fs.stat(reports)).mode & 0o777;
  await expect(ensureSessionStorage("owner")).rejects.toThrow("scratch");
  expect((await fs.stat(reports)).mode & 0o777).toBe(mode);
  expect(await fs.readFile(path.join(reports, "report.txt"), "utf8")).toBe(
    "system record",
  );
});
