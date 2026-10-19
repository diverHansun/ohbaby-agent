import { EventEmitter } from "node:events";
import { spawn as nodeSpawn } from "node:child_process";
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
import {
  createHostLocalEnvironment,
  createHostLocalSandboxManager,
} from "../../../packages/ohbaby-agent/src/adapters/ui-runtime/host-local-environment.js";
import {
  createPermissionManager,
  createPermissionState,
  PermissionEvent,
} from "../../../packages/ohbaby-agent/src/permission/index.js";
import type { PermissionInfo } from "../../../packages/ohbaby-agent/src/permission/index.js";
import { createBashTool } from "../../../packages/ohbaby-agent/src/tools/bash.js";
import type { SpawnCommand } from "../../../packages/ohbaby-agent/src/tools/bash.js";
import { installSystemProxy } from "../../../packages/ohbaby-agent/src/utils/network-proxy/index.js";

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
  const permissionState = createPermissionState({ bus });
  const permission = createPermissionManager({ bus, state: permissionState });
  const scheduler = createToolScheduler({
    bus,
    permissionState,
    permission: {
      ask: (input) =>
        permission.ask({
          ...input,
          source: { rootSessionId: input.sessionId, ancestorSessionIds: [] },
        }),
    },
  });
  const permissionUpdates: string[] = [];
  const permissionTypes: string[] = [];

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
    permissionTypes.push(event.info.type);
    permission.respond(event.info.sessionId, event.info.id, { type: "once" });
  });

  return { permissionState, permissionUpdates, permissionTypes, scheduler };
}

function request(
  callId: string,
  command: string,
): Parameters<ReturnType<typeof createToolScheduler>["execute"]>[0] {
  return {
    callId,
    runId: "bash_test_run",
    environment: createHostLocalEnvironment(workspace),
    messageId: "message_1",
    params: { command },
    sessionId: "session_1",
    toolName: "bash",
  };
}

describe("bash tool scheduler integration", () => {
  it.skipIf(process.platform === "win32")(
    "executes real commands after approval with macOS wildcard and local proxy bypass rules",
    async () => {
      const installation = await installSystemProxy({
        env: {},
        readSystem: async () => ({
          source: "system",
          httpProxy: "http://127.0.0.1:1",
          httpsProxy: "http://127.0.0.1:1",
          bypass: [
            "127.0.0.1",
            "192.168.0.0/16",
            "10.0.0.0/8",
            "172.16.0.0/12",
            "localhost",
            "*.local",
            "*.crashlytics.com",
            "<local>",
          ],
        }),
      });
      try {
        const { permissionUpdates, scheduler } = createHarness(
          (file, args, options) => nodeSpawn(file, [...args], options),
        );
        const result = await scheduler.execute(
          request(
            "bash_system_proxy",
            "echo ok && true && printf approved > approved.txt",
          ),
        );
        expect(permissionUpdates).toEqual(["bash_system_proxy"]);
        expect(result).toMatchObject({
          status: "success",
          metadata: { exitCode: 0 },
        });
        expect(result.output).toContain("ok");
        expect(
          await fs.readFile(path.join(workspace, "approved.txt"), "utf8"),
        ).toBe("approved");
      } finally {
        await installation.dispose();
      }
    },
  );

  it("runs approved bash commands through permission", async () => {
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
          child.emit("close", 0, null);
        });
        return child as unknown as ChildProcess;
      },
    );
    const { permissionUpdates, scheduler } = createHarness(spawn);

    await expect(
      scheduler.execute(request("bash_ok", "touch scheduler-ok")),
    ).resolves.toMatchObject({
      metadata: {
        cwd: workspace,
        exitCode: 0,
        shellKind: "bash",
        truncated: false,
      },
      status: "success",
    });
    expect(permissionUpdates).toEqual(["bash_ok"]);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("uses default permission approval for mutating bash in plan mode", async () => {
    const child = new FakeChildProcess();
    const spawn = vi.fn<SpawnCommand>(
      (
        _file: string,
        _args: readonly string[],
        _options: SpawnOptionsWithoutStdio,
      ) => {
        queueMicrotask(() => {
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
        });
        return child as unknown as ChildProcess;
      },
    );
    const { permissionState, permissionUpdates, scheduler } =
      createHarness(spawn);
    permissionState.setMode("plan");

    await expect(
      scheduler.execute(request("bash_plan", "touch approved")),
    ).resolves.toMatchObject({
      status: "success",
    });
    expect(permissionUpdates).toEqual(["bash_plan"]);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("allows cd escapes after scheduler approval", async () => {
    const child = new FakeChildProcess();
    const spawn = vi.fn<SpawnCommand>(
      (
        _file: string,
        _args: readonly string[],
        _options: SpawnOptionsWithoutStdio,
      ) => {
        queueMicrotask(() => {
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
        });
        return child as unknown as ChildProcess;
      },
    );
    const { permissionUpdates, permissionTypes, scheduler } =
      createHarness(spawn);

    await expect(
      scheduler.execute(request("bash_escape", "cd .. && pwd")),
    ).resolves.toMatchObject({
      metadata: {
        cdTargets: [await fs.realpath(tempRoot)],
        shellKind: "bash",
      },
      status: "success",
    });
    expect(permissionUpdates).toEqual(["bash_escape", "bash_escape"]);
    expect(permissionTypes).toEqual(["external_directory", "bash"]);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("asks external_directory before bash and then executes with a rich sandbox lease", async () => {
    const externalFile = path.join(tempRoot, "outside.txt");
    await fs.writeFile(externalFile, "outside\n", "utf8");
    const child = new FakeChildProcess();
    const spawn = vi.fn<SpawnCommand>(
      (
        _file: string,
        _args: readonly string[],
        _options: SpawnOptionsWithoutStdio,
      ) => {
        queueMicrotask(() => {
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
        });
        return child as unknown as ChildProcess;
      },
    );
    const bus = createBus();
    const permissionState = createPermissionState({ bus });
    const permission = createPermissionManager({ bus, state: permissionState });
    const scheduler = createToolScheduler({
      bus,
      permissionState,
      permission: {
        ask: (input) =>
          permission.ask({
            ...input,
            source: { rootSessionId: input.sessionId, ancestorSessionIds: [] },
          }),
      },
    });
    const permissionUpdates: PermissionInfo[] = [];
    const sandboxManager = createHostLocalSandboxManager(workspace);
    const lease = await sandboxManager.acquire("session_1");

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
      permissionUpdates.push(event.info);
      permission.respond(event.info.sessionId, event.info.id, { type: "once" });
    });

    try {
      await expect(
        scheduler.execute({
          runId: "bash_test_run",
          callId: "bash_external",
          environment: lease,
          messageId: "message_1",
          params: { command: "chmod 600 ../outside.txt" },
          sessionId: "session_1",
          toolName: "bash",
        }),
      ).resolves.toMatchObject({
        metadata: {
          cwd: workspace,
          shellKind: "bash",
        },
        status: "success",
      });
      expect(permissionUpdates.map((info) => info.type)).toEqual([
        "external_directory",
        "bash",
      ]);
      expect(permissionUpdates[0]?.pattern).toContain("external_directory(");
      const preflight = permissionUpdates[0]?.metadata.preflight as
        | {
            readonly externalPaths?: readonly {
              readonly absolutePath: string;
            }[];
          }
        | undefined;
      expect(preflight?.externalPaths?.[0]?.absolutePath).toBe(
        await fs.realpath(externalFile),
      );
      expect(spawn).toHaveBeenCalledOnce();
    } finally {
      await sandboxManager.release(lease);
    }
  });
});
