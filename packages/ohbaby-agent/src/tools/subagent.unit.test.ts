import { describe, expect, it, vi } from "vitest";
import type {
  SessionSubagentHost,
  SubagentInstanceRecord,
} from "../agents/index.js";
import type { Tool } from "../core/tool-scheduler/index.js";
import { createBuiltinTools } from "./index.js";

const item: SubagentInstanceRecord = {
  contextScopeId: "subagent_1",
  createdAt: 1,
  initialPrompt: "inspect",
  parentSessionId: "parent_1",
  pendingQueue: [],
  role: "explore",
  sessionId: "child_1",
  status: "completed",
  subagentId: "subagent_1",
  updatedAt: 2,
  output: "done",
};

function createHost(): {
  readonly close: ReturnType<typeof vi.fn>;
  readonly host: Pick<SessionSubagentHost, "close" | "run" | "status">;
  readonly run: ReturnType<typeof vi.fn>;
  readonly status: ReturnType<typeof vi.fn>;
} {
  const run = vi.fn<SessionSubagentHost["run"]>(() =>
    Promise.resolve({ item, output: "done", success: true }),
  );
  const status = vi.fn<SessionSubagentHost["status"]>(() =>
    Promise.resolve({ items: [item] }),
  );
  const close = vi.fn<SessionSubagentHost["close"]>(() =>
    Promise.resolve({
      item: { ...item, status: "cancelled" },
      previousStatus: "completed",
    }),
  );
  return { close, host: { close, run, status }, run, status };
}

function getTool(tools: readonly Tool[], name: string): Tool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`missing tool: ${name}`);
  }
  return tool;
}

const context = {
  callId: "call_1",
  messageId: "message_1",
  sessionId: "parent_1",
  signal: new AbortController().signal,
};

