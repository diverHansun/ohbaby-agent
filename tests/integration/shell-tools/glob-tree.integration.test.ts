import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGlobTool } from "../../../packages/ohbaby-agent/src/tools/glob.js";
import { projectToolMetadataForModel } from "../../../packages/ohbaby-agent/src/core/context/tool-metadata-projection.js";
import type {
  ToolExecutionContext,
  ToolExecutionEnvironment,
} from "../../../packages/ohbaby-agent/src/core/tool-scheduler/index.js";
describe("Glob real tree scope and model completeness", () => {
  let root: string;
  let context: ToolExecutionContext;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-glob-tree-"));
    const env: ToolExecutionEnvironment = {
      workdir: root,
      resolvePath: (value) => path.resolve(root, value),
      resolvePathForExisting: (value) => fs.realpath(path.resolve(root, value)),
      resolvePathForWrite: (value) =>
        Promise.resolve(path.resolve(root, value)),
      resolveCommandContext: () => ({ kind: "host-local", cwd: root }),
    };
    context = {
      callId: "glob",
      messageId: "message",
      sessionId: "session",
      signal: new AbortController().signal,
      environment: env,
    };
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  it("ignores ignore/config settings while retaining fixed exclusions and symlink scope", async () => {
    await fs.writeFile(path.join(root, ".gitignore"), "*.ts\n");
    for (const dir of [
      "src",
      ".git",
      "dist",
      "node_modules",
      "out",
      "target",
    ]) {
      await fs.mkdir(path.join(root, dir));
      await fs.writeFile(path.join(root, dir, "entry.ts"), "");
    }
    await fs.writeFile(path.join(root, ".hidden.ts"), "");
    await fs.writeFile(path.join(root, "!name.ts"), "");
    if (process.platform !== "win32")
      await fs.symlink(
        path.join(root, "src"),
        path.join(root, "linked"),
        "dir",
      );
    const result = await createGlobTool().execute(
      { pattern: "**/*.ts" },
      context,
    );
    expect(result.output?.split("\n")).toEqual([
      "!name.ts",
      ".hidden.ts",
      "src/entry.ts",
    ]);
    expect(projectToolMetadataForModel("glob", result.metadata)).toMatchObject({
      count: 3,
      scanComplete: true,
      truncated: false,
      displayLimited: false,
    });
    const bang = await createGlobTool().execute(
      { pattern: "!name.ts" },
      context,
    );
    expect(bang.output).toBe("!name.ts");
    const empty = await createGlobTool().execute(
      { pattern: "nothing*.missing" },
      context,
    );
    expect(empty.output).toBe("No files matched.");
    expect(empty.metadata?.scanComplete).toBe(true);
    const limited = await createGlobTool().execute(
      { pattern: "**/*.ts", limit: 2 },
      context,
    );
    expect(projectToolMetadataForModel("glob", limited.metadata)).toMatchObject(
      {
        count: 2,
        scanComplete: false,
        truncated: true,
        displayLimited: false,
        stopReason: "match-limit",
      },
    );
  });
  it("finds a sparse result after more than ten thousand other files", async () => {
    await fs.mkdir(path.join(root, "noise"));
    for (let first = 0; first < 10_001; first += 100) {
      await Promise.all(
        Array.from({ length: Math.min(100, 10_001 - first) }, (_, offset) =>
          fs.writeFile(
            path.join(
              root,
              "noise",
              `${String(first + offset).padStart(5, "0")}.js`,
            ),
            "",
          ),
        ),
      );
    }
    await fs.mkdir(path.join(root, "zz-last"));
    await fs.writeFile(path.join(root, "zz-last", "found.ts"), "");
    const result = await createGlobTool().execute(
      { pattern: "**/*.ts", limit: 1 },
      context,
    );
    expect(result.output).toBe("zz-last/found.ts");
    expect(result.metadata).toMatchObject({
      count: 1,
      scanComplete: true,
      truncated: false,
    });
  }, 30_000);
});
