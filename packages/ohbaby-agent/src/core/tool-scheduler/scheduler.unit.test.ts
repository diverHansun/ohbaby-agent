import type {
  ChildProcess,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createHostLocalEnvironment } from "../../adapters/ui-runtime/host-local-environment.js";
import { createBus, type BusInstance } from "../../bus/index.js";
import type { SpawnCommand } from "../../tools/bash.js";
import { createBuiltinTools } from "../../tools/index.js";
import type { PreflightResult } from "../../sandbox/index.js";
import {
  createPermissionState,
  type PermissionStateStore,
} from "../../permission/index.js";
import {
  createToolScheduler,
  timeoutForTool,
  ToolSchedulerEvent,
} from "./index.js";
import type {
  PermissionPort,
  Tool,
  ToolCallStatus,
  ToolExecutionContext,
  ToolExecutionEnvironment,
  ToolExecutionResult,
  ToolScheduler,
  ToolSchedulerOptions,
} from "./types.js";

class FakeChildProcess extends EventEmitter {
  readonly pid = 123;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

function assertInside(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${candidate}`);
  }
}

function createFakeEnvironment(root: string): ToolExecutionEnvironment {
  return {
    workdir: root,
    resolvePath(inputPath: string): string {
      const resolved = path.resolve(root, inputPath);
      assertInside(root, resolved);
      return resolved;
    },
    async resolvePathForExisting(inputPath: string): Promise<string> {
      const resolved = await fs.realpath(path.resolve(root, inputPath));
      assertInside(root, resolved);
      return resolved;
    },
    async resolvePathForWrite(inputPath: string): Promise<string> {
      const target = path.resolve(root, inputPath);
      const realParent = await fs.realpath(path.dirname(target));
      const resolved = path.join(realParent, path.basename(target));
      assertInside(root, resolved);
      return resolved;
    },
    resolveCommandContext(): {
      readonly cwd: string;
      readonly env: Record<string, string>;
      readonly kind: string;
    } {
      return {
        cwd: root,
        env: { OHBABY_ENV_BRIDGE: "present" },
        kind: "host-local",
      };
    },
  };
}

function createFakeEnvironmentWithPreflight(
  root: string,
  preflight: PreflightResult,
): ToolExecutionEnvironment {
  return {
    ...createFakeEnvironment(root),
    preflight: () => Promise.resolve(preflight),
  };
}

function createPreflight(
  input: Partial<PreflightResult> = {},
): PreflightResult {
  return {
    commands: [],
    denylistHits: [],
    externalPaths: [],
    internalPaths: [],
    overallDanger: "readonly",
    sensitivePaths: [],
    shellKind: "bash",
    ...input,
  };
}

interface SchedulerFixture {
  readonly bus: BusInstance;
  readonly completed: string[];
  readonly scheduler: ToolScheduler;
  readonly started: string[];
  readonly statuses: ToolCallStatus[];
}

function createTool(input: {
  readonly name: string;
  readonly category?: Tool["category"];
  readonly execute?: Tool["execute"];
  readonly isTrusted?: Tool["isTrusted"];
  readonly parametersJsonSchema?: Tool["parametersJsonSchema"];
  readonly requireExplicitApproval?: Tool["requireExplicitApproval"];
  readonly source?: Tool["source"];
}): Tool {
  return {
    category: input.category,
    description: `${input.name} description`,
    execute:
      input.execute ??
      ((): Promise<ToolExecutionResult> =>
        Promise.resolve({ output: `${input.name} output` })),
    isTrusted: input.isTrusted,
    name: input.name,
    parametersJsonSchema: input.parametersJsonSchema ?? {},
    requireExplicitApproval: input.requireExplicitApproval,
    source: input.source ?? "builtin",
  };
}

function createScheduler(
  options: {
    readonly agentTools?: ToolSchedulerOptions["agentTools"];
    readonly permission?: PermissionPort;
    readonly permissionState?: PermissionStateStore;
    readonly config?: ToolSchedulerOptions["config"];
    readonly now?: () => number;
  } = {},
): SchedulerFixture {
  const bus = createBus();
  const statuses: ToolCallStatus[] = [];
  const started: string[] = [];
  const completed: string[] = [];
  const scheduler = createToolScheduler({
    agentTools: options.agentTools,
    bus,
    config: options.config,
    now: options.now ?? Date.now,
    permission:
      options.permission ??
      ({
        ask: (): Promise<"once"> => Promise.resolve("once"),
      } satisfies PermissionPort),
    permissionState:
      options.permissionState ??
      createPermissionState({ bus, initialLevel: "full-access" }),
  });

  bus.subscribe(ToolSchedulerEvent.StatusChanged, (payload) => {
    statuses.push(payload.currentStatus);
  });
  bus.subscribe(ToolSchedulerEvent.ExecutionStarted, (payload) => {
    started.push(payload.callId);
  });
  bus.subscribe(ToolSchedulerEvent.ExecutionCompleted, (payload) => {
    completed.push(payload.callId);
  });

  return { bus, completed, scheduler, started, statuses };
}

describe("ToolScheduler", () => {
  it("uses a longer guard timeout for subagent_run without extending other subagent tools", () => {
    expect(
      timeoutForTool(
        {
          byTool: { subagent_run: 310_000 },
          defaultTimeout: 120_000,
        },
        "subagent_run",
      ),
    ).toBe(310_000);
    expect(
      timeoutForTool(
        {
          byTool: { subagent_run: 310_000 },
          defaultTimeout: 120_000,
        },
        "subagent_status",
      ),
    ).toBe(120_000);
  });

  it("applies the subagent_run guard timeout through the actual execution path", async () => {
    vi.useFakeTimers();
    try {
      const started: string[] = [];
      const { scheduler } = createScheduler();
      scheduler.register(
        createTool({
          category: "subagent",
          execute: (_params, context) => {
            started.push(context.callId);
            return new Promise<ToolExecutionResult>(() => undefined);
          },
          name: "subagent_run",
        }),
      );

      const result = scheduler.execute({
        callId: "subagent_run_1",
        messageId: "message_1",
        params: {},
        sessionId: "session_1",
        toolName: "subagent_run",
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(started).toEqual(["subagent_run_1"]);

      await vi.advanceTimersByTimeAsync(309_999);
      expect(scheduler.getStatus("subagent_run_1")).toBe("executing");

      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toMatchObject({
        error: { type: "TimeoutError" },
        status: "error",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the subagent_run guard when a caller overrides byTool for another tool", async () => {
    vi.useFakeTimers();
    try {
      const { scheduler } = createScheduler({
        config: { timeout: { byTool: { custom_tool: 5_000 } } },
      });
      scheduler.register(
        createTool({
          category: "subagent",
          execute: () => new Promise<ToolExecutionResult>(() => undefined),
          name: "subagent_run",
        }),
      );

      const result = scheduler.execute({
        callId: "subagent_run_merge_1",
        messageId: "message_1",
        params: {},
        sessionId: "session_1",
        toolName: "subagent_run",
      });
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(309_999);
      expect(scheduler.getStatus("subagent_run_merge_1")).toBe("executing");

      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toMatchObject({
        error: { type: "TimeoutError" },
        status: "error",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps subagent_status on the default scheduler timeout during execution", async () => {
    vi.useFakeTimers();
    try {
      const started: string[] = [];
      const { scheduler } = createScheduler();
      scheduler.register(
        createTool({
          category: "subagent",
          execute: (_params, context) => {
            started.push(context.callId);
            return new Promise<ToolExecutionResult>(() => undefined);
          },
          name: "subagent_status",
        }),
      );

      const result = scheduler.execute({
        callId: "subagent_status_1",
        messageId: "message_1",
        params: {},
        sessionId: "session_1",
        toolName: "subagent_status",
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(started).toEqual(["subagent_status_1"]);

      await vi.advanceTimersByTimeAsync(119_999);
      expect(scheduler.getStatus("subagent_status_1")).toBe("executing");

      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toMatchObject({
        error: { type: "TimeoutError" },
        status: "error",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies agent tool config before listing available tools", async () => {
    const { scheduler } = createScheduler({
      agentTools: {
        getAgentConfig: (agentName?: string) => ({
          tools:
            agentName === "explore"
	              ? {
	                  edit: true,
	                  read: true,
	                  subagent_close: true,
	                  subagent_run: true,
	                  subagent_status: true,
	                  todo_read: true,
	                }
              : undefined,
        }),
      },
    });
    for (const tool of [
      { name: "read", category: "readonly" },
      { name: "edit", category: "write" },
      { name: "subagent_run", category: "subagent" },
      { name: "subagent_status", category: "subagent" },
      { name: "subagent_close", category: "subagent" },
      { name: "todo_read", category: "memory" },
    ] as const) {
      scheduler.register(createTool(tool));
    }

    await expect(
      scheduler
        .getAvailableTools({ agentName: "explore", isSubagent: true })
        .then((tools) => tools.map((tool) => tool.name)),
    ).resolves.toEqual(["read", "edit", "todo_read"]);
  });

  it("normalizes agent include and exclude tool config before listing tools", async () => {
    const { scheduler } = createScheduler({
      agentTools: {
        getAgentConfig: () => ({
          tools: {
            exclude: ["edit"],
            include: ["read", "edit", "web_search"],
          },
        }),
      },
    });
    for (const tool of [
      { name: "read", category: "readonly" },
      { name: "edit", category: "write" },
      { name: "web_search", category: "network" },
      { name: "memory_add", category: "memory" },
    ] as const) {
      scheduler.register(createTool(tool));
    }

    await expect(
      scheduler
        .getAvailableTools()
        .then((tools) => tools.map((tool) => tool.name)),
    ).resolves.toEqual(["read", "web_search"]);
  });

  it("executes allowed tools and publishes state events", async () => {
    const { completed, scheduler, started, statuses } = createScheduler();
    scheduler.register(createTool({ name: "read" }));

    await expect(
      scheduler.execute({
        callId: "call_1",
        messageId: "message_1",
        params: { path: "README.md" },
        sessionId: "session_1",
        toolName: "read",
      }),
    ).resolves.toMatchObject({
      callId: "call_1",
      output: "read output",
      status: "success",
    });

    expect(statuses).toEqual([
      "checking_permission",
      "queued",
      "executing",
      "success",
    ]);
    expect(started).toEqual(["call_1"]);
    expect(completed).toEqual(["call_1"]);
    expect(scheduler.getStatus("call_1")).toBe("success");
  });

  it("passes the runtime environment to tool execution", async () => {
    const { scheduler } = createScheduler();
    const environment = {
      workdir: "D:/workspace/session_1",
      resolvePath(inputPath: string): string {
        return `${this.workdir}/${inputPath}`;
      },
      resolvePathForExisting(inputPath: string): Promise<string> {
        return Promise.resolve(`${this.workdir}/${inputPath}`);
      },
      resolvePathForWrite(inputPath: string): Promise<string> {
        return Promise.resolve(`${this.workdir}/${inputPath}`);
      },
      resolveCommandContext(): { readonly cwd: string; readonly kind: string } {
        return { cwd: this.workdir, kind: "host-local" };
      },
    };
    scheduler.register(
      createTool({
        execute: (_params, context) => {
          const runtime = (
            context as {
              readonly environment?: {
                readonly workdir: string;
                resolveCommandContext(): { readonly cwd: string };
              };
            }
          ).environment;

          return {
            output: `${runtime?.workdir ?? "missing"}|${
              runtime?.resolveCommandContext().cwd ?? "missing"
            }`,
          };
        },
        name: "read",
      }),
    );

    await expect(
      scheduler.execute({
        callId: "call_1",
        environment,
        messageId: "message_1",
        params: {},
        sessionId: "session_1",
        toolName: "read",
      }),
    ).resolves.toMatchObject({
      output: "D:/workspace/session_1|D:/workspace/session_1",
      status: "success",
    });
  });

  it("handles tool-not-found, permission deny, and permission rejection without executing", async () => {
    const denyBus = createBus();
    const denyState = createPermissionState({
      bus: denyBus,
      initialLevel: "full-access",
    });
    denyState.addSessionRule("session_1", {
      decision: "deny",
      reason: "blocked bash",
      scope: "session",
      tool: "bash",
    });
    const askRejectBus = createBus();
    const askRejectState = createPermissionState({ bus: askRejectBus });
    const deny = createScheduler({
      permissionState: denyState,
    });
    const askReject = createScheduler({
      permission: { ask: () => Promise.resolve("reject") },
      permissionState: askRejectState,
    });
    const execute = vi.fn().mockResolvedValue({ output: "nope" });
    deny.scheduler.register(createTool({ execute, name: "bash" }));
    askReject.scheduler.register(createTool({ execute, name: "edit" }));

    await expect(
      deny.scheduler.execute({
        callId: "missing",
        messageId: "message_1",
        params: {},
        sessionId: "session_1",
        toolName: "missing_tool",
      }),
    ).resolves.toMatchObject({
      error: { type: "ToolNotFoundError" },
      status: "error",
    });
    await expect(
      deny.scheduler.execute({
        callId: "denied",
        messageId: "message_1",
        params: {},
        sessionId: "session_1",
        toolName: "bash",
      }),
    ).resolves.toMatchObject({
      error: { type: "PermissionDeniedError" },
      status: "rejected",
    });
    await expect(
      askReject.scheduler.execute({
        callId: "rejected",
        messageId: "message_1",
        params: {},
        sessionId: "session_1",
        toolName: "edit",
      }),
    ).resolves.toMatchObject({
      error: { type: "PermissionRejectedError" },
      status: "rejected",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("uses the permission manager state when no scheduler permissionState is provided", async () => {
    const bus = createBus();
    const permissionState = createPermissionState({
      bus,
      initialLevel: "full-access",
    });
    const permission = {
      ask: vi.fn(() => Promise.resolve("reject" as const)),
      state: permissionState,
    } satisfies PermissionPort;
    const scheduler = createToolScheduler({ bus, permission });
    const execute = vi.fn().mockResolvedValue({ output: "written" });
    scheduler.register(
      createTool({ category: "write", execute, name: "edit" }),
    );

    await expect(
      scheduler.execute({
        callId: "write_full_access",
        messageId: "message_1",
        params: { file_path: "src/file.ts" },
        sessionId: "session_1",
        toolName: "edit",
      }),
    ).resolves.toMatchObject({
      output: "written",
      status: "success",
    });
    expect(permission.ask).not.toHaveBeenCalled();
  });

  it("asks permission for tools that require explicit approval even when evaluator allows the category", async () => {
    const permission = {
      ask: vi.fn(() => Promise.resolve("once" as const)),
    };
    const { scheduler } = createScheduler({ permission });
    const execute = vi.fn(() => ({ output: "remote result" }));
    scheduler.register(
      createTool({
        category: "readonly",
        execute,
        name: "remote_read",
        requireExplicitApproval: true,
      }),
    );

    const result = await scheduler.execute({
      callId: "explicit_approval",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "remote_read",
    });

    expect(result.status).toBe("success");
    expect(permission.ask).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "explicit-approval-required",
        rememberable: false,
        toolName: "remote_read",
      }),
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("maps untrusted MCP tools to explicit approval instead of scheduler MCP-specific trust checks", async () => {
    const permission = {
      ask: vi.fn(() => Promise.resolve("once" as const)),
    };
    const { scheduler } = createScheduler({ permission });
    const execute = vi.fn(() => ({ output: "mcp result" }));
    scheduler.register(
      createTool({
        category: "readonly",
        execute,
        name: "remote_read",
        requireExplicitApproval: true,
        source: "mcp",
      }),
    );

    const result = await scheduler.execute({
      callId: "untrusted_mcp",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "remote_read",
    });

    expect(result.status).toBe("success");
    expect(permission.ask).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "explicit-approval-required",
        rememberable: false,
        toolName: "remote_read",
      }),
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not ask just because a tool source is MCP when explicit approval is absent", async () => {
    const permission = {
      ask: vi.fn(() => Promise.resolve("once" as const)),
    };
    const { scheduler } = createScheduler({ permission });
    const execute = vi.fn(() => ({ output: "trusted mcp result" }));
    scheduler.register(
      createTool({
        category: "readonly",
        execute,
        name: "trusted_remote_read",
        source: "mcp",
      }),
    );

    await expect(
      scheduler.execute({
        callId: "trusted_mcp",
        messageId: "message_1",
        params: {},
        sessionId: "session_1",
        toolName: "trusted_remote_read",
      }),
    ).resolves.toMatchObject({
      output: "trusted mcp result",
      status: "success",
    });
    expect(permission.ask).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("asks external and explicit approval for full-access external writes when the tool requires it", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ohbaby-scheduler-explicit-external-"),
    );
    const workspace = path.join(tempRoot, "workspace");
    const outside = path.join(tempRoot, "outside");
    const externalFile = path.join(outside, "outside.txt");
    await fs.mkdir(workspace);
    await fs.mkdir(outside);
    const permissionRequests: Parameters<PermissionPort["ask"]>[0][] = [];
    const permission = {
      ask: vi.fn((input: Parameters<PermissionPort["ask"]>[0]) => {
        permissionRequests.push(input);
        return Promise.resolve("once" as const);
      }),
    } satisfies PermissionPort;
    const execute = vi.fn(() => ({ output: "external write" }));
    const { scheduler } = createScheduler({ permission });
    scheduler.register(
      createTool({
        category: "write",
        execute,
        name: "remote_write",
        parametersJsonSchema: {
          additionalProperties: false,
          properties: {
            file_path: { type: "string" },
          },
          required: ["file_path"],
          type: "object",
        },
        requireExplicitApproval: true,
      }),
    );

    try {
      await expect(
        scheduler.execute({
          callId: "explicit_external",
          environment: createFakeEnvironment(workspace),
          messageId: "message_1",
          params: { file_path: externalFile },
          sessionId: "session_1",
          toolName: "remote_write",
        }),
      ).resolves.toMatchObject({
        output: "external write",
        status: "success",
      });

      expect(permissionRequests.map((request) => request.reason)).toEqual([
        expect.stringContaining("External write path access"),
        "explicit-approval-required",
      ]);
      expect(permissionRequests.map((request) => request.rememberable)).toEqual(
        [undefined, false],
      );
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("keeps internal write permission params relative", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ohbaby-scheduler-internal-write-"),
    );
    const workspace = path.join(tempRoot, "workspace");
    await fs.mkdir(path.join(workspace, "child-tools"), { recursive: true });
    const realWorkspace = await fs.realpath(workspace);
    const permissionRequests: Parameters<PermissionPort["ask"]>[0][] = [];
    const permission = {
      ask: vi.fn((input: Parameters<PermissionPort["ask"]>[0]) => {
        permissionRequests.push(input);
        return Promise.resolve("once" as const);
      }),
    } satisfies PermissionPort;
    const { scheduler } = createScheduler({
      permission,
      permissionState: createPermissionState({
        bus: createBus(),
        initialLevel: "default",
      }),
    });
    scheduler.register(
      createTool({
        category: "write",
        execute: () => ({ output: "internal write" }),
        name: "write",
        parametersJsonSchema: {
          additionalProperties: false,
          properties: {
            file_path: { type: "string" },
          },
          required: ["file_path"],
          type: "object",
        },
      }),
    );

    try {
      await expect(
        scheduler.execute({
          callId: "internal_write",
          environment: createFakeEnvironment(realWorkspace),
          messageId: "message_1",
          params: { file_path: "child-tools/child-created.txt" },
          sessionId: "session_1",
          toolName: "write",
        }),
      ).resolves.toMatchObject({
        output: "internal write",
        status: "success",
      });

      expect(permissionRequests[0]?.params).toMatchObject({
        file_path: "child-tools/child-created.txt",
      });
    } finally {
      await fs.rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("asks external directory permissions before bash permissions", async () => {
    const permissionOrder: string[] = [];
    const permission = {
      ask: vi.fn((input: Parameters<PermissionPort["ask"]>[0]) => {
        permissionOrder.push(input.toolName);
        return Promise.resolve("once" as const);
      }),
    } satisfies PermissionPort;
    const bus = createBus();
    const execute = vi.fn(() => ({ output: "pushed" }));
    const { scheduler } = createScheduler({
      permission,
      permissionState: createPermissionState({ bus }),
    });
    scheduler.register(createTool({ execute, name: "bash" }));

    await expect(
      scheduler.execute({
        callId: "external_then_bash",
        environment: createFakeEnvironmentWithPreflight(
          "D:/workspace",
          createPreflight({
            externalPaths: [
              {
                absolutePath: "D:/outside/repo",
                askPattern: "D:/outside/**",
                original: "D:/outside/repo",
              },
            ],
            overallDanger: "mutating",
          }),
        ),
        messageId: "message_1",
        params: { command: "git push D:/outside/repo main" },
        sessionId: "session_1",
        toolName: "bash",
      }),
    ).resolves.toMatchObject({
      output: "pushed",
      status: "success",
    });

    expect(permissionOrder).toEqual(["external_directory", "bash"]);
    const firstAsk = permission.ask.mock.calls[0][0];
    const preflight = firstAsk.metadata?.preflight;
    const externalPaths = (preflight as { externalPaths?: unknown })
      .externalPaths;
    expect(firstAsk.toolName).toBe("external_directory");
    expect(firstAsk.params).toMatchObject({ path: "D:/outside/repo" });
    expect(Array.isArray(externalPaths)).toBe(true);
    expect(externalPaths).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("promotes external directory always approvals into trusted read roots", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ohbaby-scheduler-trust-"),
    );
    const workspace = path.join(tempRoot, "workspace");
    const outside = path.join(tempRoot, "outside");
    await fs.mkdir(workspace);
    await fs.mkdir(outside);
    const trustPath = vi.fn();
    const permission = {
      ask: vi.fn(() => Promise.resolve("always" as const)),
    } satisfies PermissionPort;
    const execute = vi.fn(() => ({ output: "trusted" }));
    const { scheduler } = createScheduler({
      permission,
      permissionState: createPermissionState({ bus: createBus() }),
    });
    scheduler.register(createTool({ execute, name: "bash" }));

    try {
      await expect(
        scheduler.execute({
          callId: "external_always",
          environment: {
            ...createFakeEnvironmentWithPreflight(
              workspace,
              createPreflight({
                externalPaths: [
                  {
                    absolutePath: outside,
                    askPattern: path.join(outside, "**"),
                    original: outside,
                  },
                ],
                overallDanger: "mutating",
              }),
            ),
            trustPath,
          },
          messageId: "message_1",
          params: { command: `cd ${outside}` },
          sessionId: "session_1",
          toolName: "bash",
        }),
      ).resolves.toMatchObject({
        output: "trusted",
        status: "success",
      });

      expect(trustPath).toHaveBeenCalledWith({
        kind: "external-approved",
        path: path.resolve(outside),
        source: "external_directory",
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not promote external directory once approvals into trusted roots", async () => {
    const trustPath = vi.fn();
    const permission = {
      ask: vi.fn(() => Promise.resolve("once" as const)),
    } satisfies PermissionPort;
    const execute = vi.fn(() => ({ output: "once" }));
    const { scheduler } = createScheduler({
      permission,
      permissionState: createPermissionState({ bus: createBus() }),
    });
    scheduler.register(createTool({ execute, name: "bash" }));

    await scheduler.execute({
      callId: "external_once",
      environment: {
        ...createFakeEnvironmentWithPreflight(
          "D:/workspace",
          createPreflight({
            externalPaths: [
              {
                absolutePath: "D:/outside/repo",
                askPattern: "D:/outside/**",
                original: "D:/outside/repo",
              },
            ],
          }),
        ),
        trustPath,
      },
      messageId: "message_1",
      params: { command: "git push D:/outside/repo main" },
      sessionId: "session_1",
      toolName: "bash",
    });

    expect(trustPath).not.toHaveBeenCalled();
  });

  it("records auto-approved external directories as trusted read roots", async () => {
    const trustPath = vi.fn();
    const permission = {
      ask: vi.fn(() => Promise.resolve("once" as const)),
    } satisfies PermissionPort;
    const execute = vi.fn(() => ({ output: "auto" }));
    const { scheduler } = createScheduler({
      permission,
      permissionState: createPermissionState({
        bus: createBus(),
        initialLevel: "full-access",
      }),
    });
    scheduler.register(createTool({ execute, name: "bash" }));

    await expect(
      scheduler.execute({
        callId: "external_auto",
        environment: {
          ...createFakeEnvironmentWithPreflight(
            "D:/workspace",
            createPreflight({
              externalPaths: [
                {
                  absolutePath: "D:/outside/repo",
                  askPattern: "D:/outside/**",
                  original: "D:/outside/repo",
                },
              ],
            }),
          ),
          trustPath,
        },
        messageId: "message_1",
        params: { command: "cat D:/outside/repo" },
        sessionId: "session_1",
        toolName: "bash",
      }),
    ).resolves.toMatchObject({
      output: "auto",
      status: "success",
    });

    expect(permission.ask).not.toHaveBeenCalled();
    expect(trustPath).toHaveBeenCalledWith({
      kind: "external-approved",
      path: path.resolve("D:/outside"),
      source: "external_directory",
    });
  });

  it("does not treat read-approved external roots as write approval", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ohbaby-scheduler-read-trust-write-"),
    );
    const workspace = path.join(tempRoot, "workspace");
    const outside = path.join(tempRoot, "outside");
    const externalFile = path.join(outside, "out.txt");
    await fs.mkdir(workspace);
    await fs.mkdir(outside);
    const trustedRoots: Awaited<
      ReturnType<NonNullable<ToolExecutionEnvironment["trustPath"]>>
    >[] = [];
    const permissionRequests: Parameters<PermissionPort["ask"]>[0][] = [];
    const permission = {
      ask: vi.fn((input: Parameters<PermissionPort["ask"]>[0]) => {
        permissionRequests.push(input);
        return Promise.resolve("once" as const);
      }),
    } satisfies PermissionPort;
    const environment: ToolExecutionEnvironment = {
      ...createFakeEnvironmentWithPreflight(
        workspace,
        createPreflight({
          externalPaths: [
            {
              absolutePath: outside,
              askPattern: path.join(outside, "**"),
              original: outside,
            },
          ],
        }),
      ),
      containsTrustedPath: (candidate) =>
        trustedRoots.some((root) => candidate.startsWith(root.path)),
      trustedRoots: () => trustedRoots,
      trustPath: (input) => {
        const root = { ...input, path: path.resolve(input.path) };
        trustedRoots.push(root);
        return Promise.resolve(root);
      },
    };
    const { scheduler } = createScheduler({
      permission,
      permissionState: createPermissionState({
        bus: createBus(),
        initialLevel: "full-access",
      }),
    });
    scheduler.register(createTool({ name: "bash" }));
    for (const tool of createBuiltinTools()) {
      if (tool.name === "write") {
        scheduler.register(tool);
      }
    }

    try {
      await expect(
        scheduler.execute({
          callId: "read_external_auto",
          environment,
          messageId: "message_1",
          params: { command: `cat ${outside}` },
          sessionId: "session_1",
          toolName: "bash",
        }),
      ).resolves.toMatchObject({ status: "success" });
      expect(trustedRoots).toEqual([
        {
          kind: "external-approved",
          path: path.resolve(outside),
          source: "external_directory",
        },
      ]);

      await expect(
        scheduler.execute({
          callId: "write_after_read_trust",
          environment,
          messageId: "message_2",
          params: { content: "external", file_path: externalFile },
          sessionId: "session_1",
          toolName: "write",
        }),
      ).resolves.toMatchObject({ status: "success" });

      expect(permissionRequests).toHaveLength(1);
      expect(permissionRequests[0]).toMatchObject({
        toolName: "external_directory",
      });
      expect(permissionRequests[0]?.reason).toContain("External write path");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not force external write confirmation inside write-approved trusted roots", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ohbaby-scheduler-write-"),
    );
    const workspace = path.join(tempRoot, "workspace");
    const trustedRoot = path.join(tempRoot, "trusted-output");
    const trustedFile = path.join(trustedRoot, "out.txt");
    await fs.mkdir(workspace);
    await fs.mkdir(trustedRoot);
    const realTrustedRoot = await fs.realpath(trustedRoot);
    const permission = {
      ask: vi.fn(() => Promise.resolve("once" as const)),
    } satisfies PermissionPort;
    const { scheduler } = createScheduler({
      permission,
      permissionState: createPermissionState({
        bus: createBus(),
        initialLevel: "full-access",
      }),
    });
    scheduler.register(
      createTool({
        category: "write",
        execute: async (_params, context) => ({
          metadata: {
            resolved:
              await context.environment?.resolvePathForWrite(trustedFile),
          },
          output: "wrote",
        }),
        name: "write_file",
        parametersJsonSchema: {
          additionalProperties: false,
          properties: { file_path: { type: "string" } },
          required: ["file_path"],
          type: "object",
        },
      }),
    );

    try {
      await expect(
        scheduler.execute({
          callId: "trusted_write",
          environment: {
            ...createFakeEnvironment(workspace),
            containsTrustedPath: (candidate) =>
              candidate.startsWith(realTrustedRoot),
            trustedRoots: () => [
              {
                kind: "external-write-approved",
                path: realTrustedRoot,
                source: "external_directory",
              },
            ],
            resolvePathForWrite: (inputPath) =>
              Promise.resolve(path.resolve(inputPath)),
          },
          messageId: "message_1",
          params: { file_path: trustedFile },
          sessionId: "session_1",
          toolName: "write_file",
        }),
      ).resolves.toMatchObject({
        metadata: { resolved: path.resolve(trustedFile) },
        status: "success",
      });
      expect(permission.ask).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("executes bash after external directory and bash permissions are approved", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ohbaby-scheduler-bash-"),
    );
    const workspace = path.join(tempRoot, "workspace");
    const externalFile = path.join(tempRoot, "outside.txt");
    await fs.mkdir(workspace);
    await fs.writeFile(externalFile, "outside\n", "utf8");
    const permissionOrder: string[] = [];
    const permission = {
      ask: vi.fn((input: Parameters<PermissionPort["ask"]>[0]) => {
        permissionOrder.push(input.toolName);
        return Promise.resolve("once" as const);
      }),
    } satisfies PermissionPort;
    const child = new FakeChildProcess();
    const spawn = vi.fn<SpawnCommand>(
      (
        _file: string,
        _args: readonly string[],
        _options: SpawnOptionsWithoutStdio,
      ) => child as unknown as ChildProcess,
    );
    const { scheduler } = createScheduler({
      permission,
      permissionState: createPermissionState({ bus: createBus() }),
    });
    for (const tool of createBuiltinTools({
      shell: {
        acceptable: () => "/bin/bash",
        killTree: vi.fn(),
      },
      spawn,
    })) {
      if (tool.name === "bash") {
        scheduler.register(tool);
      }
    }

    try {
      const resultPromise = scheduler.execute({
        callId: "external_bash_real",
        environment: createFakeEnvironmentWithPreflight(
          workspace,
          createPreflight({
            commands: [
              {
                arityKey: "chmod *",
                danger: "mutating",
                hasDynamic: false,
                pathArgs: ["../outside.txt"],
                root: "chmod",
                source: "chmod 600 ../outside.txt",
                tokens: ["chmod", "600", "../outside.txt"],
              },
            ],
            externalPaths: [
              {
                absolutePath: externalFile,
                askPattern: path.join(tempRoot, "**"),
                original: "../outside.txt",
              },
            ],
          }),
        ),
        messageId: "message_1",
        params: { command: "chmod 600 ../outside.txt" },
        sessionId: "session_1",
        toolName: "bash",
      });
      await vi.waitFor(() => {
        expect(spawn).toHaveBeenCalledTimes(1);
      });
      child.emit("exit", 0, null);

      await expect(resultPromise).resolves.toMatchObject({
        status: "success",
      });
      expect(permissionOrder).toEqual(["external_directory", "bash"]);
      expect(spawn.mock.calls[0]?.[1]).toEqual([
        "-lc",
        "chmod 600 ../outside.txt",
      ]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects denylist hits before permission asks even in full access", async () => {
    const permission = {
      ask: vi.fn(() => Promise.resolve("once" as const)),
    } satisfies PermissionPort;
    const execute = vi.fn(() => ({ output: "nope" }));
    const { scheduler } = createScheduler({ permission });
    scheduler.register(createTool({ execute, name: "bash" }));

    await expect(
      scheduler.execute({
        callId: "denylisted",
        environment: createFakeEnvironmentWithPreflight(
          "D:/workspace",
          createPreflight({
            denylistHits: [
              {
                absolutePath: "C:/Users/test/.ssh/id_rsa",
                original: "~/.ssh/id_rsa",
                reason: "ssh-key-dir",
              },
            ],
          }),
        ),
        messageId: "message_1",
        params: { command: "cat ~/.ssh/id_rsa" },
        sessionId: "session_1",
        toolName: "bash",
      }),
    ).resolves.toMatchObject({
      error: { type: "PermissionDeniedError" },
      status: "rejected",
    });

    expect(permission.ask).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("asks sensitive path permissions after external directories and before bash", async () => {
    const permissionOrder: string[] = [];
    const permission = {
      ask: vi.fn((input: Parameters<PermissionPort["ask"]>[0]) => {
        permissionOrder.push(input.toolName);
        return Promise.resolve("once" as const);
      }),
    } satisfies PermissionPort;
    const execute = vi.fn(() => ({ output: "read sensitive external" }));
    const { scheduler } = createScheduler({
      permission,
      permissionState: createPermissionState({ bus: createBus() }),
    });
    scheduler.register(createTool({ execute, name: "bash" }));

    await expect(
      scheduler.execute({
        callId: "sensitive_external",
        environment: createFakeEnvironmentWithPreflight(
          "D:/workspace",
          createPreflight({
            externalPaths: [
              {
                absolutePath: "D:/outside/.env",
                askPattern: "D:/outside/**",
                original: "D:/outside/.env",
              },
            ],
            overallDanger: "mutating",
            sensitivePaths: [
              {
                absolutePath: "D:/outside/.env",
                askPattern: "D:/outside/.env",
                original: "D:/outside/.env",
                reason: "env-file",
              },
            ],
          }),
        ),
        messageId: "message_1",
        params: { command: "cat D:/outside/.env && git push" },
        sessionId: "session_1",
        toolName: "bash",
      }),
    ).resolves.toMatchObject({
      output: "read sensitive external",
      status: "success",
    });

    expect(permissionOrder).toEqual([
      "external_directory",
      "sensitive_path",
      "bash",
    ]);
    const sensitiveAsk = permission.ask.mock.calls[1][0];
    expect(sensitiveAsk.toolName).toBe("sensitive_path");
    expect(sensitiveAsk.params).toMatchObject({
      path: "D:/outside/.env",
      reason: "env-file",
    });
    expect(sensitiveAsk.params.pattern).toBe("D:/outside/.env");
    expect(sensitiveAsk.reason).toContain("Sensitive path access");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("asks sensitive path permissions even in full access", async () => {
    const permissionRequests: Parameters<PermissionPort["ask"]>[0][] = [];
    const permission = {
      ask: vi.fn((input: Parameters<PermissionPort["ask"]>[0]) => {
        permissionRequests.push(input);
        return Promise.resolve("once" as const);
      }),
    } satisfies PermissionPort;
    const execute = vi.fn(() => ({ output: "read sensitive" }));
    const { scheduler } = createScheduler({
      permission,
      permissionState: createPermissionState({
        bus: createBus(),
        initialLevel: "full-access",
      }),
    });
    scheduler.register(createTool({ execute, name: "bash" }));

    await expect(
      scheduler.execute({
        callId: "sensitive_full_access",
        environment: createFakeEnvironmentWithPreflight(
          "D:/workspace",
          createPreflight({
            sensitivePaths: [
              {
                absolutePath: "D:/outside/.env",
                askPattern: "D:/outside/.env",
                original: "D:/outside/.env",
                reason: "env-file",
              },
            ],
          }),
        ),
        messageId: "message_1",
        params: { command: "cat D:/outside/.env" },
        sessionId: "session_1",
        toolName: "bash",
      }),
    ).resolves.toMatchObject({
      output: "read sensitive",
      status: "success",
    });

    expect(permissionRequests.map((request) => request.toolName)).toEqual([
      "sensitive_path",
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("fails closed when bash preflight cannot be computed", async () => {
    const permission = {
      ask: vi.fn(() => Promise.resolve("once" as const)),
    } satisfies PermissionPort;
    const execute = vi.fn(() => ({ output: "nope" }));
    const { scheduler } = createScheduler({ permission });
    scheduler.register(createTool({ execute, name: "bash" }));

    const result = await scheduler.execute({
      callId: "preflight_failure",
      environment: {
        ...createFakeEnvironment("D:/workspace"),
        preflight: () => Promise.reject(new Error("preflight exploded")),
      },
      messageId: "message_1",
      params: { command: "cat src/app.ts" },
      sessionId: "session_1",
      toolName: "bash",
    });

    expect(result).toMatchObject({
      error: {
        type: "ExecutionError",
      },
      status: "error",
    });
    expect(result.error?.message).toContain("preflight exploded");

    expect(permission.ask).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("validates request identity and tool parameters before execution", async () => {
    const execute = vi.fn().mockResolvedValue({ output: "validated" });
    const { scheduler } = createScheduler();
    scheduler.register(
      createTool({
        execute,
        name: "needs_path",
        parametersJsonSchema: {
          properties: { path: { type: "string" } },
          required: ["path"],
          type: "object",
        },
      }),
    );

    await expect(
      scheduler.execute({
        callId: "",
        messageId: "message_1",
        params: { path: "README.md" },
        sessionId: "session_1",
        toolName: "needs_path",
      }),
    ).resolves.toMatchObject({
      error: { type: "ValidationError" },
      status: "error",
    });
    await expect(
      scheduler.execute({
        callId: "invalid_params",
        messageId: "message_1",
        params: {},
        sessionId: "session_1",
        toolName: "needs_path",
      }),
    ).resolves.toMatchObject({
      error: { type: "ValidationError" },
      status: "error",
    });
    await expect(
      scheduler.execute({
        callId: "valid_params",
        messageId: "message_1",
        params: { path: "README.md" },
        sessionId: "session_1",
        toolName: "needs_path",
      }),
    ).resolves.toMatchObject({
      output: "validated",
      status: "success",
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("maps thrown permission rejections into rejected results", async () => {
    class RejectedError extends Error {}

    const execute = vi.fn().mockResolvedValue({ output: "nope" });
    const bus = createBus();
    const { scheduler } = createScheduler({
      permissionState: createPermissionState({ bus }),
      permission: {
        ask: () => {
          throw new RejectedError("rejected");
        },
      },
    });
    scheduler.register(createTool({ execute, name: "edit" }));

    await expect(
      scheduler.execute({
        callId: "permission_error",
        messageId: "message_1",
        params: {},
        sessionId: "session_1",
        toolName: "edit",
      }),
    ).resolves.toMatchObject({
      error: { type: "PermissionRejectedError" },
      status: "rejected",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("queues write calls behind read calls and releases them afterward", async () => {
    const readBlocker = deferred<{ readonly output: string }>();
    const started: string[] = [];
    const { scheduler } = createScheduler();
    scheduler.register(
      createTool({
        execute: (_params, context) => {
          started.push(context.callId);
          return readBlocker.promise;
        },
        name: "read",
      }),
    );
    scheduler.register(
      createTool({
        execute: (_params, context) => {
          started.push(context.callId);
          return Promise.resolve({ output: "written" });
        },
        name: "edit",
      }),
    );

    const readPromise = scheduler.execute({
      callId: "read_1",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "read",
    });
    const writePromise = scheduler.execute({
      callId: "write_1",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "edit",
    });

    await vi.waitFor(() => {
      expect(started).toEqual(["read_1"]);
      expect(scheduler.getStatus("write_1")).toBe("queued");
    });
    readBlocker.resolve({ output: "read done" });

    await expect(readPromise).resolves.toMatchObject({ status: "success" });
    await expect(writePromise).resolves.toMatchObject({ status: "success" });
    expect(started).toEqual(["read_1", "write_1"]);
  });

  it("lets memory tools bypass read/write locks and limits subagent concurrency", async () => {
    const blockers = [
      deferred<{ readonly output: string }>(),
      deferred<{ readonly output: string }>(),
    ];
    const started: string[] = [];
    const { scheduler } = createScheduler({
      config: { concurrency: { maxSubagentConcurrency: 1 } },
    });
    scheduler.register(
      createTool({
        execute: (_params, context) => {
          started.push(context.callId);
          return blockers[0].promise;
        },
        name: "edit",
      }),
    );
    scheduler.register(
      createTool({
        category: "memory",
        execute: (_params, context) => {
          started.push(context.callId);
          return Promise.resolve({ output: "remembered" });
        },
        name: "memory_add",
      }),
    );
    scheduler.register(
      createTool({
        category: "subagent",
        execute: (_params, context) => {
          started.push(context.callId);
          return blockers[1].promise;
        },
        name: "subagent_run",
      }),
    );

    const write = scheduler.execute({
      callId: "write_1",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "edit",
    });
    const memory = scheduler.execute({
      callId: "memory_1",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "memory_add",
    });
    const subagent1 = scheduler.execute({
      callId: "subagent_1",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "subagent_run",
    });
    const subagent2 = scheduler.execute({
      callId: "subagent_2",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "subagent_run",
    });

    await vi.waitFor(() => {
      expect(started).toContain("write_1");
      expect(started).toContain("memory_1");
      expect(started).toContain("subagent_1");
      expect(scheduler.getStatus("subagent_2")).toBe("queued");
    });

    blockers[1].resolve({ output: "subagent done" });
    blockers[0].resolve({ output: "write done" });

    await expect(memory).resolves.toMatchObject({ status: "success" });
    await expect(subagent1).resolves.toMatchObject({ status: "success" });
    await expect(subagent2).resolves.toMatchObject({ status: "success" });
    await expect(write).resolves.toMatchObject({ status: "success" });
  });

  it("executes batches in waves while returning results in input order", async () => {
    const started: string[] = [];
    const { scheduler } = createScheduler({
      config: { concurrency: { maxSubagentConcurrency: 1 } },
    });
    for (const toolName of ["read", "edit", "memory_add"]) {
      scheduler.register(
        createTool({
          execute: (_params, context) => {
            started.push(context.callId);
            return Promise.resolve({ output: context.callId });
          },
          name: toolName,
        }),
      );
    }

    await expect(
      scheduler.executeBatch({
        calls: [
          {
            callId: "read_1",
            messageId: "message_1",
            params: {},
            sessionId: "session_1",
            toolName: "read",
          },
          {
            callId: "write_1",
            messageId: "message_1",
            params: {},
            sessionId: "session_1",
            toolName: "edit",
          },
          {
            callId: "memory_1",
            messageId: "message_1",
            params: {},
            sessionId: "session_1",
            toolName: "memory_add",
          },
        ],
      }),
    ).resolves.toMatchObject([
      { callId: "read_1", status: "success" },
      { callId: "write_1", status: "success" },
      { callId: "memory_1", status: "success" },
    ]);
    expect(started).toContain("memory_1");
    expect(started.indexOf("read_1")).toBeLessThan(started.indexOf("write_1"));
  });

  it("passes each batch call environment through waves and detached tools", async () => {
    const { scheduler } = createScheduler({
      config: { concurrency: { maxSubagentConcurrency: 1 } },
    });
    for (const tool of [
      { name: "read", category: "readonly" },
      { name: "edit", category: "write" },
      { name: "memory_add", category: "memory" },
      { name: "subagent_run", category: "subagent" },
    ] as const) {
      scheduler.register(
        createTool({
          category: tool.category,
          execute: (_params, context): Promise<ToolExecutionResult> =>
            Promise.resolve({
              output: `${context.callId}:${context.environment?.workdir ?? "missing"}`,
            }),
          name: tool.name,
        }),
      );
    }

    const makeEnvironment = (workdir: string): ToolExecutionEnvironment => ({
      workdir,
      resolvePath(inputPath: string): string {
        return `${workdir}/${inputPath}`;
      },
      resolvePathForExisting(inputPath: string): Promise<string> {
        return Promise.resolve(`${workdir}/${inputPath}`);
      },
      resolvePathForWrite(inputPath: string): Promise<string> {
        return Promise.resolve(`${workdir}/${inputPath}`);
      },
      resolveCommandContext(): { readonly cwd: string; readonly kind: string } {
        return { cwd: workdir, kind: "host-local" };
      },
    });

    await expect(
      scheduler.executeBatch({
        calls: [
          {
            callId: "read_1",
            environment: makeEnvironment("D:/workspace/read"),
            messageId: "message_1",
            params: {},
            sessionId: "session_1",
            toolName: "read",
          },
          {
            callId: "write_1",
            environment: makeEnvironment("D:/workspace/write"),
            messageId: "message_1",
            params: {},
            sessionId: "session_1",
            toolName: "edit",
          },
          {
            callId: "memory_1",
            environment: makeEnvironment("D:/workspace/memory"),
            messageId: "message_1",
            params: {},
            sessionId: "session_1",
            toolName: "memory_add",
          },
          {
            callId: "subagent_1",
            environment: makeEnvironment("D:/workspace/subagent"),
            messageId: "message_1",
            params: {},
            sessionId: "session_1",
            toolName: "subagent_run",
          },
        ],
      }),
    ).resolves.toMatchObject([
      { output: "read_1:D:/workspace/read", status: "success" },
      { output: "write_1:D:/workspace/write", status: "success" },
      { output: "memory_1:D:/workspace/memory", status: "success" },
      { output: "subagent_1:D:/workspace/subagent", status: "success" },
    ]);
  });

  it("executes builtin file and bash tools with a scheduler environment", async () => {
    const tempRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-scheduler-tools-")),
    );
    try {
      await fs.writeFile(
        path.join(tempRoot, "notes.txt"),
        "alpha\nbeta\n",
        "utf8",
      );
      const child = new FakeChildProcess();
      const spawn = vi.fn<SpawnCommand>(
        (
          _file: string,
          _args: readonly string[],
          _options: SpawnOptionsWithoutStdio,
        ) => {
          queueMicrotask(() => {
            child.stdout.emit("data", Buffer.from("ran\n"));
            child.emit("exit", 0, null);
          });
          return child as unknown as ChildProcess;
        },
      );
      const { scheduler } = createScheduler();
      for (const tool of createBuiltinTools({
        shell: {
          acceptable: () => "/bin/bash",
          killTree: vi.fn(),
        },
        spawn,
      })) {
        scheduler.register(tool);
      }
      const environment = createFakeEnvironment(tempRoot);

      const results = await scheduler.executeBatch({
        calls: [
          {
            callId: "read_notes",
            environment,
            messageId: "message_1",
            params: { file_path: "notes.txt", limit: 1 },
            sessionId: "session_1",
            toolName: "read",
          },
          {
            callId: "list_root",
            environment,
            messageId: "message_1",
            params: { path: "." },
            sessionId: "session_1",
            toolName: "list",
          },
          {
            callId: "run_bash",
            environment,
            messageId: "message_1",
            params: { command: "echo ran" },
            sessionId: "session_1",
            toolName: "bash",
          },
        ],
      });

      expect(results).toMatchObject([
        { callId: "read_notes", status: "success" },
        { callId: "list_root", status: "success" },
        { callId: "run_bash", status: "success" },
      ]);
      expect(results[0]?.output).toContain("1: alpha");
      expect(results[1]?.output).toContain("notes.txt");
      expect(results[2]?.output).toContain("ran");
      expect(spawn.mock.calls[0]?.[2].cwd).toBe(tempRoot);
      expect(spawn.mock.calls[0]?.[2].env?.OHBABY_ENV_BRIDGE).toBe("present");
    } finally {
      await fs.rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("asks default permission before executing an approved external readonly path", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ohbaby-scheduler-external-read-"),
    );
    const workspace = path.join(tempRoot, "workspace");
    const externalDirectory = path.join(tempRoot, "outside");
    const externalFile = path.join(externalDirectory, "secret.txt");
    await fs.mkdir(workspace);
    await fs.mkdir(externalDirectory);
    await fs.writeFile(externalFile, "secret\n", "utf8");
    const permissionRequests: Parameters<PermissionPort["ask"]>[0][] = [];
    const permission = {
      ask: vi.fn((input: Parameters<PermissionPort["ask"]>[0]) => {
        permissionRequests.push(input);
        return Promise.resolve("once" as const);
      }),
    } satisfies PermissionPort;
    const { scheduler } = createScheduler({
      permission,
      permissionState: createPermissionState({
        bus: createBus(),
        initialLevel: "default",
      }),
    });
    for (const tool of createBuiltinTools()) {
      if (tool.name === "read") {
        scheduler.register(tool);
      }
    }

    try {
      const result = await scheduler.execute({
        callId: "read_external_default",
        environment: createFakeEnvironment(workspace),
        messageId: "message_1",
        params: { file_path: externalFile },
        sessionId: "session_1",
        toolName: "read",
      });

      expect(result).toMatchObject({ status: "success" });
      expect(result.output).toContain("secret");
      expect(permissionRequests.map((request) => request.toolName)).toEqual([
        "external_directory",
      ]);
      expect(permissionRequests[0]?.params).toMatchObject({
        path: await fs.realpath(externalFile),
        pattern: path.join(await fs.realpath(externalDirectory), "**"),
      });
    } finally {
      await fs.rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("executes external readonly paths in full access without asking", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ohbaby-scheduler-full-read-"),
    );
    const workspace = path.join(tempRoot, "workspace");
    const externalDirectory = path.join(tempRoot, "outside");
    const externalFile = path.join(externalDirectory, "secret.txt");
    await fs.mkdir(workspace);
    await fs.mkdir(externalDirectory);
    await fs.writeFile(externalFile, "full access\n", "utf8");
    const permission = {
      ask: vi.fn(() => Promise.resolve("reject" as const)),
    } satisfies PermissionPort;
    const { scheduler } = createScheduler({
      permission,
      permissionState: createPermissionState({
        bus: createBus(),
        initialLevel: "full-access",
      }),
    });
    for (const tool of createBuiltinTools()) {
      if (tool.name === "read") {
        scheduler.register(tool);
      }
    }

    try {
      const result = await scheduler.execute({
        callId: "read_external_full",
        environment: createFakeEnvironment(workspace),
        messageId: "message_1",
        params: { file_path: externalFile },
        sessionId: "session_1",
        toolName: "read",
      });

      expect(result).toMatchObject({ status: "success" });
      expect(result.output).toContain("full access");
      expect(permission.ask).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("executes external relative readonly paths after approval", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ohbaby-scheduler-relative-read-"),
    );
    const workspace = path.join(tempRoot, "workspace");
    const externalDirectory = path.join(tempRoot, "outside");
    const externalFile = path.join(externalDirectory, "secret.txt");
    await fs.mkdir(workspace);
    await fs.mkdir(externalDirectory);
    await fs.writeFile(externalFile, "relative\n", "utf8");
    const permission = {
      ask: vi.fn(() => Promise.resolve("once" as const)),
    } satisfies PermissionPort;
    const { scheduler } = createScheduler({
      permission,
      permissionState: createPermissionState({
        bus: createBus(),
        initialLevel: "default",
      }),
    });
    for (const tool of createBuiltinTools()) {
      if (tool.name === "read") {
        scheduler.register(tool);
      }
    }

    try {
      const result = await scheduler.execute({
        callId: "read_relative_external",
        environment: createFakeEnvironment(workspace),
        messageId: "message_1",
        params: { file_path: path.join("..", "outside", "secret.txt") },
        sessionId: "session_1",
        toolName: "read",
      });

      expect(result).toMatchObject({ status: "success" });
      expect(result.output).toContain("relative");
      expect(permission.ask).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not grant sibling or ancestor reads after approving an external file", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ohbaby-scheduler-external-read-scope-"),
    );
    const workspace = path.join(tempRoot, "workspace");
    const externalDirectory = path.join(tempRoot, "outside");
    const otherDirectory = path.join(tempRoot, "other");
    const externalFile = path.join(externalDirectory, "secret.txt");
    const siblingFile = path.join(externalDirectory, "sibling.txt");
    const otherFile = path.join(otherDirectory, "other.txt");
    await fs.mkdir(workspace);
    await fs.mkdir(externalDirectory);
    await fs.mkdir(otherDirectory);
    const environment = createHostLocalEnvironment(workspace);
    const workspaceFile = path.join(environment.workdir, "inside.txt");
    await fs.writeFile(workspaceFile, "inside\n", "utf8");
    await fs.writeFile(externalFile, "secret\n", "utf8");
    await fs.writeFile(siblingFile, "sibling\n", "utf8");
    await fs.writeFile(otherFile, "other\n", "utf8");
    const permission = {
      ask: vi.fn(() => Promise.resolve("once" as const)),
    } satisfies PermissionPort;
    const execute = vi.fn(
      async (
        params: Record<string, unknown>,
        context: ToolExecutionContext,
      ): Promise<ToolExecutionResult> => {
        const filePath = String(params.path);
        const environment = context.environment;
        if (!environment) {
          throw new Error("expected scheduler environment");
        }

        await expect(
          environment.resolvePathForExisting(path.dirname(filePath)),
        ).rejects.toThrow(/not approved/u);
        await expect(
          environment.resolvePathForExisting(siblingFile),
        ).rejects.toThrow(/not approved/u);
        await expect(
          environment.resolvePathForExisting(otherFile),
        ).rejects.toThrow(/not approved/u);

        expect(environment.resolvePath(workspaceFile)).toBe(
          path.resolve(workspaceFile),
        );
        await expect(
          environment.resolvePathForExisting(workspaceFile),
        ).resolves.toBe(await fs.realpath(workspaceFile));

        const exactPath = await environment.resolvePathForExisting(filePath);
        return { output: await fs.readFile(exactPath, "utf8") };
      },
    );
    const { scheduler } = createScheduler({
      permission,
      permissionState: createPermissionState({
        bus: createBus(),
        initialLevel: "default",
      }),
    });
    scheduler.register(
      createTool({
        category: "readonly",
        execute,
        name: "custom_read",
        parametersJsonSchema: {
          additionalProperties: false,
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
          type: "object",
        },
      }),
    );

    try {
      const result = await scheduler.execute({
        callId: "custom_read_external",
        environment,
        messageId: "message_1",
        params: { path: externalFile },
        sessionId: "session_1",
        toolName: "custom_read",
      });

      expect(result).toMatchObject({
        output: "secret\n",
        status: "success",
      });
      expect(permission.ask).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: "external_directory" }),
      );
    } finally {
      await fs.rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("allows descendants when approving an external readonly directory", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ohbaby-scheduler-external-read-dir-"),
    );
    const workspace = path.join(tempRoot, "workspace");
    const externalDirectory = path.join(tempRoot, "outside");
    await fs.mkdir(workspace);
    await fs.mkdir(externalDirectory);
    const environment = createHostLocalEnvironment(workspace);
    const canonicalExternalDirectory = await fs.realpath(externalDirectory);
    const childFile = path.join(
      canonicalExternalDirectory,
      "nested",
      "child.txt",
    );
    await fs.mkdir(path.dirname(childFile), { recursive: true });
    await fs.writeFile(childFile, "child\n", "utf8");
    const permission = {
      ask: vi.fn(() => Promise.resolve("once" as const)),
    } satisfies PermissionPort;
    const execute = vi.fn(
      async (
        params: Record<string, unknown>,
        context: ToolExecutionContext,
      ): Promise<ToolExecutionResult> => {
        const environment = context.environment;
        if (!environment) {
          throw new Error("expected scheduler environment");
        }
        const approvedDirectory = String(params.path);
        expect(environment.resolvePath(childFile)).toBe(
          path.resolve(childFile),
        );
        const resolvedChild =
          await environment.resolvePathForExisting(childFile);
        const resolvedDirectory =
          await environment.resolvePathForExisting(approvedDirectory);

        return {
          output: [
            await fs.readFile(resolvedChild, "utf8"),
            path.basename(resolvedDirectory),
          ].join(":"),
        };
      },
    );
    const { scheduler } = createScheduler({
      permission,
      permissionState: createPermissionState({
        bus: createBus(),
        initialLevel: "default",
      }),
    });
    scheduler.register(
      createTool({
        category: "readonly",
        execute,
        name: "custom_read_directory",
        parametersJsonSchema: {
          additionalProperties: false,
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
          type: "object",
        },
      }),
    );

    try {
      const result = await scheduler.execute({
        callId: "custom_read_external_directory",
        environment,
        messageId: "message_1",
        params: { path: canonicalExternalDirectory },
        sessionId: "session_1",
        toolName: "custom_read_directory",
      });

      expect(result).toMatchObject({
        output: "child\n:outside",
        status: "success",
      });
      expect(permission.ask).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: "external_directory" }),
      );
    } finally {
      await fs.rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not ask external permission for dot-dot-prefixed workspace paths", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ohbaby-scheduler-dotdot-prefix-"),
    );
    const workspace = path.join(tempRoot, "workspace");
    const internalDirectory = path.join(workspace, "..cache");
    const internalFile = path.join(internalDirectory, "note.txt");
    await fs.mkdir(internalDirectory, { recursive: true });
    await fs.writeFile(internalFile, "internal\n", "utf8");
    const permission = {
      ask: vi.fn(() => Promise.resolve("reject" as const)),
    } satisfies PermissionPort;
    const { scheduler } = createScheduler({
      permission,
      permissionState: createPermissionState({
        bus: createBus(),
        initialLevel: "default",
      }),
    });
    for (const tool of createBuiltinTools()) {
      if (tool.name === "read") {
        scheduler.register(tool);
      }
    }

    try {
      const result = await scheduler.execute({
        callId: "read_dotdot_prefix",
        environment: createHostLocalEnvironment(workspace),
        messageId: "message_1",
        params: { file_path: internalFile },
        sessionId: "session_1",
        toolName: "read",
      });

      expect(result).toMatchObject({ status: "success" });
      expect(result.output).toContain("internal");
      expect(permission.ask).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("executes external glob searches after default approval", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ohbaby-scheduler-external-glob-"),
    );
    const workspace = path.join(tempRoot, "workspace");
    const externalDirectory = path.join(tempRoot, "outside");
    await fs.mkdir(workspace);
    await fs.mkdir(path.join(externalDirectory, "nested"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(externalDirectory, "nested", "match.txt"),
      "match\n",
      "utf8",
    );
    const permission = {
      ask: vi.fn(() => Promise.resolve("once" as const)),
    } satisfies PermissionPort;
    const { scheduler } = createScheduler({
      permission,
      permissionState: createPermissionState({
        bus: createBus(),
        initialLevel: "default",
      }),
    });
    for (const tool of createBuiltinTools()) {
      if (tool.name === "glob") {
        scheduler.register(tool);
      }
    }

    try {
      const result = await scheduler.execute({
        callId: "glob_external_default",
        environment: createFakeEnvironment(workspace),
        messageId: "message_1",
        params: { path: externalDirectory, pattern: "**/*.txt" },
        sessionId: "session_1",
        toolName: "glob",
      });

      expect(result).toMatchObject({ status: "success" });
      expect(result.output).toContain("nested/match.txt");
      expect(permission.ask).toHaveBeenCalledTimes(1);
      expect(permission.ask).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: "external_directory" }),
      );
    } finally {
      await fs.rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("executes external grep searches in full access without asking", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ohbaby-scheduler-external-grep-"),
    );
    const workspace = path.join(tempRoot, "workspace");
    const externalDirectory = path.join(tempRoot, "outside");
    await fs.mkdir(workspace);
    await fs.mkdir(externalDirectory);
    await fs.writeFile(
      path.join(externalDirectory, "secret.txt"),
      "needle\n",
      "utf8",
    );
    const permission = {
      ask: vi.fn(() => Promise.resolve("reject" as const)),
    } satisfies PermissionPort;
    const { scheduler } = createScheduler({
      permission,
      permissionState: createPermissionState({
        bus: createBus(),
        initialLevel: "full-access",
      }),
    });
    for (const tool of createBuiltinTools()) {
      if (tool.name === "grep") {
        scheduler.register(tool);
      }
    }

    try {
      const result = await scheduler.execute({
        callId: "grep_external_full",
        environment: createFakeEnvironment(workspace),
        messageId: "message_1",
        params: { path: externalDirectory, pattern: "needle" },
        sessionId: "session_1",
        toolName: "grep",
      });

      expect(result).toMatchObject({ status: "success" });
      expect(result.output).toContain("secret.txt:1: needle");
      expect(permission.ask).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("asks before external absolute writes in full access", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ohbaby-scheduler-external-write-"),
    );
    const workspace = path.join(tempRoot, "workspace");
    const externalDirectory = path.join(tempRoot, "outside");
    const externalFile = path.join(externalDirectory, "nested", "outside.txt");
    await fs.mkdir(workspace);
    await fs.mkdir(externalDirectory);
    const permissionRequests: Parameters<PermissionPort["ask"]>[0][] = [];
    const permission = {
      ask: vi.fn((input: Parameters<PermissionPort["ask"]>[0]) => {
        permissionRequests.push(input);
        return Promise.resolve("once" as const);
      }),
    } satisfies PermissionPort;
    const { scheduler } = createScheduler({
      permission,
      permissionState: createPermissionState({
        bus: createBus(),
        initialLevel: "full-access",
      }),
    });
    for (const tool of createBuiltinTools()) {
      if (tool.name === "write") {
        scheduler.register(tool);
      }
    }

    try {
      const result = await scheduler.execute({
        callId: "write_external",
        environment: createFakeEnvironment(workspace),
        messageId: "message_1",
        params: { content: "external", file_path: externalFile },
        sessionId: "session_1",
        toolName: "write",
      });

      expect(result).toMatchObject({ status: "success" });
      expect(await fs.readFile(externalFile, "utf8")).toBe("external");
      expect(permissionRequests).toHaveLength(1);
      expect(permissionRequests[0]).toMatchObject({
        rememberable: undefined,
        toolName: "external_directory",
      });
      expect(permissionRequests[0]?.reason).toContain("External write path");
    } finally {
      await fs.rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not grant sibling or ancestor writes after approving an external file", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ohbaby-scheduler-external-scope-"),
    );
    const workspace = path.join(tempRoot, "workspace");
    const externalDirectory = path.join(tempRoot, "outside");
    const externalFile = path.join(externalDirectory, "outside.txt");
    await fs.mkdir(workspace);
    await fs.mkdir(externalDirectory);
    const permission = {
      ask: vi.fn(() => Promise.resolve("once" as const)),
    } satisfies PermissionPort;
    const execute = vi.fn(
      async (
        params: Record<string, unknown>,
        context: ToolExecutionContext,
      ): Promise<ToolExecutionResult> => {
        const filePath = String(params.file_path);
        const environment = context.environment;
        if (!environment) {
          throw new Error("expected scheduler environment");
        }

        await expect(
          environment.resolvePathForWrite(path.dirname(filePath)),
        ).rejects.toThrow(/not approved/u);
        await expect(
          environment.resolvePathForWrite(
            path.join(path.dirname(filePath), "sibling.txt"),
          ),
        ).rejects.toThrow(/not approved/u);

        const exactPath = await environment.resolvePathForWrite(filePath);
        await fs.writeFile(exactPath, "external", "utf8");
        return { output: "external" };
      },
    );
    const { scheduler } = createScheduler({ permission });
    scheduler.register(
      createTool({
        category: "write",
        execute,
        name: "custom_write",
        parametersJsonSchema: {
          additionalProperties: false,
          properties: {
            content: { type: "string" },
            file_path: { type: "string" },
          },
          required: ["file_path"],
          type: "object",
        },
      }),
    );

    try {
      const result = await scheduler.execute({
        callId: "custom_write_external",
        environment: createFakeEnvironment(workspace),
        messageId: "message_1",
        params: { file_path: externalFile },
        sessionId: "session_1",
        toolName: "custom_write",
      });

      expect(result).toMatchObject({ status: "success" });
      expect(await fs.readFile(externalFile, "utf8")).toBe("external");
      await expect(
        fs.readFile(path.join(externalDirectory, "sibling.txt"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await fs.rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("preflights every batch call before starting tools and confirms asks serially", async () => {
    const executionOrder: string[] = [];
    const permissionOrder: string[] = [];
    const bus = createBus();
    const { scheduler } = createScheduler({
      permissionState: createPermissionState({ bus }),
      permission: {
        ask: (input) => {
          permissionOrder.push(input.toolName);
          return Promise.resolve("once");
        },
      },
    });
    for (const toolName of ["read", "edit", "bash"]) {
      scheduler.register(
        createTool({
          execute: (_params, context) => {
            expect(permissionOrder).toEqual(["edit", "bash"]);
            executionOrder.push(context.callId);
            return Promise.resolve({ output: context.callId });
          },
          name: toolName,
        }),
      );
    }

    await expect(
      scheduler.executeBatch({
        calls: [
          {
            callId: "read_1",
            messageId: "message_1",
            params: {},
            sessionId: "session_1",
            toolName: "read",
          },
          {
            callId: "write_1",
            messageId: "message_1",
            params: {},
            sessionId: "session_1",
            toolName: "edit",
          },
          {
            callId: "danger_1",
            messageId: "message_1",
            params: {},
            sessionId: "session_1",
            toolName: "bash",
          },
        ],
      }),
    ).resolves.toMatchObject([
      { callId: "read_1", status: "success" },
      { callId: "write_1", status: "success" },
      { callId: "danger_1", status: "success" },
    ]);
    expect(permissionOrder).toEqual(["edit", "bash"]);
    expect(executionOrder).toEqual(["read_1", "write_1", "danger_1"]);
  });

  it("does not run batch permission side effects for already cancelled calls", async () => {
    const permissionOrder: string[] = [];
    const preAborted = new AbortController();
    preAborted.abort();
    const bus = createBus();
    const { scheduler } = createScheduler({
      permissionState: createPermissionState({ bus }),
      permission: {
        ask: (input) => {
          permissionOrder.push(input.toolName);
          if (input.toolName === "edit") {
            scheduler.cancel("danger_1");
          }
          return Promise.resolve("once");
        },
      },
    });
    for (const toolName of ["read", "edit", "bash"]) {
      scheduler.register(createTool({ name: toolName }));
    }

    await expect(
      scheduler.executeBatch({
        calls: [
          {
            callId: "pre_aborted",
            messageId: "message_1",
            params: {},
            sessionId: "session_1",
            signal: preAborted.signal,
            toolName: "read",
          },
          {
            callId: "write_1",
            messageId: "message_1",
            params: {},
            sessionId: "session_1",
            toolName: "edit",
          },
          {
            callId: "danger_1",
            messageId: "message_1",
            params: {},
            sessionId: "session_1",
            toolName: "bash",
          },
        ],
      }),
    ).resolves.toMatchObject([
      { callId: "pre_aborted", status: "cancelled" },
      { callId: "write_1", status: "success" },
      { callId: "danger_1", status: "cancelled" },
    ]);
    expect(permissionOrder).toEqual(["edit"]);
  });

  it("does not let later reads starve a queued write", async () => {
    const readBlocker = deferred<ToolExecutionResult>();
    const writeBlocker = deferred<ToolExecutionResult>();
    const started: string[] = [];
    const { scheduler } = createScheduler();
    scheduler.register(
      createTool({
        execute: (_params, context) => {
          started.push(context.callId);
          if (context.callId === "read_1") {
            return readBlocker.promise;
          }
          return Promise.resolve({ output: context.callId });
        },
        name: "read",
      }),
    );
    scheduler.register(
      createTool({
        execute: (_params, context) => {
          started.push(context.callId);
          return writeBlocker.promise;
        },
        name: "edit",
      }),
    );

    const read1 = scheduler.execute({
      callId: "read_1",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "read",
    });
    const write1 = scheduler.execute({
      callId: "write_1",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "edit",
    });
    await vi.waitFor(() => {
      expect(scheduler.getStatus("write_1")).toBe("queued");
    });
    const read2 = scheduler.execute({
      callId: "read_2",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "read",
    });
    await vi.waitFor(() => {
      expect(scheduler.getStatus("read_2")).toBe("queued");
    });
    readBlocker.resolve({ output: "read_1" });
    await vi.waitFor(() => {
      expect(started).toEqual(["read_1", "write_1"]);
    });
    writeBlocker.resolve({ output: "write_1" });

    await expect(read1).resolves.toMatchObject({ status: "success" });
    await expect(write1).resolves.toMatchObject({ status: "success" });
    await expect(read2).resolves.toMatchObject({ status: "success" });
    expect(started).toEqual(["read_1", "write_1", "read_2"]);
  });

  it("starts later reads after a queued write barrier is cancelled", async () => {
    const readBlocker = deferred<ToolExecutionResult>();
    const started: string[] = [];
    const { scheduler } = createScheduler();
    scheduler.register(
      createTool({
        execute: (_params, context) => {
          started.push(context.callId);
          if (context.callId === "read_1") {
            return readBlocker.promise;
          }
          return Promise.resolve({ output: context.callId });
        },
        name: "read",
      }),
    );
    scheduler.register(createTool({ name: "edit" }));

    const read1 = scheduler.execute({
      callId: "read_1",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "read",
    });
    const write1 = scheduler.execute({
      callId: "write_1",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "edit",
    });
    await vi.waitFor(() => {
      expect(scheduler.getStatus("write_1")).toBe("queued");
    });
    const read2 = scheduler.execute({
      callId: "read_2",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "read",
    });
    await vi.waitFor(() => {
      expect(scheduler.getStatus("read_2")).toBe("queued");
    });

    expect(scheduler.cancel("write_1")).toBe(true);
    await expect(write1).resolves.toMatchObject({ status: "cancelled" });
    await expect(read2).resolves.toMatchObject({ status: "success" });
    expect(started).toEqual(["read_1", "read_2"]);
    readBlocker.resolve({ output: "read_1" });
    await expect(read1).resolves.toMatchObject({ status: "success" });
  });

  it("cancels queued calls and aborts executing calls", async () => {
    const running = deferred<{ readonly output: string }>();
    let executingSignal: AbortSignal | undefined;
    const { scheduler } = createScheduler();
    scheduler.register(
      createTool({
        execute: (_params, context: ToolExecutionContext) => {
          executingSignal = context.signal;
          return running.promise;
        },
        name: "edit",
      }),
    );

    const executing = scheduler.execute({
      callId: "write_1",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "edit",
    });
    const queued = scheduler.execute({
      callId: "write_2",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "edit",
    });

    await vi.waitFor(() => {
      expect(scheduler.getStatus("write_2")).toBe("queued");
    });

    expect(scheduler.cancel("write_2")).toBe(true);
    await expect(queued).resolves.toMatchObject({ status: "cancelled" });
    expect(scheduler.cancel("write_1")).toBe(true);
    expect(executingSignal?.aborted).toBe(true);
    running.resolve({ output: "ignored" });
    await expect(executing).resolves.toMatchObject({ status: "cancelled" });
  });

  it("times out non-cooperative tools and releases their slot", async () => {
    const started: string[] = [];
    const { scheduler } = createScheduler({
      config: { timeout: { defaultTimeout: 10 } },
    });
    scheduler.register(
      createTool({
        execute: (_params, context) => {
          started.push(context.callId);
          return new Promise<ToolExecutionResult>(() => undefined);
        },
        name: "slow_write",
      }),
    );
    scheduler.register(
      createTool({
        execute: (_params, context) => {
          started.push(context.callId);
          return Promise.resolve({ output: "after timeout" });
        },
        name: "edit",
      }),
    );

    await expect(
      scheduler.execute({
        callId: "slow_1",
        messageId: "message_1",
        params: {},
        sessionId: "session_1",
        toolName: "slow_write",
      }),
    ).resolves.toMatchObject({
      error: { type: "TimeoutError" },
      status: "error",
    });

    await expect(
      scheduler.execute({
        callId: "write_2",
        messageId: "message_1",
        params: {},
        sessionId: "session_1",
        toolName: "edit",
      }),
    ).resolves.toMatchObject({
      output: "after timeout",
      status: "success",
    });
    expect(started).toEqual(["slow_1", "write_2"]);
  });

  it("cancels non-cooperative executing tools and releases their slot", async () => {
    const started: string[] = [];
    const { scheduler } = createScheduler();
    scheduler.register(
      createTool({
        execute: (_params, context) => {
          started.push(context.callId);
          return new Promise<ToolExecutionResult>(() => undefined);
        },
        name: "slow_write",
      }),
    );
    scheduler.register(
      createTool({
        execute: (_params, context) => {
          started.push(context.callId);
          return Promise.resolve({ output: "after cancel" });
        },
        name: "edit",
      }),
    );

    const running = scheduler.execute({
      callId: "slow_1",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "slow_write",
    });
    await vi.waitFor(() => {
      expect(started).toEqual(["slow_1"]);
    });

    expect(scheduler.cancel("slow_1")).toBe(true);
    await expect(running).resolves.toMatchObject({ status: "cancelled" });
    await expect(
      scheduler.execute({
        callId: "write_2",
        messageId: "message_1",
        params: {},
        sessionId: "session_1",
        toolName: "edit",
      }),
    ).resolves.toMatchObject({
      output: "after cancel",
      status: "success",
    });
    expect(started).toEqual(["slow_1", "write_2"]);
  });

  it("releases a granted slot when a queued call is cancelled before it resumes", async () => {
    const first = deferred<ToolExecutionResult>();
    const started: string[] = [];
    const { bus, scheduler } = createScheduler();
    scheduler.register(
      createTool({
        execute: (_params, context) => {
          started.push(context.callId);
          if (context.callId === "write_1") {
            return first.promise;
          }
          return Promise.resolve({ output: context.callId });
        },
        name: "edit",
      }),
    );
    bus.subscribe(ToolSchedulerEvent.ExecutionCompleted, (payload) => {
      if (payload.callId === "write_1") {
        scheduler.cancel("write_2");
      }
    });

    const write1 = scheduler.execute({
      callId: "write_1",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "edit",
    });
    const write2 = scheduler.execute({
      callId: "write_2",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "edit",
    });
    const write3 = scheduler.execute({
      callId: "write_3",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "edit",
    });

    await vi.waitFor(() => {
      expect(scheduler.getStatus("write_2")).toBe("queued");
    });
    first.resolve({ output: "first" });

    await expect(write1).resolves.toMatchObject({ status: "success" });
    await expect(write2).resolves.toMatchObject({ status: "cancelled" });
    await expect(write3).resolves.toMatchObject({
      output: "write_3",
      status: "success",
    });
    expect(started).toEqual(["write_1", "write_3"]);
  });

  it("does not execute a tool after execution-started subscribers cancel it", async () => {
    const execute = vi.fn().mockResolvedValue({ output: "should not run" });
    const { bus, scheduler } = createScheduler();
    scheduler.register(createTool({ execute, name: "edit" }));
    bus.subscribe(ToolSchedulerEvent.ExecutionStarted, (payload) => {
      if (payload.callId === "write_1") {
        scheduler.cancel("write_1");
      }
    });

    await expect(
      scheduler.execute({
        callId: "write_1",
        messageId: "message_1",
        params: {},
        sessionId: "session_1",
        toolName: "edit",
      }),
    ).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("honors request abort signals before permission evaluation and while queued", async () => {
    const blocker = deferred<ToolExecutionResult>();
    const execute = vi.fn((_params, context: ToolExecutionContext) => {
      if (context.callId === "write_1") {
        return blocker.promise;
      }
      return Promise.resolve({ output: context.callId });
    });
    const { scheduler } = createScheduler();
    scheduler.register(createTool({ execute, name: "edit" }));

    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      scheduler.execute({
        callId: "pre_aborted",
        messageId: "message_1",
        params: {},
        sessionId: "session_1",
        signal: preAborted.signal,
        toolName: "edit",
      }),
    ).resolves.toMatchObject({
      error: { type: "CancelledError" },
      status: "cancelled",
    });
    expect(execute).not.toHaveBeenCalled();

    const queuedAbort = new AbortController();
    const write1 = scheduler.execute({
      callId: "write_1",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "edit",
    });
    const write2 = scheduler.execute({
      callId: "write_2",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      signal: queuedAbort.signal,
      toolName: "edit",
    });

    await vi.waitFor(() => {
      expect(scheduler.getStatus("write_2")).toBe("queued");
    });
    queuedAbort.abort();
    await expect(write2).resolves.toMatchObject({ status: "cancelled" });
    blocker.resolve({ output: "write_1" });
    await expect(write1).resolves.toMatchObject({ status: "success" });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
