import { describe, expect, it, vi } from "vitest";
import { createSubagentReader } from "./subagent-reader.js";
import type {
  UiSubagentExecutionList,
  UiSubagentExecutionView,
} from "./subagent.js";
const list: UiSubagentExecutionList = {
  executions: [],
  hasMore: false,
  waiting: true,
  approvalBlocked: false,
  activeCount: 1,
  completedCount: 0,
};
function view(id: string, revision = 1): UiSubagentExecutionView {
  return {
    execution: {
      executionId: id,
      subagentId: "agent",
      rootSessionId: "root",
      rootRunId: "run",
      status: "running",
      createdAt: 1,
      updatedAt: 1,
      resultStored: false,
      delivery: "none",
    },
    version: {
      runtimeEpoch: "epoch",
      sessionId: "child",
      viewGeneration: "generation",
      sessionRevision: revision,
    },
    messages: [
      {
        id,
        createdAt: "2026-01-01",
        role: "assistant",
        parts: [{ type: "text", text: id }],
      },
    ],
    history: { hasMore: true, before: id },
    reasoningMissing: false,
    readOnly: true,
  };
}
describe("subagent reader", () => {
  it("cancels switched views and ignores late responses", async () => {
    let release: (value: UiSubagentExecutionView) => void = () => undefined;
    const calls: AbortSignal[] = [];
    const reader = createSubagentReader(
      {
        listSubagentExecutions: () => Promise.resolve(list),
        getSubagentExecutionView: (input) => {
          if (input.signal) calls.push(input.signal);
          return input.executionId === "a"
            ? new Promise((resolve) => {
                release = resolve;
              })
            : Promise.resolve(view("b"));
        },
      },
      "root",
    );
    reader.select("a");
    await Promise.resolve();
    await Promise.resolve();
    reader.select("b");
    await new Promise((resolve) => setTimeout(resolve, 0));
    release(view("a"));
    await Promise.resolve();
    expect(calls[0].aborted).toBe(true);
    expect(reader.getSnapshot().view?.execution.executionId).toBe("b");
    reader.dispose();
  });
  it("keeps loaded history while refreshing and exposes failures", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(view("new"))
      .mockResolvedValueOnce(view("old"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(view("new", 2));
    const reader = createSubagentReader(
      {
        listSubagentExecutions: () => Promise.resolve(list),
        getSubagentExecutionView: get,
      },
      "root",
    );
    reader.select("execution");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await reader.loadMore();
    expect(reader.getSnapshot().view?.messages.map((m) => m.id)).toEqual([
      "new",
      "old",
    ]);
    await reader.refresh();
    expect(reader.getSnapshot().error).toBe("offline");
    expect(reader.getSnapshot().view?.messages).toHaveLength(2);
    await reader.refresh();
    expect(reader.getSnapshot().error).toBeUndefined();
    expect(reader.getSnapshot().view?.messages).toHaveLength(2);
    reader.dispose();
  });
});

it("replaces a disconnected history window so missed middle messages remain pageable", async () => {
  const first = { ...view("1"), history: { hasMore: false } };
  const latest = {
    ...view("101", 2),
    messages: [52, 101].map((id) => ({
      ...view(String(id)).messages[0],
      createdAt: `2026-01-${String(id).padStart(3, "0")}`,
    })),
    history: { hasMore: true, before: "cursor52" },
  };
  const get = vi
    .fn()
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(latest)
    .mockResolvedValueOnce({
      ...view("51", 3),
      history: { hasMore: true, before: "cursor51" },
    });
  const reader = createSubagentReader(
    {
      listSubagentExecutions: () => Promise.resolve(list),
      getSubagentExecutionView: get,
    },
    "root",
  );
  reader.select("execution");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await reader.refresh();
  expect(reader.getSnapshot().view?.history).toEqual({
    hasMore: true,
    before: "cursor52",
  });
  expect(
    reader.getSnapshot().view?.messages.map((message) => message.id),
  ).toEqual(["52", "101"]);
  await reader.loadMore();
  expect(get.mock.calls[2][0]).toMatchObject({ before: "cursor52" });
  expect(
    reader.getSnapshot().view?.messages.map((message) => message.id),
  ).toContain("51");
  reader.dispose();
});

it("resets an execution-list cursor when reconnect skips a nonoverlapping window", async () => {
  const first = { ...list, executions: [view("1").execution], hasMore: false };
  const latest = {
    ...list,
    executions: [view("101").execution],
    hasMore: true,
    before: "cursor101",
  };
  const read = vi
    .fn()
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(latest);
  const reader = createSubagentReader(
    {
      listSubagentExecutions: read,
      getSubagentExecutionView: () => Promise.reject(new Error("No selection")),
    },
    "root",
  );
  await reader.refresh();
  await reader.refresh();
  expect(
    reader
      .getSnapshot()
      .list?.executions.map((execution) => execution.executionId),
  ).toEqual(["101"]);
  expect(reader.getSnapshot().list?.before).toBe("cursor101");
  reader.dispose();
});