describe("subagent builtin tools", () => {
  it("registers only the new subagent tools when a subagent host is injected", () => {
    const { host } = createHost();
    const names = createBuiltinTools({ subagentHost: host }).map(
      (tool) => tool.name,
    );

    expect(names).toEqual(
      expect.arrayContaining([
        "subagent_run",
        "subagent_status",
        "subagent_close",
      ]),
    );
    expect(names).not.toEqual(
      expect.arrayContaining(["task", "agent_open", "agent_eval"]),
    );
    expect(
      createBuiltinTools({ subagentHost: host }).find(
        (tool) => tool.name === "subagent_run",
      )?.timeoutOwner,
    ).toBe("tool");
    expect(
      getTool(createBuiltinTools({ subagentHost: host }), "subagent_status")
        .category,
    ).toBe("subagent-control");
    expect(
      getTool(createBuiltinTools({ subagentHost: host }), "subagent_close")
        .category,
    ).toBe("subagent-control");
  });

  it("runs, lists status items, and closes through SessionSubagentHost", async () => {
    const { close, host, run, status } = createHost();
    const tools = createBuiltinTools({ subagentHost: host });

    const runResult = await getTool(tools, "subagent_run").execute(
      {
        mode: "foreground",
        prompt: "inspect",
        role: "explore",
      },
      context,
    );
    const statusResult = await getTool(tools, "subagent_status").execute(
      {},
      context,
    );
    await getTool(tools, "subagent_close").execute(
      { subagent_id: "subagent_1" },
      context,
    );

    expect(run).toHaveBeenCalledWith({
      description: undefined,
      environment: undefined,
      interrupt: undefined,
      mode: "foreground",
      name: undefined,
      parentSessionId: "parent_1",
      prompt: "inspect",
      role: "explore",
      signal: context.signal,
      subagentId: undefined,
    });
    expect(status).toHaveBeenCalledWith({
      parentSessionId: "parent_1",
      subagentId: undefined,
    });
    expect(close).toHaveBeenCalledWith({
      parentSessionId: "parent_1",
      subagentId: "subagent_1",
    });
    expect(runResult.metadata?.subagent).toMatchObject({
      item: { subagentId: "subagent_1" },
    });
    expect(statusResult.metadata?.subagentStatus).toEqual({ items: [item] });
  });

  it("passes timeout_ms through subagent_run when provided", async () => {
    const { host, run } = createHost();
    const tools = createBuiltinTools({ subagentHost: host });

    await getTool(tools, "subagent_run").execute(
      {
        mode: "foreground",
        prompt: "inspect",
        role: "explore",
        timeout_ms: 1_000,
      },
      context,
    );

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 1_000,
      }),
    );
  });

  it("shows a separate program note for a completed subagent with no final body", async () => {
    const { host, run, status } = createHost();
    const emptyItem = { ...item, output: "" };
    run.mockResolvedValueOnce({ item: emptyItem, output: "", success: true });
    status.mockResolvedValueOnce({ items: [emptyItem] });
    const tools = createBuiltinTools({ subagentHost: host });

    const runResult = await getTool(tools, "subagent_run").execute(
      { prompt: "inspect" },
      context,
    );
    const statusResult = await getTool(tools, "subagent_status").execute(
      {},
      context,
    );

    expect(runResult.output).toContain("program_note: No output.");
    expect(statusResult.output).toContain("program_note: No output.");
    expect(runResult.output).not.toContain("<subagent_output>");
    expect(statusResult.output).not.toContain("<subagent_output>");
    expect(runResult.metadata?.subagent).toMatchObject({ output: "" });
  });

  it("does not show an empty-output note while running or after failure", async () => {
    const { host, run, status } = createHost();
    run.mockResolvedValueOnce({
      item: { ...item, output: "", status: "running" },
      output: "",
      success: true,
    });
    status.mockResolvedValueOnce({
      items: [{ ...item, output: "", status: "failed", error: "timeout" }],
    });
    const tools = createBuiltinTools({ subagentHost: host });

    const runResult = await getTool(tools, "subagent_run").execute(
      { prompt: "inspect", mode: "background" },
      context,
    );
    const statusResult = await getTool(tools, "subagent_status").execute(
      {},
      context,
    );

    expect(runResult.output).not.toContain("program_note");
    expect(statusResult.output).not.toContain("program_note");
  });

  it("does not present the previous result while a queued continuation is pending", async () => {
    const { host, run, status } = createHost();
    const pendingItem = {
      ...item,
      output: "",
      pendingQueue: [{ prompt: "continue" }],
    };
    run.mockResolvedValueOnce({ item: pendingItem });
    status.mockResolvedValueOnce({ items: [pendingItem] });
    const tools = createBuiltinTools({ subagentHost: host });

    const runResult = await getTool(tools, "subagent_run").execute(
      { prompt: "continue", mode: "background", subagent_id: "subagent_1" },
      context,
    );
    const statusResult = await getTool(tools, "subagent_status").execute(
      {},
      context,
    );

    expect(runResult.output).not.toContain("program_note");
    expect(statusResult.output).not.toContain("program_note");
    expect(statusResult.output).not.toContain("<subagent_output>");
  });

  it("does not present a previous interrupted run's error as a queued continuation's result", async () => {
    const { host, run } = createHost();
    const pendingItem = {
      ...item,
      status: "interrupted" as const,
      output: "previous run interrupted",
      error: "previous run interrupted",
      pendingQueue: [{ prompt: "continue" }],
    };
    run.mockResolvedValueOnce({ item: pendingItem });
    const tools = createBuiltinTools({ subagentHost: host });

    const result = await getTool(tools, "subagent_run").execute(
      { prompt: "continue", mode: "background", subagent_id: "subagent_1" },
      context,
    );

    expect(result.output).toContain("status: queued");
    expect(result.output).toContain("pending_inputs: 1");
    expect(result.output).not.toContain("<subagent_error>");
    expect(result.output).not.toContain("previous run interrupted");
  });

  it("shows an immediately completed background result", async () => {
    const { host, run } = createHost();
    run.mockResolvedValueOnce({ item: { ...item, output: "" } });
    const tools = createBuiltinTools({ subagentHost: host });

    const result = await getTool(tools, "subagent_run").execute(
      { prompt: "inspect", mode: "background" },
      context,
    );

    expect(result.output).toContain("program_note: No output.");
    expect(result.output).not.toContain("<subagent_output>");
  });

  it("renders a failed run's reason as an error rather than a completed report", async () => {
    const { host, run, status } = createHost();
    const failedItem = {
      ...item,
      status: "failed" as const,
      output: "provider disconnected",
      error: "provider disconnected",
    };
    run.mockResolvedValueOnce({
      item: failedItem,
      output: "provider disconnected",
      success: false,
    });
    status.mockResolvedValueOnce({ items: [failedItem] });
    const tools = createBuiltinTools({ subagentHost: host });

    const runResult = await getTool(tools, "subagent_run").execute(
      { prompt: "inspect" },
      context,
    );
    const statusResult = await getTool(tools, "subagent_status").execute(
      {},
      context,
    );

    expect(runResult.output).toContain(
      "<subagent_error>\nprovider disconnected\n</subagent_error>",
    );
    expect(statusResult.output).toContain(
      "<subagent_error>\nprovider disconnected\n</subagent_error>",
    );
    expect(runResult.output).not.toContain("<subagent_output>");
    expect(statusResult.output).not.toContain("<subagent_output>");
  });

  it("renders durable in-flight and queued state for interrupted subagents", async () => {
    const { host, status } = createHost();
    status.mockResolvedValueOnce({
      items: [
        {
          ...item,
          currentInput: { prompt: "in-flight prompt" },
          lastRunId: "run_1",
          output: undefined,
          pendingQueue: [{ prompt: "queued prompt" }],
          status: "interrupted",
        },
      ],
    });
    const result = await getTool(
      createBuiltinTools({ subagentHost: host }),
      "subagent_status",
    ).execute({}, context);

    expect(result.output).toContain("last_run_id: run_1");
    expect(result.output).toContain("pending_inputs: 1");
    expect(result.output).toContain("in-flight prompt");
  });
});
