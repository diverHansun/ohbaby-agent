import { describe, expect, it, vi, type Mock } from "vitest";
import type {
  SubagentInstanceRecord,
  SubagentExecutionRecord,
} from "../agents/index.js";
import { createBuiltinTools } from "./index.js";
import { createBus } from "../bus/index.js";
import { createPermissionState } from "../permission/index.js";
import { createToolScheduler } from "../core/tool-scheduler/scheduler.js";
import type { Tool } from "../core/tool-scheduler/index.js";
import { SessionSubagentHost } from "../agents/subagent-host.js";
import { InMemorySubagentInstanceStore } from "../agents/subagents/in-memory-store.js";
import { InMemorySubagentExecutionStore } from "../agents/subagents/execution-store.js";
import { createExecutionMessageChannel } from "../agents/subagents/execution-message-channel.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../core/message/index.js";
import { createInMemoryRunLedger } from "../runtime/run-ledger/index.js";
import { InMemoryCurrentRunInputStore } from "../runtime/prompt-scheduler/current-run-inputs.js";
import { InMemoryPromptSubmissionStore } from "../runtime/prompt-scheduler/in-memory-store.js";
import { testRunModel } from "../core/testing/model-fixtures.js";
import type { Session } from "../services/session/index.js";
import type { AgentInstance, AgentRunResult } from "../core/agents/index.js";
import type { RuntimeAgent } from "../agents/types.js";
import type { SubagentToolHost } from "./subagent.js";

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
  [K in keyof SubagentToolHost]: Mock<SubagentToolHost[K]>;
} {
  const started = {
    started: true,
    execution,
    item,
    output: "done",
    success: true,
  };
  const host = {
    spawn: vi.fn<SubagentToolHost["spawn"]>(() => Promise.resolve(started)),
    send: vi.fn<SubagentToolHost["send"]>(() => Promise.resolve(started)),
    list: vi.fn<SubagentToolHost["list"]>(() =>
      Promise.resolve({
        items: [item],
        executions: [execution],
      }),
    ),
    monitor: vi.fn<SubagentToolHost["monitor"]>(() =>
      Promise.resolve({
        targets: [],
        truncated: false,
      }),
    ),
    stop: vi.fn<SubagentToolHost["stop"]>(() =>
      Promise.resolve({
        subagentId: item.subagentId,
        stopped: false,
        cleanup: "confirmed" as const,
        unprocessedMessages: [],
      }),
    ),
    close: vi.fn<SubagentToolHost["close"]>(() =>
      Promise.resolve({
        subagentId: item.subagentId,
        item: { ...item, status: "cancelled" as const },
        previousStatus: "completed" as const,
        cleanup: "confirmed" as const,
        unprocessedMessages: [],
      }),
    ),
  };
  return host;
}
function tool(host: SubagentToolHost = createHost()): Tool {
  const agent = createBuiltinTools({
    subagentHost: host,
  }).find((candidate) => candidate.name === "agent");
  if (!agent) throw new Error("missing tool: agent");
  return agent;
}
const context = {
  runId: "run_1",
  callId: "call_1",
  messageId: "message_1",
  sessionId: "parent_1",
  signal: new AbortController().signal,
};

