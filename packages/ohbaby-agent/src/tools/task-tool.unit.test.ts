import { describe, expect, it, vi } from "vitest";
import type { TaskExecutor } from "../core/agents/index.js";
import { createBuiltinTools } from "./index.js";

describe("task builtin tool", () => {
  it("is not registered until a task executor is injected", () => {
    expect(createBuiltinTools().some((tool) => tool.name === "task")).toBe(
      false,
    );
  });

  it("executes a subagent task through the injected executor", async () => {
    const executor: TaskExecutor = {
      execute: vi.fn(async () => ({
        output: "subagent output",
        sessionId: "child_1",
        success: true,
        summary: { duration: 5, steps: 1, toolCalls: [] },
      })),
    };
    const task = createBuiltinTools({ taskExecutor: executor }).find(
      (tool) => tool.name === "task",
    );
    expect(task).toBeDefined();

    await expect(
      task!.execute(
        {
          agent_name: "explore",
          description: "Explore files",
          prompt: "Find the auth module",
          resume_session_id: "child_existing",
        },
        {
          callId: "call_1",
          messageId: "message_1",
          sessionId: "parent_1",
          signal: new AbortController().signal,
        },
      ),
    ).resolves.toMatchObject({
      metadata: {
        subagent: expect.objectContaining({
          sessionId: "child_1",
          success: true,
        }),
      },
      output: "subagent output",
    });
    expect(executor.execute).toHaveBeenCalledWith({
      agentName: "explore",
      description: "Explore files",
      parentSessionId: "parent_1",
      prompt: "Find the auth module",
      resumeSessionId: "child_existing",
      signal: expect.any(AbortSignal),
    });
  });

  it("rejects missing task parameters", async () => {
    const task = createBuiltinTools({
      taskExecutor: {
        execute: vi.fn(),
      },
    }).find((tool) => tool.name === "task");
    expect(task).toBeDefined();

    await expect(
      task!.execute(
        { agent_name: "explore" },
        {
          callId: "call_1",
          messageId: "message_1",
          sessionId: "parent_1",
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow('Expected parameter "prompt" to be a non-empty string.');
  });
});
