import { describe, expect, it, vi } from "vitest";
import type { AgentTaskController, AgentTaskRecord } from "../agents/index.js";
import type { Tool } from "../core/tool-scheduler/index.js";
import { createBuiltinTools } from "./index.js";

const record: AgentTaskRecord = {
  agentName: "explore",
  createdAt: 1,
  parentSessionId: "parent",
  pendingInputCount: 0,
  prompt: "Find files",
  sessionId: "child",
  status: "running",
  taskId: "task_1",
  updatedAt: 2,
};

function createController() {
  const close = vi.fn<AgentTaskController["close"]>(() =>
    Promise.resolve({
      previousStatus: "running" as const,
      task: { ...record, status: "cancelled" as const },
    }),
  );
  const get = vi.fn<AgentTaskController["get"]>(() =>
    Promise.resolve({ ...record, output: "done" }),
  );
  const open = vi.fn<AgentTaskController["open"]>(() =>
    Promise.resolve(record),
  );
  const sendInput = vi.fn<AgentTaskController["sendInput"]>(() =>
    Promise.resolve({ ...record, pendingInputCount: 1 }),
  );
  const controller: AgentTaskController = {
    close,
    get,
    open,
    sendInput,
  };
  return { close, controller, get, open, sendInput };
}

function getTool(tools: readonly Tool[], name: string): Tool {
  const tool = tools.find((item) => item.name === name);
  if (!tool) {
    throw new Error(`missing tool: ${name}`);
  }
  return tool;
}

const context = {
  callId: "call",
  messageId: "message",
  sessionId: "parent",
  signal: new AbortController().signal,
};

describe("agent task builtin tools", () => {
  it("registers grouped agent task control tools when a controller is injected", () => {
    const { controller } = createController();
    const names = createBuiltinTools({ agentTaskController: controller })
      .map((tool) => tool.name)
      .filter((name) => name.startsWith("agent_"));

    expect(names).toEqual([
      "agent_open",
      "agent_eval",
      "agent_status",
      "agent_close",
    ]);
  });

  it("opens a background agent task through the controller", async () => {
    const { controller, open } = createController();
    const tool = getTool(
      createBuiltinTools({ agentTaskController: controller }),
      "agent_open",
    );

    const result = await tool.execute(
      {
        agent_name: "explore",
        description: "Explore files",
        prompt: "Find files",
      },
      context,
    );

    expect(result.output).toContain("task_id: task_1");
    expect(result.metadata?.agentTask).toMatchObject({ taskId: "task_1" });
    expect(open).toHaveBeenCalledWith({
      agentName: "explore",
      description: "Explore files",
      environment: undefined,
      parentSessionId: "parent",
      prompt: "Find files",
      signal: context.signal,
    });
  });

  it("sends follow-up input, status, and close commands through the controller", async () => {
    const { close, controller, get, sendInput } = createController();
    const tools = createBuiltinTools({ agentTaskController: controller });

    await getTool(tools, "agent_eval").execute(
      { interrupt: true, prompt: "continue", task_id: "task_1" },
      context,
    );
    await getTool(tools, "agent_close").execute(
      { task_id: "task_1" },
      context,
    );
    await getTool(tools, "agent_status").execute(
      { task_id: "task_1" },
      context,
    );

    expect(sendInput).toHaveBeenCalledWith({
      environment: undefined,
      interrupt: true,
      parentSessionId: "parent",
      prompt: "continue",
      taskId: "task_1",
    });
    expect(close).toHaveBeenCalledWith({
      parentSessionId: "parent",
      taskId: "task_1",
    });
    expect(get).toHaveBeenCalledWith({
      parentSessionId: "parent",
      taskId: "task_1",
    });
  });

  it("rejects invalid parameters", async () => {
    const tool = getTool(
      createBuiltinTools({ agentTaskController: createController().controller }),
      "agent_eval",
    );

    await expect(
      tool.execute({ prompt: "continue" }, context),
    ).rejects.toThrow('Expected parameter "task_id" to be a non-empty string.');
  });
});
