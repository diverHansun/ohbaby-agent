import { describe, expect, it, vi } from "vitest";
import type { AgentTaskController, AgentTaskRecord } from "../agents/index.js";
import type { Tool } from "../core/tool-scheduler/index.js";
import { createBuiltinTools } from "./index.js";

const record: AgentTaskRecord = {
  createdAt: 1,
  description: "Explore files",
  name: "files-scout",
  parentSessionId: "parent",
  pendingInputCount: 0,
  prompt: "Find files",
  role: "explore",
  sessionId: "child",
  status: "running",
  taskId: "task_1",
  updatedAt: 2,
};

function createController(): {
  readonly close: ReturnType<typeof vi.fn>;
  readonly controller: AgentTaskController;
  readonly get: ReturnType<typeof vi.fn>;
  readonly open: ReturnType<typeof vi.fn>;
  readonly sendInput: ReturnType<typeof vi.fn>;
} {
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
        description: "Explore files",
        name: "files-scout",
        prompt: "Find files",
        role: "explore",
      },
      context,
    );

    expect(result.output).toContain("task_id: task_1");
    expect(result.metadata?.agentTask).toMatchObject({ taskId: "task_1" });
    expect(open).toHaveBeenCalledWith({
      description: "Explore files",
      environment: undefined,
      name: "files-scout",
      parentSessionId: "parent",
      prompt: "Find files",
      role: "explore",
      signal: context.signal,
    });
  });

  it("exposes role metadata schema with generic as the default", () => {
    const { controller } = createController();
    const tool = getTool(
      createBuiltinTools({ agentTaskController: controller }),
      "agent_open",
    );

    expect(tool.parametersJsonSchema.required).toEqual(["prompt"]);
    expect(tool.parametersJsonSchema.properties).toMatchObject({
      description: { type: "string" },
      name: { type: "string" },
      prompt: { type: "string" },
      role: {
        default: "generic",
        enum: ["generic", "explore", "research"],
        type: "string",
      },
    });
    expect(JSON.stringify(tool.parametersJsonSchema)).not.toContain(
      "agent_name",
    );
  });

  it("defaults omitted open role to generic", async () => {
    const { controller, open } = createController();
    const tool = getTool(
      createBuiltinTools({ agentTaskController: controller }),
      "agent_open",
    );

    await tool.execute(
      {
        description: "AI Events Researcher",
        name: "events-scout",
        prompt: "Find events.",
      },
      context,
    );

    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "AI Events Researcher",
        name: "events-scout",
        prompt: "Find events.",
        role: "generic",
      }),
    );
  });

  it("rejects stale open agent_name input instead of defaulting to generic", async () => {
    const { controller, open } = createController();
    const tool = getTool(
      createBuiltinTools({ agentTaskController: controller }),
      "agent_open",
    );

    await expect(
      tool.execute(
        {
          agent_name: "research",
          prompt: "Find events.",
        },
        context,
      ),
    ).rejects.toThrow(/agent_name.*no longer supported.*Use role/s);
    expect(open).not.toHaveBeenCalled();
  });

  it("rejects invalid open role values with recoverable guidance", async () => {
    const { controller } = createController();
    const tool = getTool(
      createBuiltinTools({ agentTaskController: controller }),
      "agent_open",
    );

    for (const role of ["AI Events Researcher", "plan", "build"]) {
      await expect(
        tool.execute({ prompt: "Find events.", role }, context),
      ).rejects.toThrow(
        /Allowed roles are: generic, explore, research.*Omit role to use generic.*Use description.*Use name.*build and plan are primary agents/s,
      );
    }
  });

  it("sends follow-up input, status, and close commands through the controller", async () => {
    const { close, controller, get, sendInput } = createController();
    const tools = createBuiltinTools({ agentTaskController: controller });

    await getTool(tools, "agent_eval").execute(
      { interrupt: true, prompt: "continue", task_id: "task_1" },
      context,
    );
    await getTool(tools, "agent_close").execute({ task_id: "task_1" }, context);
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
      createBuiltinTools({
        agentTaskController: createController().controller,
      }),
      "agent_eval",
    );

    await expect(tool.execute({ prompt: "continue" }, context)).rejects.toThrow(
      'Expected parameter "task_id" to be a non-empty string.',
    );
  });
});
