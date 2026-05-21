import { describe, expect, it, vi } from "vitest";
import type { TaskExecutor } from "../agents/index.js";
import type { Tool } from "../core/tool-scheduler/index.js";
import { createBuiltinTools } from "./index.js";

function getTaskTool(executor: TaskExecutor): Tool {
  const task = createBuiltinTools({ taskExecutor: executor }).find(
    (tool) => tool.name === "task",
  );
  if (!task) {
    throw new Error("task tool missing");
  }

  return task;
}

describe("task builtin tool", () => {
  it("is not registered until a task executor is injected", () => {
    expect(createBuiltinTools().some((tool) => tool.name === "task")).toBe(
      false,
    );
  });

  it("executes a subagent task through the injected executor", async () => {
    const execute = vi.fn<TaskExecutor["execute"]>(() =>
      Promise.resolve({
        output: "subagent output",
        sessionId: "child_1",
        success: true,
        summary: { duration: 5, steps: 1, toolCalls: [] },
      }),
    );
    const executor: TaskExecutor = {
      execute,
    };
    const task = getTaskTool(executor);

    const result = await task.execute(
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
    );

    expect(result.output).toBe("subagent output");
    expect(result.metadata?.subagent).toMatchObject({
      sessionId: "child_1",
      success: true,
    });
    expect(execute).toHaveBeenCalledOnce();
    const executeInput = execute.mock.calls[0][0];
    expect(executeInput).toMatchObject({
      agentName: "explore",
      description: "Explore files",
      parentSessionId: "parent_1",
      prompt: "Find the auth module",
      resumeSessionId: "child_existing",
    });
    expect(executeInput.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects missing task parameters", async () => {
    const task = getTaskTool({
      execute: vi.fn<TaskExecutor["execute"]>(),
    });

    await expect(
      task.execute(
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
