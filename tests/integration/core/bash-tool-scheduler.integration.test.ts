import { EventEmitter } from "node:events";
import type {
  ChildProcess,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBus } from "../../../packages/ohbaby-agent/src/bus/index.js";
import { createToolScheduler } from "../../../packages/ohbaby-agent/src/core/tool-scheduler/index.js";
import { createHostLocalEnvironment } from "../../../packages/ohbaby-agent/src/adapters/ui-runtime/host-local-environment.js";
import {
  createPermissionManager,
  PermissionEvent,
} from "../../../packages/ohbaby-agent/src/permission/index.js";
import { createPolicyManager } from "../../../packages/ohbaby-agent/src/policy/index.js";
import { createBashTool } from "../../../packages/ohbaby-agent/src/tools/bash.js";
import type { SpawnCommand } from "../../../packages/ohbaby-agent/src/tools/bash.js";

class FakeChildProcess extends EventEmitter {
  readonly pid = 123;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
}

let tempRoot: string;
let workspace: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-bash-scheduler-"));
  workspace = path.join(tempRoot, "workspace");
  await fs.mkdir(workspace);
  workspace = await fs.realpath(workspace);
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

function createHarness(spawn: SpawnCommand = vi.fn()) {
  const bus = createBus();
  const policy = createPolicyManager({ bus });
  const permission = createPermissionManager({ bus });
  const scheduler = createToolScheduler({ bus, permission, policy });
  const permissionUpdates: string[] = [];

  scheduler.register(
    createBashTool({
      shell: {
        acceptable: () => "/bin/bash",
        killTree: vi.fn(),
      },
      spawn,
    }),
  );
  bus.subscribe(PermissionEvent.Updated, (event) => {
    permissionUpdates.push(event.info.callId);
    permission.respond(event.info.sessionId, event.info.id, { type: "once" });
  });

  return { permissionUpdates, policy, scheduler };
}

function request(
  callId: string,
  command: string,
): Parameters<ReturnType<typeof createToolScheduler>["execute"]>[0] {
  return {
    callId,
    environment: createHostLocalEnvironment(workspace),
    messageId: "message_1",
    params: { command },
    sessionId: "session_1",
    toolName: "bash",
  };
}

describe("bash tool scheduler integration", () => {
  it("runs approved bash commands through policy and permission", async () => {
    const child = new FakeChildProcess();
    const spawn = vi.fn<SpawnCommand>(
      (
        _file: string,
        _args: readonly string[],
        _options: SpawnOptionsWithoutStdio,
      ) => {
        queueMicrotask(() => {
          child.stdout.emit("data", "scheduler-ok\n");
          child.emit("exit", 0, null);
        });
        return child as unknown as ChildProcess;
      },
    );
    const { permissionUpdates, scheduler } = createHarness(spawn);

    await expect(
      scheduler.execute(request("bash_ok", "echo scheduler-ok")),
    ).resolves.toMatchObject({
      metadata: {
        cwd: workspace,
        exitCode: 0,
        shellKind: "bash",
        truncated: false,
      },
      output: expect.stringContaining("scheduler-ok"),
      status: "success",
    });
    expect(permissionUpdates).toEqual(["bash_ok"]);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("rejects bash in ask mode before permission is requested", async () => {
    const { permissionUpdates, policy, scheduler } = createHarness();
    policy.setMode("ask");

    await expect(
      scheduler.execute(request("bash_ask", "echo blocked")),
    ).resolves.toMatchObject({
      error: { type: "PolicyDeniedError" },
      status: "rejected",
    });
    expect(permissionUpdates).toEqual([]);
  });

  it("blocks cd escapes after permission but before spawning", async () => {
    const spawn = vi.fn<SpawnCommand>();
    const { permissionUpdates, scheduler } = createHarness(spawn);

    await expect(
      scheduler.execute(request("bash_escape", "cd .. && pwd")),
    ).resolves.toMatchObject({
      error: {
        message: expect.stringContaining("outside the workspace"),
        type: "ExecutionError",
      },
      status: "error",
    });
    expect(permissionUpdates).toEqual(["bash_escape"]);
    expect(spawn).not.toHaveBeenCalled();
  });
});
