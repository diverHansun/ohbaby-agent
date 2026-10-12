import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGlobTool } from "./glob.js";
import { withFileAccess } from "./utils/file-access.js";
import {
  createToolScheduler,
  type ToolExecutionEnvironment,
} from "../core/tool-scheduler/index.js";
import { createBus } from "../bus/index.js";
import { createPermissionState } from "../permission/index.js";
const boundary = vi.hoisted(() => ({
  child: undefined as unknown as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  },
  kill: vi.fn(),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn(): typeof boundary.child {
      return boundary.child;
    },
  };
});
vi.mock("../shell/process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shell/process.js")>();
  return {
    ...actual,
    killTree: boundary.kill,
    probeProcessTree: (): "unknown" => "unknown",
  };
});
describe("Glob uncertain cleanup through existing resource ownership", () => {
  let root: string;
  let env: ToolExecutionEnvironment;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-glob-uncertain-"));
    boundary.child = Object.assign(new EventEmitter(), {
      pid: 123,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    boundary.kill.mockReset();
    boundary.kill.mockResolvedValue({
      status: "unconfirmed",
      reason: "probe-failed",
    });
    env = {
      workdir: root,
      resolvePath: (value): string => path.resolve(root, value),
      resolvePathForExisting: (value): Promise<string> =>
        fs.realpath(path.resolve(root, value)),
      resolvePathForWrite: (value): Promise<string> =>
        Promise.resolve(path.resolve(root, value)),
      resolveCommandContext: (): ReturnType<
        ToolExecutionEnvironment["resolveCommandContext"]
      > => ({ kind: "host-local", cwd: root }),
    };
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  it("fails a conflicting writer instead of waiting forever while cleanup and close are unconfirmed", async () => {
    const bus = createBus();
    const scheduler = createToolScheduler({
      bus,
      permissionState: createPermissionState({
        bus,
        initialLevel: "full-access",
      }),
    });
    scheduler.register(createGlobTool());
    const write = vi.fn(() => ({ output: "written" }));
    scheduler.register(
      withFileAccess(
        {
          name: "writer",
          description: "Fixture writer",
          category: "write",
          source: "builtin",
          parametersJsonSchema: {},
          execute: write,
        },
        "write",
      ),
    );
    const identity = {
      runId: "run",
      messageId: "message",
      sessionId: "session",
      environment: env,
    };
    const abort = new AbortController();
    const glob = scheduler.execute({
      ...identity,
      callId: "glob",
      toolName: "glob",
      params: { pattern: "*", limit: 1 },
      signal: abort.signal,
    });
    let writer: ReturnType<typeof scheduler.execute> | undefined;
    try {
      await vi.waitFor(() => {
        expect(scheduler.getStatus("glob")).toBe("executing");
      });
      boundary.child.stdout.emit("data", Buffer.from("a\0b\0"));
      await vi.waitFor(() => {
        expect(boundary.kill).toHaveBeenCalledTimes(1);
      });
      writer = scheduler.execute({
        ...identity,
        callId: "writer",
        toolName: "writer",
        params: { file_path: "a" },
      });
      const result = await Promise.race([
        writer,
        new Promise<"pending">((resolve) =>
          setTimeout(() => {
            resolve("pending");
          }, 100),
        ),
      ]);
      expect(result).toMatchObject({ status: "error" });
      if (typeof result === "string")
        throw new Error("Writer was still waiting on unconfirmed cleanup.");
      expect(result.error?.message).toContain("unconfirmed cleanup");
      expect(write).not.toHaveBeenCalled();
    } finally {
      abort.abort();
      boundary.child.emit("close", 0, null);
      await glob;
      await writer;
    }
  });
  it("reports final cleanup failure after close without claiming confirmation", async () => {
    const cleanup: string[] = [];
    const pending = createGlobTool().execute(
      { pattern: "*", limit: 1 },
      {
        callId: "direct",
        messageId: "message",
        sessionId: "session",
        signal: new AbortController().signal,
        environment: env,
        reportCleanup: (state) => cleanup.push(state),
      },
    );
    await vi.waitFor(() => {
      expect(boundary.child.stdout.listenerCount("data")).toBe(1);
    });
    boundary.child.stdout.emit("data", Buffer.from("a\0b\0"));
    await vi.waitFor(() => {
      expect(boundary.kill).toHaveBeenCalledTimes(1);
    });
    boundary.child.emit("close", 0, null);
    await expect(pending).rejects.toThrow("cleanup is unconfirmed");
    expect(cleanup).toEqual(["in-progress", "unconfirmed"]);
  });
});
