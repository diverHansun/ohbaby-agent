import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createBus } from "../../../packages/ohbaby-agent/src/bus/index.js";
import {
  createToolScheduler,
  ToolSchedulerEvent,
} from "../../../packages/ohbaby-agent/src/core/tool-scheduler/index.js";
import type {
  Tool,
  ToolExecutionEnvironment,
  ToolExecutionResult,
} from "../../../packages/ohbaby-agent/src/core/tool-scheduler/index.js";
import {
  createPermissionManager,
  createPermissionState,
  PermissionEvent,
} from "../../../packages/ohbaby-agent/src/permission/index.js";
import type { PermissionInfo } from "../../../packages/ohbaby-agent/src/permission/index.js";

function createEditTool(
  execute: Tool["execute"] = (): ToolExecutionResult => ({ output: "edited" }),
): Tool {
  return {
    category: "write",
    description: "Edit a file",
    execute,
    name: "edit",
    parametersJsonSchema: {
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
      type: "object",
    },
    source: "builtin",
  };
}

function createReadTool(
  execute: Tool["execute"] = (): ToolExecutionResult => ({ output: "read" }),
): Tool {
  return {
    category: "readonly",
    description: "Read a file",
    execute,
    name: "read",
    parametersJsonSchema: {
      properties: { path: { type: "string" } },
      required: ["path"],
      type: "object",
    },
    source: "builtin",
  };
}