describe("agent builtin tool", () => {
  it("registers one plain object schema with six actions and a background default", () => {
    const host = createHost();
    const names = createBuiltinTools({
      subagentHost: host,
    }).map((entry) => entry.name);
    expect(names).toContain("agent");
    for (const old of ["subagent_run", "subagent_status", "subagent_close"])
      expect(names).not.toContain(old);
    expect(tool(host).parametersJsonSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { enum: ["spawn", "send", "list", "monitor", "stop", "close"] },
        mode: { default: "background" },
      },
    });
    expect(tool(host).annotations?.readOnlyHint).not.toBe(true);
  });
  it("defaults spawn to background and returns the durable execution identity", async () => {
    const host = createHost();
    host.spawn.mockResolvedValueOnce({
      started: true,
      execution: { ...execution, mode: "background", status: "running" },
      item,
      output: "secret fast result",
      success: true,
    });
    const result = await tool(host).execute(
      { action: "spawn", prompt: "inspect", name: "Audit" },
      context,
    );
    expect(host.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "background",
        prompt: "inspect",
        requesterRunId: "run_1",
        parentSessionId: "parent_1",
      }),
    );
    expect(result.output).toContain("agent_id: subagent_1");
    expect(result.output).toContain("execution_id: execution_1");
    expect(result.output).toContain("started: true");
    expect(result.output).toContain("mode: background");
    expect(result.output).toContain("do not edit");
    expect(result.output).not.toContain("secret fast result");
    expect(result.metadata?.subagent).toMatchObject({
      started: true,
      execution: { executionId: "execution_1" },
    });
  });
  it("returns a direct foreground result or an explicit empty result note", async () => {
    const host = createHost();
    expect(
      (
        await tool(host).execute(
          { action: "spawn", prompt: "inspect", mode: "foreground" },
          context,
        )
      ).output,
    ).toContain("<subagent_output>\ndone\n</subagent_output>");
    host.spawn.mockResolvedValueOnce({
      started: true,
      execution: { ...execution, output: "" },
      item,
      output: "",
      success: true,
    });
    expect(
      (
        await tool(host).execute(
          { action: "spawn", prompt: "inspect", mode: "foreground" },
          context,
        )
      ).output,
    ).toContain("program_note: No output.");
  });
  it("reports capacity refusal without a fictitious execution", async () => {
    const host = createHost();
    host.spawn.mockResolvedValueOnce({
      started: false,
      reason: "All six execution slots are in use.",
    });
    const result = await tool(host).execute(
      { action: "spawn", prompt: "inspect" },
      context,
    );
    expect(result.output).toContain("started: false");
    expect(result.output).toContain("All six");
    expect(result.output).not.toContain("execution_id");
    expect(result.metadata?.subagent).not.toHaveProperty("execution");
  });
  it("routes send to an existing instance and keeps actual running mode without a delegation receipt", async () => {
    const host = createHost();
    host.send.mockResolvedValueOnce({
      started: false,
      accepted: true,
      inputId: "input_1",
      execution,
      item,
    });
    const result = await tool(host).execute(
      { action: "send", agent_id: "subagent_1", message: "check errors" },
      context,
    );
    expect(host.send).toHaveBeenCalledWith(
      expect.objectContaining({
        subagentId: "subagent_1",
        prompt: "check errors",
        mode: "background",
      }),
    );
    expect(result.output).toContain("mode: foreground");
    expect(result.output).toContain("accepted: true");
    expect(result.output).toContain("input_id: input_1");
    expect(result.metadata?.subagent).not.toHaveProperty("execution");
    expect(result.output).not.toContain("<subagent_output>");
  });
  it("preserves execution metadata when send starts a new execution", async () => {
    const host = createHost();
    const result = await tool(host).execute(
      {
        action: "send",
        agent_id: "subagent_1",
        message: "continue",
        mode: "foreground",
      },
      context,
    );
    expect(result.metadata?.subagent).toMatchObject({
      started: true,
      execution: { executionId: "execution_1" },
    });
  });
  it("includes file ownership guidance when send starts a background execution", async () => {
    const host = createHost();
    host.send.mockResolvedValueOnce({
      started: true,
      execution: { ...execution, mode: "background", status: "running" },
    });
    const result = await tool(host).execute(
      { action: "send", agent_id: "subagent_1", message: "continue" },
      context,
    );
    expect(result.output).toContain(
      "do not edit the files assigned to it concurrently",
    );
  });
  it("lists within the caller session and passes independent monitor cursors", async () => {
    const host = createHost();
    const agent = tool(host);
    const listed = await agent.execute({ action: "list" }, context);
    expect(listed.output).toContain("subagent_1");
    expect(host.list).toHaveBeenCalledWith({
      parentSessionId: "parent_1",
      parentContextScopeId: undefined,
    });
    await agent.execute(
      { action: "monitor", agent_ids: ["a", "b"], cursors: { a: "cursor-a" } },
      context,
    );
    expect(host.monitor).toHaveBeenCalledWith({
      parentSessionId: "parent_1",
      parentContextScopeId: undefined,
      subagentIds: ["a", "b"],
      cursors: { a: "cursor-a" },
    });
  });
  it("returns stop and close cleanup facts without discarding unprocessed messages", async () => {
    const host = createHost();
    host.stop.mockResolvedValueOnce({
      subagentId: item.subagentId,
      stopped: true,
      cleanup: "unconfirmed",
      unprocessedMessages: [
        { inputId: "input_2", text: "not consumed", reason: "stopped" },
      ],
    });
    const result = await tool(host).execute(
      { action: "stop", agent_id: "subagent_1" },
      context,
    );
    expect(result.output).toContain("unconfirmed");
    expect(result.output).toContain("not consumed");
    const closed = await tool(host).execute(
      { action: "close", agent_id: "subagent_1" },
      context,
    );
    expect(closed.output).toContain("confirmed");
    expect(host.close).toHaveBeenCalledWith({
      parentSessionId: "parent_1",
      subagentId: "subagent_1",
    });
  });
  it.each([
    {},
    { action: "wait" },
    { action: "spawn" },
    { action: "spawn", prompt: " " },
    { action: "spawn", prompt: "ok", agent_id: "existing" },
    { action: "spawn", prompt: "ok", interrupt: true },
    { action: "spawn", prompt: "ok", mode: "queued" },
    { action: "spawn", prompt: "ok", timeout_ms: 1800001 },
    { action: "spawn", prompt: "ok", role: "build" },
    { action: "send", agent_id: "a", prompt: "wrong" },
    { action: "send", agent_id: "a", message: "ok", name: "new" },
    { action: "send", agent_id: "a", message: "ok", timeout_ms: 1 },
    { action: "list", agent_id: "a" },
    { action: "monitor", agent_ids: [] },
    { action: "monitor", agent_ids: [" "] },
    { action: "monitor", agent_ids: "a" },
    { action: "monitor", agent_ids: ["a"], cursors: { b: "cursor" } },
    { action: "monitor", agent_ids: ["a"], cursors: { a: 1 } },
    { action: "stop", agent_id: " " },
    { action: "close", agent_id: "a", mode: "background" },
  ])(
    "rejects invalid action parameters before calling the host: %j",
    async (params) => {
      const host = createHost();
      await expect(tool(host).execute(params, context)).rejects.toThrow();
      for (const method of Object.values(host))
        expect(method).not.toHaveBeenCalled();
    },
  );
  it("delivers running messages and rejects the seventh execution immediately while six foreground calls remain open", async () => {
    const bus = createBus();
    const executions = new InMemorySubagentExecutionStore();
    const messages = createMessageManager({
      bus,
      store: createInMemoryMessageStore(),
    });
    const ledger = createInMemoryRunLedger();
    const inputs = new InMemoryCurrentRunInputStore({
      runLedger: ledger,
      promptStore: new InMemoryPromptSubmissionStore(),
      messageManager: messages,
    });
    const channel = createExecutionMessageChannel({
      executions,
      messages,
      inputs,
      runLedger: ledger,
    });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const turn = vi.fn<AgentInstance["turn"]>(
      async (input): Promise<AgentRunResult> => {
        if (!input.runId) throw new Error("Expected child run identity");
        const execution = (await executions.listByRootRun("root")).find(
          (record) => record.childRunId === input.runId,
        );
        if (!execution?.childScopeId)
          throw new Error("Expected bound child scope");
        await ledger.createPending({
          runId: input.runId,
          sessionId: "child",
          contextScopeId: execution.childScopeId,
          triggerSource: "user",
        });
        await ledger.markRunning(input.runId);
        await input.onInputReady?.();
        await gate;
        return {
          mode: "waitForCompletion",
          sessionId: "child",
          success: true,
          finalOutput: "done",
        };
      },
    );
    let nextAgent = 0;
    const parent = {
      id: "parent",
      workingDirectory: "/repo",
      isSubagent: false,
    } as Session;
    const child = {
      ...parent,
      id: "child",
      isSubagent: true,
      parentId: "parent",
    } as Session;
    const host = new SessionSubagentHost({
      ...channel,
      agentManager: {
        getRuntimeAgent: (): Promise<RuntimeAgent> =>
          Promise.resolve({
            config: { name: "explore", mode: "subagent", maxSteps: 5 },
            isSubagent: true,
            tools: {},
          }),
      },
      instanceFactory: {
        create: (identity): AgentInstance => ({
          identity,
          contextScope: {} as AgentInstance["contextScope"],
          turn,
        }),
      },
      sessionManager: {
        create: (): Promise<Session> => Promise.resolve(child),
        get: (id): Promise<Session> =>
          Promise.resolve(id === "parent" ? parent : child),
      },
      store: new InMemorySubagentInstanceStore(),
      executionStore: executions,
      getParentRunModel: (): ReturnType<typeof testRunModel> =>
        testRunModel("fixture"),
      createSubagentId: (): string => `agent-${String(++nextAgent)}`,
      resolveRequester: (): Promise<{
        rootSessionId: string;
        rootRunId: string;
      }> => Promise.resolve({ rootSessionId: "parent", rootRunId: "root" }),
    });
    const scheduler = createToolScheduler({
      bus,
      permissionState: createPermissionState({
        bus,
        initialLevel: "full-access",
      }),
      config: { concurrency: { maxSubagentConcurrency: 6 } },
    });
    scheduler.register(tool(host));
    const request = {
      runId: "root",
      sessionId: "parent",
      messageId: "message",
      toolName: "agent",
    };
    const active = Array.from({ length: 6 }, (_, index) =>
      scheduler.execute({
        ...request,
        callId: `spawn-${String(index)}`,
        params: { action: "spawn", prompt: "work", mode: "foreground" },
      }),
    );
    await vi.waitFor(() => {
      expect(turn).toHaveBeenCalledTimes(6);
    });
    const running = (await executions.listByRootRun("root"))[0];
    let sent = false;
    let refused = false;
    const send = scheduler
      .execute({
        ...request,
        callId: "send",
        params: {
          action: "send",
          agent_id: running.subagentId,
          message: "Continue with this update",
        },
      })
      .then((result) => {
        sent =
          result.status === "success" &&
          result.output?.includes("accepted: true") === true &&
          result.output.includes("started: false");
        return result;
      });
    const seventh = scheduler
      .execute({
        ...request,
        callId: "seventh",
        params: {
          action: "spawn",
          prompt: "must be refused",
          mode: "background",
        },
      })
      .then((result) => {
        refused =
          result.status === "success" &&
          result.output?.includes("started: false") === true;
        return result;
      });
    try {
      await vi.waitFor(() => {
        expect({ sent, refused }).toEqual({ sent: true, refused: true });
      });
      expect(await executions.listByRootRun("root")).toHaveLength(6);
      if (!running.childRunId) throw new Error("Expected running child");
      expect(await inputs.listPending(running.childRunId)).toHaveLength(1);
      expect(turn).toHaveBeenCalledTimes(6);
      for (let index = 0; index < 6; index++)
        expect(scheduler.getStatus(`spawn-${String(index)}`)).toBe("executing");
    } finally {
      finish();
      await Promise.all([...active, send, seventh]);
      await vi.waitFor(() => {
        expect(host.hasActiveWork()).toBe(false);
      });
      await host.dispose();
    }
  });

  it("admits actual agent control actions while foreground spawn holds dispatch capacity", async () => {
    const host = createHost();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    host.spawn.mockImplementationOnce(async () => {
      await pending;
      return { started: true, execution, item, output: "done", success: true };
    });
    const bus = createBus();
    const scheduler = createToolScheduler({
      bus,
      permissionState: createPermissionState({
        bus,
        initialLevel: "full-access",
      }),
      config: { concurrency: { maxSubagentConcurrency: 1 } },
    });
    scheduler.register(tool(host));
    const request = {
      runId: "run_1",
      sessionId: "parent_1",
      messageId: "m",
      toolName: "agent",
    };
    const spawned = scheduler.execute({
      ...request,
      callId: "spawn",
      params: { action: "spawn", prompt: "inspect", mode: "foreground" },
    });
    try {
      await vi.waitFor(() => {
        expect(scheduler.getStatus("spawn")).toBe("executing");
      });
      for (const action of ["stop", "list", "monitor"]) {
        const result = await scheduler.execute({
          ...request,
          callId: action,
          params:
            action === "stop"
              ? { action, agent_id: "a" }
              : action === "monitor"
                ? { action, agent_ids: ["a"] }
                : { action },
        });
        expect(result.status).toBe("success");
      }
      expect(scheduler.getStatus("spawn")).toBe("executing");
    } finally {
      finish();
      await spawned;
    }
  });
  it("does not copy a previous task failure into the close receipt", async () => {
    const host = createHost();
    host.close.mockResolvedValueOnce({
      subagentId: item.subagentId,
      previousStatus: "failed",
      item: { ...item, error: "OLD FAILURE", output: "OLD FAILURE" },
      cleanup: "confirmed",
      unprocessedMessages: [],
    });
    const result = await tool(host).execute(
      { action: "close", agent_id: item.subagentId },
      context,
    );
    expect(result.output).not.toContain("OLD FAILURE");
    expect(result.output).toContain("confirmed");
  });
  it("requires a real run identity for execution-creating actions", async () => {
    await expect(
      tool().execute(
        { action: "spawn", prompt: "ok" },
        { ...context, runId: undefined },
      ),
    ).rejects.toThrow("requester run");
  });
});
