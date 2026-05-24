import { describe, expect, it, vi } from "vitest";
import { createBus } from "../../../packages/ohbaby-agent/src/bus/index.js";
import { createToolScheduler } from "../../../packages/ohbaby-agent/src/core/tool-scheduler/index.js";
import type {
  Tool,
  ToolExecutionResult,
} from "../../../packages/ohbaby-agent/src/core/tool-scheduler/index.js";
import {
  createPermissionManager,
  PermissionEvent,
} from "../../../packages/ohbaby-agent/src/permission/index.js";
import type { PermissionInfo } from "../../../packages/ohbaby-agent/src/permission/index.js";
import { createPolicyManager } from "../../../packages/ohbaby-agent/src/policy/index.js";

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

describe("tool-scheduler policy permission integration", () => {
  it("passes scheduler callId into permission updates before executing approved tools", async () => {
    const bus = createBus();
    const policy = createPolicyManager({ bus });
    const permission = createPermissionManager({
      bus,
      generateId: () => "permission_1",
    });
    const execute = vi.fn<Tool["execute"]>(() => ({ output: "edited" }));
    const scheduler = createToolScheduler({ bus, permission, policy });
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

  it("keeps always approval scoped to permission patterns instead of global policy writes", async () => {
    const bus = createBus();
    const policy = createPolicyManager({ bus });
    const permission = createPermissionManager({
      bus,
      generateId: (() => {
        let nextId = 1;
        return () => `permission_${String(nextId++)}`;
      })(),
    });
    const scheduler = createToolScheduler({ bus, permission, policy });
    const permissionUpdates: PermissionInfo[] = [];
    const permissionReplies: unknown[] = [];
    const switchRequests: unknown[] = [];

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
    bus.subscribe(PermissionEvent.AutoEditRequested, (event) => {
      switchRequests.push(event);
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

    expect(policy.getState()).toEqual({
      agentState: "ask-before-edit",
      mode: "agent",
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
          pattern: "tool:edit:src/components/**",
          type: "always",
        },
        sessionId: "session_1",
      }),
      expect.objectContaining({
        callId: "call_2",
        permissionId: "permission_2",
        response: {
          pattern: "tool:edit:src/components/**",
          type: "auto_approved",
        },
        sessionId: "session_1",
      }),
      expect.objectContaining({
        callId: "call_3",
        permissionId: "permission_3",
        response: { type: "once" },
        sessionId: "session_1",
      }),
    ]);
    expect(switchRequests).toEqual([
      {
        sessionId: "session_1",
        targetPermission: "edit-automatically",
        trigger: {
          callId: "call_1",
          pattern: "tool:edit:src/components/**",
          permissionId: "permission_1",
        },
      },
    ]);
  });

  it("lets ask and plan modes run readonly tools while rejecting writes before permission", async () => {
    const bus = createBus();
    const policy = createPolicyManager({ bus });
    const permission = createPermissionManager({ bus });
    const scheduler = createToolScheduler({ bus, permission, policy });
    const permissionUpdates: PermissionInfo[] = [];

    scheduler.register(createReadTool());
    scheduler.register(createEditTool());
    bus.subscribe(PermissionEvent.Updated, (event) => {
      permissionUpdates.push(event.info);
    });

    policy.setMode("ask");
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
    ).resolves.toMatchObject({
      error: { type: "PolicyDeniedError" },
      status: "rejected",
    });

    policy.setMode("plan");
    await expect(
      scheduler.execute({
        callId: "write_2",
        messageId: "message_2",
        params: { file_path: "src/components/Card.tsx" },
        sessionId: "session_1",
        toolName: "edit",
      }),
    ).resolves.toMatchObject({
      error: { type: "PolicyDeniedError" },
      status: "rejected",
    });

    expect(permissionUpdates).toEqual([]);
  });
});
