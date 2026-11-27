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

function successfulSpawn(): SpawnCommand {
  return () => {
    const child = new FakeChildProcess();
    queueMicrotask(() => {
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    });
    return child as unknown as ChildProcess;
  };
}

function createHarness(
  spawn: SpawnCommand = successfulSpawn(),
  externalChoice: "once" | "always" = "once",
) {
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
  const prompts: PermissionInfo[] = [];

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
    prompts.push(event.info);
    permissionUpdates.push(event.info.callId);
    permissionTypes.push(event.info.type);
    permission.respond(event.info.sessionId, event.info.id, {
      type: event.info.type === "external_directory" ? externalChoice : "once",
    });
  });

  return {
    permissionState,
    permissionUpdates,
    permissionTypes,
    prompts,
    scheduler,
  };
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
    const spawn = vi.fn(successfulSpawn());
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

  it("asks only for the external directory when changing to it and running pwd", async () => {
    const spawn = vi.fn(successfulSpawn());
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
    expect(permissionUpdates).toEqual(["bash_escape"]);
    expect(permissionTypes).toEqual(["external_directory"]);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("passes workspace reads through the main and explore schedulers without an approval", async () => {
    const spawn = vi.fn(successfulSpawn());
    const { permissionTypes, scheduler } = createHarness(spawn);
    await fs.mkdir(path.join(workspace, "src"));
    await fs.writeFile(path.join(workspace, "src", "note.txt"), "fixture");
    const commands = [
      "pwd",
      "ls -la src",
      "cat src/note.txt",
      "head -n 10 src/note.txt",
      "tail -n 10 src/note.txt",
      "wc -l src/note.txt",
      "git status",
      `cd "${workspace.split(path.sep).join("/")}" && git status --short --branch`,
      "cd src && cd .. && git status --porcelain",
      "cd src && ls && cat note.txt",
      "ls src 2>/dev/null",
    ];
    for (const [index, command] of commands.entries()) {
      const result = await scheduler.execute(
        request("read-" + String(index), command),
      );
      expect(result.status).toBe("success");
    }
    const child = await scheduler.execute({
      ...request("explore-read", "cat src/note.txt"),
      sessionId: "child",
      isSubagent: true,
      agentName: "explore",
    });
    expect(child.status).toBe("success");
    expect(permissionTypes).toEqual([]);
    expect(spawn).toHaveBeenCalledTimes(commands.length + 1);
  });

  it.each(["git log", "grep foo a.txt", "ls -R", "cd sub && git status"])(
    "keeps the ordinary shell prompt for %s",
    async (command) => {
      await fs.mkdir(path.join(workspace, "sub"));
      const { prompts, scheduler } = createHarness();
      expect((await scheduler.execute(request("ask", command))).status).toBe(
        "success",
      );
      expect(prompts).toMatchObject([
        { type: "bash", title: "This command needs your approval." },
      ]);
    },
  );

  it("asks for an external readonly home directory once and retains its Always grant", async () => {
    const home = await fs.realpath(tempRoot);
    const directory = path.join(home, ".ohbaby");
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "note.txt"), "fixture");
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    const sandbox = createHostLocalSandboxManager(workspace);
    const lease = await sandbox.acquire("session_1");
    try {
      const spawn = vi.fn(successfulSpawn());
      const { permissionTypes, scheduler } = createHarness(spawn, "always");
      const read = (id: string, command: string) =>
        scheduler.execute({ ...request(id, command), environment: lease });
      expect((await read("first", "ls ~/.ohbaby")).status).toBe("success");
      expect(permissionTypes).toEqual(["external_directory"]);
      expect(lease.trustedRoots()).toContainEqual(
        expect.objectContaining({ path: directory, kind: "external-approved" }),
      );
      expect((await read("second", "cat ~/.ohbaby/note.txt")).status).toBe(
        "success",
      );
      expect(permissionTypes).toEqual(["external_directory"]);
      expect((await read("from-cd", "cd ../.ohbaby && ls")).status).toBe(
        "success",
      );
      expect((await read("wc", "wc -l ../.ohbaby/note.txt")).status).toBe(
        "success",
      );
      expect(permissionTypes).toEqual(["external_directory"]);
      expect(spawn).toHaveBeenCalledTimes(4);
    } finally {
      vi.unstubAllEnvs();
      await sandbox.release(lease);
    }
  });

  it.each(["cat .env", "wc -l .env", "cd sub && cat .env"])(
    "retains the sensitive path prompt for %s",
    async (command) => {
      await fs.writeFile(path.join(workspace, ".env"), "fixture");
      await fs.mkdir(path.join(workspace, "sub"));
      await fs.writeFile(path.join(workspace, "sub", ".env"), "sub fixture");
      const { scheduler, prompts } = createHarness();
      const result = await scheduler.execute({
        ...request("sensitive-path", command),
        isSubagent: true,
        agentName: "explore",
      });
      expect(result.status).toBe("success");
      expect(prompts).toMatchObject([
        { type: "sensitive_path", metadata: { rememberable: false } },
      ]);
    },
  );

  it.each(["cat ~/.ssh/id_rsa", "wc -l ~/.ssh/id_rsa", "cd ~/.ssh && ls"])(
    "denies %s before approval or spawn",
    async (command) => {
      const spawn = vi.fn(successfulSpawn());
      const { scheduler, permissionTypes } = createHarness(spawn);
      const result = await scheduler.execute(request("deny-home", command));
      expect(result).toMatchObject({
        status: "rejected",
        error: { type: "PermissionDeniedError" },
      });
      expect(permissionTypes).toEqual([]);
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it("asks external_directory_shell before bash and then executes with a rich sandbox lease", async () => {
    const externalFile = path.join(tempRoot, "outside.txt");
    await fs.writeFile(externalFile, "outside\n", "utf8");
    const spawn = vi.fn(successfulSpawn());
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
      expect(permissionUpdates[0]?.pattern).toContain(
        "external_directory_shell(",
      );
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
