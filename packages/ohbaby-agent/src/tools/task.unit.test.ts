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
        description: "Explore files",
        name: "files-scout",
        output: "subagent output",
        role: "explore",
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
        description: "Explore files",
        name: "files-scout",
        prompt: "Find the auth module",
        role: "explore",
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
      description: "Explore files",
      name: "files-scout",
      parentSessionId: "parent_1",
      prompt: "Find the auth module",
      role: "explore",
      resumeSessionId: "child_existing",
    });
    expect(executeInput.signal).toBeInstanceOf(AbortSignal);
    expect(executeInput).not.toHaveProperty("agentName");
  });

  it("exposes role metadata schema with generic as the default", () => {
    const task = getTaskTool({
      execute: vi.fn<TaskExecutor["execute"]>(),
    });

    expect(task.parametersJsonSchema.required).toEqual(["prompt"]);
    expect(task.parametersJsonSchema.properties).toMatchObject({
      description: { type: "string" },
      name: { type: "string" },
      prompt: { type: "string" },
      role: {
        default: "generic",
        enum: ["generic", "explore", "research"],
        type: "string",
      },
      resume_session_id: { type: "string" },
    });
    expect(JSON.stringify(task.parametersJsonSchema)).not.toContain(
      "agent_name",
    );
  });

  it("defaults omitted role to generic", async () => {
    const execute = vi.fn<TaskExecutor["execute"]>(() =>
      Promise.resolve({
        description: "AI Events Researcher",
        name: "events-scout",
        output: "subagent output",
        role: "generic",
        sessionId: "child_1",
        success: true,
        summary: { duration: 5, steps: 1, toolCalls: [] },
      }),
    );
    const task = getTaskTool({ execute });

    await task.execute(
      {
        description: "AI Events Researcher",
        name: "events-scout",
        prompt: "Find events.",
      },
      {
        callId: "call_1",
        messageId: "message_1",
        sessionId: "parent_1",
        signal: new AbortController().signal,
      },
    );

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "AI Events Researcher",
        name: "events-scout",
        prompt: "Find events.",
        role: "generic",
      }),
    );
  });

  it("rejects stale agent_name input instead of defaulting to generic", async () => {
    const execute = vi.fn<TaskExecutor["execute"]>();
    const task = getTaskTool({ execute });

    await expect(
      task.execute(
        {
          agent_name: "research",
          prompt: "Find events.",
        },
        {
          callId: "call_1",
          messageId: "message_1",
          sessionId: "parent_1",
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow(/agent_name.*no longer supported.*Use role/s);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects missing task parameters", async () => {
    const task = getTaskTool({
      execute: vi.fn<TaskExecutor["execute"]>(),
    });

    await expect(
      task.execute(
        { role: "explore" },
        {
          callId: "call_1",
          messageId: "message_1",
          sessionId: "parent_1",
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow('Expected parameter "prompt" to be a non-empty string.');
  });

  it("rejects invalid role values with recoverable guidance", async () => {
    const task = getTaskTool({
      execute: vi.fn<TaskExecutor["execute"]>(),
    });

    for (const role of ["AI Events Researcher", "plan", "build"]) {
      await expect(
        task.execute(
          { prompt: "Find events.", role },
          {
            callId: "call_1",
            messageId: "message_1",
            sessionId: "parent_1",
            signal: new AbortController().signal,
          },
        ),
      ).rejects.toThrow(
        /Allowed roles are: generic, explore, research.*Omit role to use generic.*Use description.*Use name.*build and plan are primary agents/s,
      );
    }
  });
});
