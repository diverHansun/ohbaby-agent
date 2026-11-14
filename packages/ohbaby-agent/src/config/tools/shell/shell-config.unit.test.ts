import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadShellConfig } from "./index.js";

describe("shell task configuration", () => {
  let directory: string;
  let file: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "ohbaby-shell-config-"),
    );
    file = path.join(directory, "shell.json");
  });
  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("uses independent defaults when the file is absent", async () => {
    expect(await loadShellConfig(file)).toEqual({
      maxRunningBackgroundJobs: 10,
      maxRunningSubagentBackgroundJobs: 5,
    });
  });
  it("reads top-level limits independently and supports UTF-8 BOM", async () => {
    await fs.writeFile(file, '\uFEFF{"maxRunningBackgroundJobs":17}');
    expect(await loadShellConfig(file)).toEqual({
      maxRunningBackgroundJobs: 17,
      maxRunningSubagentBackgroundJobs: 5,
    });
    await fs.writeFile(file, '{"maxRunningSubagentBackgroundJobs":2}');
    expect(await loadShellConfig(file)).toEqual({
      maxRunningBackgroundJobs: 10,
      maxRunningSubagentBackgroundJobs: 2,
    });
  });
  it("rejects invalid values, malformed JSON and read errors instead of silently using defaults", async () => {
    for (const raw of [
      '{"maxRunningBackgroundJobs":0}',
      '{"maxRunningSubagentBackgroundJobs":1.5}',
      '{"maxRunningBackgroundJobs":"5"}',
      "null",
      "{broken",
    ]) {
      await fs.writeFile(file, raw);
      await expect(loadShellConfig(file)).rejects.toThrow(
        "shell configuration",
      );
    }
    await expect(loadShellConfig(directory)).rejects.toThrow(
      "shell configuration",
    );
  });
});
