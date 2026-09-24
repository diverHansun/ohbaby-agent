import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHostLocalEnvironment } from "../../../packages/ohbaby-agent/src/adapters/ui-runtime/host-local-environment.js";
import { createBus } from "../../../packages/ohbaby-agent/src/bus/index.js";
import { createToolScheduler } from "../../../packages/ohbaby-agent/src/core/tool-scheduler/index.js";
import { formatToolResultContentForModel } from "../../../packages/ohbaby-agent/src/core/context/tool-metadata-projection.js";
import { createPermissionState } from "../../../packages/ohbaby-agent/src/permission/index.js";
import { createReadTool } from "../../../packages/ohbaby-agent/src/tools/read.js";
import { createGrepTool } from "../../../packages/ohbaby-agent/src/tools/grep.js";
import { createEditTool } from "../../../packages/ohbaby-agent/src/tools/edit.js";
import { createWriteTool } from "../../../packages/ohbaby-agent/src/tools/write.js";

describe("file tools through scheduler and model delivery", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-file-tools-")),
    );
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  function fixture() {
    const bus = createBus();
    const scheduler = createToolScheduler({
      bus,
      permissionState: createPermissionState({
        bus,
        initialLevel: "full-access",
      }),
    });
    for (const tool of [
      createReadTool(),
      createGrepTool(),
      createEditTool(),
      createWriteTool(),
    ])
      scheduler.register(tool);
    const environment = createHostLocalEnvironment(root);
    return {
      scheduler,
      execute: (toolName: string, params: Record<string, unknown>) =>
        scheduler.execute({
          callId: randomUUID(),
          messageId: "message",
          sessionId: "session",
          environment,
          toolName,
          params,
        }),
    };
  }
  it("delivers a usable long-line cursor to the model and rejects it after an edit", async () => {
    const { execute } = fixture();
    await fs.writeFile(
      path.join(root, "report.txt"),
      "中文😀".repeat(12000) + "\nEND",
    );
    const first = await execute("read", { file_path: "report.txt", limit: 1 });
    expect(first.status).toBe("success");
    expect(Buffer.byteLength(first.output!)).toBeLessThanOrEqual(51200);
    const cursor = first.metadata?.nextCursor;
    expect(cursor).toEqual(expect.any(String));
    const delivered = formatToolResultContentForModel({
      tool: "read",
      content: first.output!,
      metadata: first.metadata,
    });
    expect(delivered).toContain(String(cursor));
    const next = await execute("read", {
      file_path: "report.txt",
      cursor,
      limit: 1,
    });
    expect(next.status).toBe("success");
    const edited = await execute("edit", {
      file_path: "report.txt",
      old_string: "END",
      new_string: "CHANGED",
    });
    expect(edited.status).toBe("success");
    const stale = await execute("read", { file_path: "report.txt", cursor });
    expect(stale.status).toBe("error");
    expect(stale.error?.message).toMatch(/file has changed/iu);
  });
  it("searches beyond the old size gate and distinguishes bounded results from no matches", async () => {
    const { execute } = fixture();
    await fs.writeFile(
      path.join(root, "large.txt"),
      "padding\n".repeat(150000) + "NEEDLE one\nNEEDLE two\n",
    );
    const search = await execute("grep", {
      path: "large.txt",
      pattern: "NEEDLE",
      limit: 1,
    });
    expect(search.status).toBe("success");
    expect(search.output).toContain("NEEDLE");
    expect(search.output).toMatch(/limit|incomplete/iu);
    expect(search.output).not.toContain("No matches found.");
    const read = await execute("read", {
      file_path: "large.txt",
      offset: 150001,
      limit: 2,
    });
    expect(read.status).toBe("success");
    expect(read.output).toContain("NEEDLE two");
    const invalid = await execute("grep", {
      path: "large.txt",
      pattern: "(?<=NEEDLE)",
    });
    expect(invalid.status).toBe("error");
  });
  it("requires overwrite version checks while allowing non-UTF8 files to be replaced", async () => {
    const { execute } = fixture();
    const target = path.join(root, "legacy.txt");
    const original = Buffer.from([0xff, 0, 0xfe]);
    await fs.writeFile(target, original);
    const denied = await execute("write", {
      file_path: "legacy.txt",
      content: "safe",
    });
    expect(denied.status).toBe("error");
    expect(await fs.readFile(target)).toEqual(original);
    const result = await execute("write", {
      file_path: "legacy.txt",
      content: "safe",
      expected_mtime_ms: (await fs.stat(target)).mtimeMs,
    });
    expect(result.status).toBe("success");
    const read = await execute("read", { file_path: "legacy.txt" });
    expect(read.output).toContain("safe");
  });
});
