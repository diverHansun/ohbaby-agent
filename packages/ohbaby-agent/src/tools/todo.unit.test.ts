import { describe, expect, it } from "vitest";
import type { ToolExecutionContext } from "../core/tool-scheduler/index.js";
import { createBuiltinTools } from "./index.js";

function createContext(sessionId: string): ToolExecutionContext {
  return {
    callId: "call_1",
    messageId: "message_1",
    sessionId,
    signal: new AbortController().signal,
  };
}

function createToolRunner(): (
  name: string,
  params: Record<string, unknown>,
  context?: ToolExecutionContext,
) => ReturnType<ReturnType<typeof createBuiltinTools>[number]["execute"]> {
  const tools = createBuiltinTools();
  return async function runTool(
    name: string,
    params: Record<string, unknown>,
    context = createContext("session_1"),
  ) {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) {
      throw new Error(`Tool not found in test: ${name}`);
    }

    return tool.execute(params, context);
  };
}

describe("todo builtin tools", () => {
  it("writes and reads todos scoped by session", async () => {
    const runTool = createToolRunner();

    const write = await runTool("todo_write", {
      todos: [
        {
          content: "Wire file tools",
          id: "todo_1",
          priority: "high",
          status: "in_progress",
        },
        {
          content: "Review bash tool",
          id: "todo_2",
          priority: "medium",
          status: "pending",
        },
      ],
    });
    const sameSession = await runTool("todo_read", {});
    const otherSession = await runTool(
      "todo_read",
      {},
      createContext("session_2"),
    );

    expect(write.output).toContain(
      "[in_progress] (high) todo_1: Wire file tools",
    );
    expect(sameSession.output).toContain(
      "[pending] (medium) todo_2: Review bash tool",
    );
    expect(sameSession.metadata).toMatchObject({ count: 2 });
    expect(otherSession.output).toBe("No todos.");
    expect(otherSession.metadata).toMatchObject({ count: 0 });
  });

  it("rejects invalid todo payloads", async () => {
    const runTool = createToolRunner();

    await expect(
      runTool("todo_write", {
        todos: [{ content: "bad", id: "todo_1", status: "started" }],
      }),
    ).rejects.toThrow("Invalid todo status");
  });

  it("does not expose mutable session state through metadata", async () => {
    const runTool = createToolRunner();
    await runTool("todo_write", {
      todos: [
        {
          content: "Original",
          id: "todo_1",
          status: "pending",
        },
      ],
    });

    const read = await runTool("todo_read", {});
    const exposedTodos = read.metadata?.todos as {
      content: string;
      id: string;
      status: string;
    }[];
    exposedTodos[0] = { content: "Mutated", id: "todo_1", status: "completed" };
    const reread = await runTool("todo_read", {});

    expect(reread.output).toContain("Original");
    expect(reread.output).not.toContain("Mutated");
  });
});
