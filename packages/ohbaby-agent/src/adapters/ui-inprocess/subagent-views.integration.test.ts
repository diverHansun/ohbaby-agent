import { describe, expect, it } from "vitest";
import { createSubagentViewReader } from "./subagent-views.js";
import { InMemorySubagentExecutionStore } from "../../agents/subagents/execution-store.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../../core/message/index.js";
import { createBus } from "../../bus/index.js";
import { SourceSessionProjection } from "../ui-state/source-session-projection.js";

async function fixture() {
  const executions = new InMemorySubagentExecutionStore();
  const messages = createMessageManager({
    bus: createBus(),
    store: createInMemoryMessageStore(),
  });
  const source = new SourceSessionProjection({
    runtimeEpoch: "epoch",
    messageManager: messages,
    metadata: (id) =>
      Promise.resolve({
        id,
        title: id,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      }),
    runs: () => Promise.resolve([]),
    prompts: () => Promise.resolve([]),
    publish: () => undefined,
  });
  for (const [id, run, at] of [
    ["a", "run-a", 1],
    ["b", "run-b", 2],
  ] as const) {
    const accepted = await executions.accept({
      executionId: id,
      requestId: id,
      parentSessionId: "root",
      requesterScopeId: "primary",
      requesterRunId: "root-run",
      rootSessionId: "root",
      rootRunId: "root-run",
      subagentId: "instance",
      mode: "background",
      prompt: "private task",
      createdAt: at,
    });
    await executions.bindChild(
      accepted.record,
      { sessionId: "child", contextScopeId: "scope" },
      at,
    );
    await executions.start(accepted.record, run, at);
  }
  const add = async (id: string, run: string, scope: string, text: string) => {
    await messages.createMessage({
      id,
      sessionId: "child",
      contextScopeId: scope,
      runId: run,
      role: "assistant",
      agent: "explore",
    });
    await messages.appendPart(id, { type: "text", text });
  };
  await add("a1", "run-a", "scope", "a first");
  await add("a2", "run-a", "scope", "a second");
  await add("b1", "run-b", "scope", "other execution");
  await add("wrong", "run-a", "other", "wrong scope");
  await messages.appendPart("a2", {
    type: "reasoning",
    text: "full reasoning " + "x".repeat(20000),
    endReason: "normal",
  });
  await messages.appendPart("a2", {
    type: "tool",
    callId: "todo",
    tool: "todo_write",
    state: {
      status: "completed",
      input: { secret: "TODO PRIVATE" },
      output: "TODO PRIVATE",
    },
  });
  const reader = createSubagentViewReader({
    executions,
    source,
    rootExists: (id) => Promise.resolve(id === "root"),
  });
  return { reader, messages, source, executions };
}
describe("readonly subagent execution views", () => {
  it("pages exact execution and scope, retaining complete reasoning but hiding todo bodies", async () => {
    const { reader } = await fixture();
    const latest = await reader.view({
      rootSessionId: "root",
      executionId: "a",
      limit: 1,
    });
    expect(latest.messages.map((m) => m.id)).toEqual(["a2"]);
    expect(JSON.stringify(latest.messages)).toContain("full reasoning");
    expect(JSON.stringify(latest.messages).length).toBeGreaterThan(20000);
    expect(JSON.stringify(latest)).not.toContain("TODO PRIVATE");
    expect(latest.history.hasMore).toBe(true);
    const older = await reader.view({
      rootSessionId: "root",
      executionId: "a",
      before: latest.history.before,
      limit: 1,
    });
    expect(older.messages.map((m) => m.id)).toEqual(["a1"]);
    expect(JSON.stringify(older)).not.toContain("other execution");
    expect(JSON.stringify(latest)).not.toContain("wrong scope");
  });
  it("rejects forged root ownership and cross-execution history cursors", async () => {
    const { reader } = await fixture();
    await expect(
      reader.view({ rootSessionId: "other", executionId: "a" }),
    ).rejects.toThrow();
    const page = await reader.view({
      rootSessionId: "root",
      executionId: "a",
      limit: 1,
    });
    await expect(
      reader.view({
        rootSessionId: "root",
        executionId: "b",
        before: page.history.before,
      }),
    ).rejects.toThrow();
  });
  it("returns lightweight paginated execution identity and rejects invalid limits", async () => {
    const { reader } = await fixture();
    const first = await reader.list({ rootSessionId: "root", limit: 1 });
    expect(first.executions.map((e) => e.executionId)).toEqual(["b"]);
    expect(first.hasMore).toBe(true);
    expect(JSON.stringify(first)).not.toContain("private task");
    const next = await reader.list({
      rootSessionId: "root",
      limit: 1,
      before: first.before,
    });
    expect(next.executions.map((e) => e.executionId)).toEqual(["a"]);
    await expect(
      reader.list({ rootSessionId: "root", limit: 201 }),
    ).rejects.toThrow();
  });
});

it("includes an authorized internal descendant execution through its root identity", async () => {
  const { reader, executions } = await fixture();
  await executions.accept({
    executionId: "nested",
    requestId: "nested",
    parentSessionId: "child",
    requesterScopeId: "scope",
    requesterRunId: "run-a",
    rootSessionId: "root",
    rootRunId: "root-run",
    subagentId: "nested-agent",
    mode: "background",
    prompt: "internal nested prompt",
    createdAt: 3,
  });
  const list = await reader.list({ rootSessionId: "root" });
  expect(list.executions.map((execution) => execution.executionId)).toContain(
    "nested",
  );
  const view = await reader.view({
    rootSessionId: "root",
    executionId: "nested",
  });
  expect(view.execution.rootSessionId).toBe("root");
  expect(view.readOnly).toBe(true);
  await expect(
    reader.view({ rootSessionId: "other", executionId: "nested" }),
  ).rejects.toThrow();
});
