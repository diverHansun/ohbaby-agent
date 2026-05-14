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

  it("uses always approval to move policy into automatic edit state", async () => {
    const bus = createBus();
    const policy = createPolicyManager({ bus });
    const permission = createPermissionManager({
      bus,
      generateId: () => "permission_1",
    });
    const scheduler = createToolScheduler({ bus, permission, policy });

    scheduler.register(createEditTool());
    bus.subscribe(PermissionEvent.Updated, (event) => {
      permission.respond(event.info.sessionId, event.info.id, {
        type: "always",
      });
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
      agentState: "edit-automatically",
      mode: "agent",
    });
  });
});
