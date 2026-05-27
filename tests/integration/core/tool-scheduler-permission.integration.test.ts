import { describe, expect, it, vi } from "vitest";
import { createBus } from "../../../packages/ohbaby-agent/src/bus/index.js";
import { createToolScheduler } from "../../../packages/ohbaby-agent/src/core/tool-scheduler/index.js";
import type {
  Tool,
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
      permission,
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
      permission,
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
        callId: "call_2",
        messageId: "message_2",
        params: { file_path: "src/components/Card.tsx" },
        sessionId: "session_1",
        toolName: "edit",
      }),
    ).resolves.toMatchObject({ status: "success" });
    await expect(
      scheduler.execute({
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

  it("asks for writes in auto default and rejects writes in plan before permission", async () => {
    const bus = createBus();
    const permissionState = createPermissionState({ bus });
    const permission = createPermissionManager({ bus, state: permissionState });
    const scheduler = createToolScheduler({
      bus,
      permission,
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
        callId: "read_1",
        messageId: "message_1",
        params: { path: "README.md" },
        sessionId: "session_1",
        toolName: "read",
      }),
    ).resolves.toMatchObject({ output: "read", status: "success" });
    await expect(
      scheduler.execute({
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
        callId: "write_2",
        messageId: "message_2",
        params: { file_path: "src/components/Card.tsx" },
        sessionId: "session_1",
        toolName: "edit",
      }),
    ).resolves.toMatchObject({
      error: { type: "PermissionDeniedError" },
      status: "rejected",
    });

    expect(permissionUpdates.map((info) => info.callId)).toEqual(["write_1"]);
  });
});