describe("tool-scheduler permission integration", () => {
  it("passes scheduler callId into permission updates before executing approved tools", async () => {
    const bus = createBus();
    const permissionState = createPermissionState({ bus });
    const permission = createPermissionManager({
      bus,
      generateId: () => "permission_1",
      state: permissionState,
    });
    const execute = vi.fn<Tool["execute"]>(() => ({ output: "edited" }));
    const scheduler = createToolScheduler({
      bus,
      permission: {
        ask: (input) =>
          permission.ask({
            ...input,
            source: {
              rootSessionId: input.sessionId,
              ancestorSessionIds: [input.sessionId],
            },
          }),
      },
      permissionState,
    });
    const permissionUpdates: PermissionInfo[] = [];

    scheduler.register(createEditTool(execute));
    bus.subscribe(PermissionEvent.Updated, (event) => {
      permissionUpdates.push(event.info);
      permission.respond(event.info.sessionId, event.info.id, { type: "once" });
    });

    await expect(
      scheduler.execute({
        runId: "actual_test_run",
        callId: "call_1",
        messageId: "message_1",
        params: { file_path: "src/components/Button.tsx" },
        sessionId: "session_1",
        toolName: "edit",
      }),
    ).resolves.toMatchObject({
      callId: "call_1",
      output: "edited",
      status: "success",
    });

    expect(permissionUpdates).toEqual([
      expect.objectContaining({
        callId: "call_1",
        id: "permission_1",
        runId: "actual_test_run",
        messageId: "message_1",
        sessionId: "session_1",
      }),
    ]);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("keeps always approval scoped to session permission rules", async () => {
    const bus = createBus();
    const permissionState = createPermissionState({ bus });
    const permission = createPermissionManager({
      bus,
      generateId: (() => {
        let nextId = 1;
        return () => `permission_${String(nextId++)}`;
      })(),
      state: permissionState,
    });
    const scheduler = createToolScheduler({
      bus,
      permission: {
        ask: (input) =>
          permission.ask({
            ...input,
            source: {
              rootSessionId: input.sessionId,
              ancestorSessionIds: [input.sessionId],
            },
          }),
      },
      permissionState,
    });
    const permissionUpdates: PermissionInfo[] = [];
    const permissionReplies: unknown[] = [];

    scheduler.register(createEditTool());
    bus.subscribe(PermissionEvent.Updated, (event) => {
      permissionUpdates.push(event.info);
      permission.respond(event.info.sessionId, event.info.id, {
        type: event.info.callId === "call_1" ? "always" : "once",
      });
    });
    bus.subscribe(PermissionEvent.Replied, (event) => {
      permissionReplies.push(event);
    });

    await expect(
      scheduler.execute({
        runId: "actual_test_run",
        callId: "call_1",
        messageId: "message_1",
        params: { file_path: "src/components/Button.tsx" },
        sessionId: "session_1",
        toolName: "edit",
      }),
    ).resolves.toMatchObject({ status: "success" });

    expect(permissionState.toSnapshot()).toEqual({
      level: "default",
      mode: "auto",
      sessionRules: [
        {
          rules: [
            {
              decision: "allow",
              pattern: "src/components/**",
              scope: "session",
              tool: "edit",
            },
          ],
          sessionId: "session_1",
        },
      ],
    });
    await expect(
      scheduler.execute({
        runId: "actual_test_run",
        callId: "call_2",
        messageId: "message_2",
        params: { file_path: "src/components/Card.tsx" },
        sessionId: "session_1",
        toolName: "edit",
      }),
    ).resolves.toMatchObject({ status: "success" });
    await expect(
      scheduler.execute({
        runId: "actual_test_run",
        callId: "call_3",
        messageId: "message_3",
        params: { file_path: "src/pages/Home.tsx" },
        sessionId: "session_1",
        toolName: "edit",
      }),
    ).resolves.toMatchObject({ status: "success" });

    expect(permissionUpdates.map((info) => info.callId)).toEqual([
      "call_1",
      "call_3",
    ]);
    expect(permissionReplies).toEqual([
      expect.objectContaining({
        callId: "call_1",
        permissionId: "permission_1",
        response: {
          pattern: "edit(src/components/**)",
          type: "always",
        },
        sessionId: "session_1",
      }),
      expect.objectContaining({
        callId: "call_3",
        permissionId: "permission_2",
        response: { type: "once" },
        sessionId: "session_1",
      }),
    ]);
  });

  it("asks for writes in auto default and plan default", async () => {
    const bus = createBus();
    const permissionState = createPermissionState({ bus });
    const permission = createPermissionManager({ bus, state: permissionState });
    const scheduler = createToolScheduler({
      bus,
      permission: {
        ask: (input) =>
          permission.ask({
            ...input,
            source: {
              rootSessionId: input.sessionId,
              ancestorSessionIds: [input.sessionId],
            },
          }),
      },
      permissionState,
    });
    const permissionUpdates: PermissionInfo[] = [];

    scheduler.register(createReadTool());
    scheduler.register(createEditTool());
    bus.subscribe(PermissionEvent.Updated, (event) => {
      permissionUpdates.push(event.info);
      permission.respond(event.info.sessionId, event.info.id, { type: "once" });
    });

    await expect(
      scheduler.execute({
        runId: "actual_test_run",
        callId: "read_1",
        messageId: "message_1",
        params: { path: "README.md" },
        sessionId: "session_1",
        toolName: "read",
      }),
    ).resolves.toMatchObject({ output: "read", status: "success" });
    await expect(
      scheduler.execute({
        runId: "actual_test_run",
        callId: "write_1",
        messageId: "message_1",
        params: { file_path: "src/components/Button.tsx" },
        sessionId: "session_1",
        toolName: "edit",
      }),
    ).resolves.toMatchObject({ output: "edited", status: "success" });

    permissionState.setMode("plan");
    await expect(
      scheduler.execute({
        runId: "actual_test_run",
        callId: "write_2",
        messageId: "message_2",
        params: { file_path: "src/components/Card.tsx" },
        sessionId: "session_1",
        toolName: "edit",
      }),
    ).resolves.toMatchObject({ output: "edited", status: "success" });

    expect(permissionUpdates.map((info) => info.callId)).toEqual([
      "write_1",
      "write_2",
    ]);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function permissionFixture(level: "default" | "full-access" = "default") {
  const bus = createBus();
  const state = createPermissionState({ bus, initialLevel: level });
  const permission = createPermissionManager({ bus, state });
  const asks: Parameters<
    import("../../../packages/ohbaby-agent/src/core/tool-scheduler/index.js").PermissionPort["ask"]
  >[0][] = [];
  const updates: PermissionInfo[] = [];
  const nextRequest = deferred<PermissionInfo>();
  const scheduler = createToolScheduler({
    bus,
    permissionState: state,
    permission: {
      ask: (input) => {
        asks.push(input);
        return permission.ask({
          ...input,
          source: {
            rootSessionId: "root",
            ancestorSessionIds: [input.sessionId, "root"],
          },
        });
      },
    },
  });
  bus.subscribe(PermissionEvent.Updated, ({ info }) => {
    updates.push(info);
    nextRequest.resolve(info);
  });
  return { bus, state, permission, scheduler, asks, updates, nextRequest };
}

const actualCall = {
  runId: "child_actual_run",
  contextScopeId: "child_scope",
  sessionId: "child_session",
  messageId: "child_message",
  callId: "child_call",
};

function externalEnvironment(): ToolExecutionEnvironment {
  return {
    workdir: "/workspace",
    resolvePath: (value) => path.resolve("/workspace", value),
    resolvePathForExisting: async (value) => path.resolve("/workspace", value),
    resolvePathForWrite: async (value) => path.resolve("/workspace", value),
    resolveCommandContext: () => ({ cwd: "/workspace", kind: "test" }),
    preflight: async () => ({
      commands: [],
      denylistHits: [],
      externalPaths: [
        {
          absolutePath: "/outside/report.txt",
          askPattern: "/outside/**",
          original: "/outside/report.txt",
        },
      ],
      internalPaths: [],
      overallDanger: "mutating",
      sensitivePaths: [],
      shellKind: "bash",
    }),
  };
}

const approvalKinds = [
  {
    label: "ordinary",
    name: "edit",
    category: "write" as const,
    source: "builtin" as const,
    params: { file_path: "src/file.ts" },
    expected: "edit",
  },
  {
    label: "explicit MCP",
    name: "remote_read",
    category: "readonly" as const,
    source: "mcp" as const,
    requireExplicitApproval: true,
    params: {},
    expected: "remote_read",
  },
  {
    label: "skill",
    name: "skill",
    category: "skill" as const,
    source: "skill" as const,
    params: { name: "inspect" },
    expected: "skill",
  },
  {
    label: "external read",
    name: "read",
    category: "readonly" as const,
    source: "builtin" as const,
    params: { path: "/outside/report.txt" },
    expected: "external_directory",
  },
  {
    label: "external write",
    name: "write",
    category: "write" as const,
    source: "builtin" as const,
    params: { file_path: "/outside/report.txt" },
    expected: "external_directory",
  },
];

describe("tool approval execution identity and cancellation", () => {
  it.each(approvalKinds)(
    "revokes $label approval using its original call signal",
    async ({ name, category, source, params, expected, ...rest }) => {
      const fixture = permissionFixture();
      // Allow the ordinary write decision so the separate external-directory admission is exercised.
      if (name === "write")
        fixture.state.addSessionRule("child_session", {
          tool: "write",
          pattern: "**",
          decision: "allow",
          scope: "session",
        });
      const execute = vi.fn(() => ({ output: "executed" }));
      fixture.scheduler.register({
        name,
        category,
        source,
        execute,
        description: name,
        parametersJsonSchema: {},
        requireExplicitApproval:
          "requireExplicitApproval" in rest && rest.requireExplicitApproval,
      });
      const running = fixture.scheduler.execute({
        ...actualCall,
        toolName: name,
        params,
        environment: externalEnvironment(),
      });
      const info = await fixture.nextRequest.promise;
      expect(info).toMatchObject({ ...actualCall, rootSessionId: "root" });
      expect(fixture.asks[0]?.toolName).toBe(expected);
      expect(fixture.asks[0]?.signal.aborted).toBe(false);
      fixture.scheduler.cancel(actualCall.callId);
      expect(fixture.asks[0]?.signal.aborted).toBe(true);
      expect(await running).toMatchObject({ status: "cancelled" });
      expect(fixture.permission.listPending()).toEqual([]);
      expect(
        fixture.permission.respond(info.sessionId, info.id, { type: "always" }),
      ).toBe("revoked");
      expect(
        fixture.state
          .getSessionRules("child_session")
          .filter((rule) => rule.tool !== "write"),
      ).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each(["pre-aborted", "before ask microtask"])(
    "does not register approval when cancelled %s",
    async (moment) => {
      const fixture = permissionFixture();
      const execute = vi.fn(() => ({ output: "executed" }));
      fixture.scheduler.register(createEditTool(execute));
      const controller = new AbortController();
      if (moment === "pre-aborted") controller.abort();
      else
        fixture.bus.subscribe(ToolSchedulerEvent.StatusChanged, (event) => {
          if (event.currentStatus === "awaiting_approval") controller.abort();
        });
      expect(
        await fixture.scheduler.execute({
          ...actualCall,
          signal: controller.signal,
          toolName: "edit",
          params: { file_path: "src/file.ts" },
        }),
      ).toMatchObject({ status: "cancelled" });
      expect(fixture.updates).toEqual([]);
      expect(fixture.permission.listPending()).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each(["once", "always"] as const)(
    "requires a second independent approval after external-directory %s",
    async (choice) => {
      const fixture = permissionFixture();
      const execute = vi.fn(() => ({ output: "executed" }));
      fixture.scheduler.register({
        name: "bash",
        category: "dangerous",
        source: "builtin",
        description: "shell",
        parametersJsonSchema: {},
        execute,
      });
      fixture.bus.subscribe(PermissionEvent.Updated, ({ info }) => {
        if (fixture.updates.length === 1)
          fixture.permission.respond(info.sessionId, info.id, { type: choice });
        else {
          expect(
            fixture.permission.respond(info.sessionId, fixture.updates[0]!.id, {
              type: "once",
            }),
          ).toBe("already-resolved");
          fixture.permission.respond(info.sessionId, info.id, {
            type: "reject",
          });
        }
      });
      expect(
        await fixture.scheduler.execute({
          ...actualCall,
          toolName: "bash",
          params: { command: "cat /outside/report.txt" },
          environment: externalEnvironment(),
        }),
      ).toMatchObject({ status: "rejected" });
      expect(fixture.asks.map((input) => input.toolName)).toEqual([
        "external_directory",
        "bash",
      ]);
      expect(new Set(fixture.updates.map((info) => info.id)).size).toBe(2);
      expect(fixture.asks[0]?.signal).toBe(fixture.asks[1]?.signal);
      expect(fixture.state.getSessionRules("child_session")).toHaveLength(
        choice === "always" ? 1 : 0,
      );
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each(["once", "always"] as const)(
    "does not execute if cancelled synchronously after a valid %s answer",
    async (choice) => {
      const fixture = permissionFixture();
      const execute = vi.fn(() => ({ output: "executed" }));
      fixture.scheduler.register(createEditTool(execute));
      fixture.bus.subscribe(PermissionEvent.Updated, ({ info }) => {
        fixture.permission.respond(info.sessionId, info.id, { type: choice });
        fixture.scheduler.cancel(info.callId);
      });
      expect(
        await fixture.scheduler.execute({
          ...actualCall,
          toolName: "edit",
          params: { file_path: "src/file.ts" },
        }),
      ).toMatchObject({ status: "cancelled" });
      expect(fixture.permission.listPending()).toEqual([]);
      expect(fixture.state.getSessionRules("child_session")).toHaveLength(
        choice === "always" ? 1 : 0,
      );
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each(
    approvalKinds.flatMap((kind) =>
      [false, true].map((isSubagent) => ({ ...kind, isSubagent })),
    ),
  )(
    "executes $label in full access without approvals or remembered rules (child=$isSubagent)",
    async ({ name, category, source, params, isSubagent, ...rest }) => {
      const fixture = permissionFixture("full-access");
      const execute = vi.fn(() => ({ output: "executed" }));
      fixture.scheduler.register({
        name,
        category,
        source,
        execute,
        description: name,
        parametersJsonSchema: {},
        requireExplicitApproval:
          "requireExplicitApproval" in rest && rest.requireExplicitApproval,
      });
      expect(
        await fixture.scheduler.execute({
          ...actualCall,
          isSubagent,
          toolName: name,
          params,
          environment: externalEnvironment(),
        }),
      ).toMatchObject({ status: "success" });
      expect(fixture.asks).toEqual([]);
      expect(fixture.permission.listPending()).toEqual([]);
      expect(fixture.state.getSessionRules("child_session")).toEqual([]);
      expect(execute).toHaveBeenCalledOnce();
    },
  );

  it("revokes run A without projection while run B in the same session remains answerable", async () => {
    const fixture = permissionFixture();
    const execute = vi.fn(() => ({ output: "executed" }));
    fixture.scheduler.register(createEditTool(execute));
    const secondRequest = deferred<PermissionInfo>();
    fixture.bus.subscribe(PermissionEvent.Updated, ({ info }) => {
      if (info.runId === "run_B") secondRequest.resolve(info);
    });
    const first = fixture.scheduler.execute({
      ...actualCall,
      runId: "run_A",
      callId: "call_A",
      toolName: "edit",
      params: { file_path: "src/a.ts" },
    });
    await fixture.nextRequest.promise;
    const second = fixture.scheduler.execute({
      ...actualCall,
      runId: "run_B",
      callId: "call_B",
      toolName: "edit",
      params: { file_path: "src/b.ts" },
    });
    const pendingB = await secondRequest.promise;
    fixture.permission.revokeByRun("run_A", "completed");
    expect(await first).toMatchObject({ status: "cancelled" });
    expect(fixture.permission.listPending().map((info) => info.runId)).toEqual([
      "run_B",
    ]);
    fixture.permission.respond(pendingB.sessionId, pendingB.id, {
      type: "once",
    });
    expect(await second).toMatchObject({ status: "success" });
    expect(execute).toHaveBeenCalledOnce();
    expect(fixture.permission.listPending()).toEqual([]);
  });

  it("preserves explicit deny and validation in full access", async () => {
    const fixture = permissionFixture("full-access");
    const execute = vi.fn(() => ({ output: "executed" }));
    fixture.scheduler.register(createEditTool(execute));
    fixture.state.addSessionRule("child_session", {
      tool: "edit",
      pattern: "**",
      decision: "deny",
      scope: "session",
    });
    expect(
      await fixture.scheduler.execute({
        ...actualCall,
        toolName: "edit",
        params: { file_path: "src/file.ts" },
      }),
    ).toMatchObject({ status: "rejected" });
    expect(
      await fixture.scheduler.execute({
        ...actualCall,
        callId: "invalid_call",
        toolName: "edit",
        params: {},
      }),
    ).toMatchObject({ status: "error", error: { type: "ValidationError" } });
    expect(fixture.asks).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });
});
