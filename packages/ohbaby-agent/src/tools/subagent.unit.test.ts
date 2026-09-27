import { describe, expect, it, vi } from "vitest";
import type {
  SessionSubagentHost,
  SubagentInstanceRecord,
  SubagentExecutionRecord,
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

const execution: SubagentExecutionRecord = {
  executionId: "execution_1",
  requestId: "call_1",
  parentSessionId: "parent_1",
  requesterScopeId: "primary",
  requesterRunId: "run_1",
  rootSessionId: "parent_1",
  rootRunId: "run_1",
  subagentId: "subagent_1",
  mode: "foreground",
  prompt: "inspect",
  status: "completed",
  output: "done",
  createdAt: 1,
  completedAt: 2,
  updatedAt: 2,
  artifact: { state: "none" },
  delivery: { state: "foreground" },
};

function createHost(): {
  readonly close: ReturnType<typeof vi.fn>;
  readonly host: Pick<SessionSubagentHost, "close" | "run" | "status">;
  readonly run: ReturnType<typeof vi.fn>;
  readonly status: ReturnType<typeof vi.fn>;
} {
  const run = vi.fn<SessionSubagentHost["run"]>(() =>
    Promise.resolve({ execution, item, output: "done", success: true }),
  );
  const status = vi.fn<SessionSubagentHost["status"]>(() =>
    Promise.resolve({ items: [item], executions: [execution] }),
  );
  const close = vi.fn<SessionSubagentHost["close"]>(() =>
    Promise.resolve({
      subagentId: item.subagentId,
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
  runId: "run_1",
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
      requesterRunId: "run_1",
      requesterMessageId: "message_1",
      requestId: "call_1",
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
      executionId: undefined,
      parentContextScopeId: undefined,
      parentSessionId: "parent_1",
      subagentId: undefined,
    });
    expect(close).toHaveBeenCalledWith({
      parentSessionId: "parent_1",
      subagentId: "subagent_1",
    });
    expect(runResult.metadata?.subagent).toMatchObject({
      execution: { subagentId: "subagent_1", executionId: "execution_1" },
    });
    expect(JSON.stringify(statusResult.metadata)).not.toContain(
      "initialPrompt",
    );
    expect(statusResult.output).not.toContain("<subagent_output>");
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
    run.mockResolvedValueOnce({
      execution: { ...execution, output: "" },
      item: emptyItem,
      output: "",
      success: true,
    });
    status.mockResolvedValueOnce({
      items: [emptyItem],
      executions: [{ ...execution, output: "" }],
    });
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
    expect(statusResult.output).toContain("sizeBytes");
    expect(runResult.output).not.toContain("<subagent_output>");
    expect(statusResult.output).not.toContain("<subagent_output>");
    expect(runResult.metadata?.subagent).toMatchObject({
      execution: { sizeBytes: 0 },
    });
  });

  it("does not show an empty-output note while running or after failure", async () => {
    const { host, run, status } = createHost();
    run.mockResolvedValueOnce({
      execution: { ...execution, mode: "background", status: "running" },
      item: { ...item, output: "", status: "running" },
      output: "",
      success: true,
    });
    status.mockResolvedValueOnce({
      executions: [],
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
    run.mockResolvedValueOnce({
      execution: {
        ...execution,
        mode: "background",
        status: "queued",
        output: undefined,
      },
      item: pendingItem,
    });
    status.mockResolvedValueOnce({
      executions: [],
      items: [pendingItem],
    });
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
    run.mockResolvedValueOnce({
      execution: {
        ...execution,
        mode: "background",
        status: "queued",
        output: undefined,
      },
      item: pendingItem,
    });
    const tools = createBuiltinTools({ subagentHost: host });

    const result = await getTool(tools, "subagent_run").execute(
      { prompt: "continue", mode: "background", subagent_id: "subagent_1" },
      context,
    );

    expect(result.output).toContain("status: queued");
    expect(result.output).toContain("accepted: true");
    expect(result.output).not.toContain("<subagent_error>");
    expect(result.output).not.toContain("previous run interrupted");
  });

  it("does not expose an immediately completed background result", async () => {
    const { host, run } = createHost();
    run.mockResolvedValueOnce({
      execution: { ...execution, mode: "background" },
      item: { ...item, output: "secret fast report" },
    });
    const tools = createBuiltinTools({ subagentHost: host });

    const result = await getTool(tools, "subagent_run").execute(
      { prompt: "inspect", mode: "background" },
      context,
    );

    expect(result.output).toContain("accepted: true");
    expect(result.output).not.toContain("secret fast report");
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
      execution: {
        ...execution,
        status: "failed",
        output: undefined,
        error: "provider disconnected",
      },
      item: failedItem,
      output: "provider disconnected",
      success: false,
    });
    status.mockResolvedValueOnce({
      executions: [],
      items: [failedItem],
    });
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
    expect(statusResult.output).not.toContain("provider disconnected");
    expect(runResult.output).not.toContain("<subagent_output>");
    expect(statusResult.output).not.toContain("<subagent_output>");
  });

  it("renders durable in-flight and queued state for interrupted subagents", async () => {
    const { host, status } = createHost();
    status.mockResolvedValueOnce({
      executions: [],
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

    expect(result.output).toContain('"lastRunId":"run_1"');
    expect(result.output).toContain('"pendingInputs":1');
    expect(result.output).not.toContain("in-flight prompt");
    expect(JSON.stringify(result.metadata)).not.toContain("queued prompt");
  });
});
