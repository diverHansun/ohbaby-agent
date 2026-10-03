import { render } from "ink-testing-library";
import type { ReactElement } from "react";
import { expect, it, vi } from "vitest";
import { SubagentBrowser, SubagentWait } from "./subagent-browser.js";
import { DurationSampleContext } from "./execution-duration.js";
import { LayoutProvider } from "../layout/context.js";
import { computeLayoutMetrics } from "../layout/metrics.js";
import { AppShell } from "../layout/app-shell.js";
import { createSubagentReader, type UiSubagentReaderState } from "ohbaby-sdk";
it("renders read-only child text and complete tool bodies without internal inputs or reasoning and returns with Escape", async () => {
  const reader = createSubagentReader({}, "root");
  const close = vi.fn();
  const state: UiSubagentReaderState = {
    loading: false,
    selectedId: "execution",
    view: {
      execution: {
        executionId: "execution",
        subagentId: "agent",
        rootSessionId: "root",
        rootRunId: "run",
        status: "completed",
        createdAt: 1,
        updatedAt: 2,
        resultStored: true,
        delivery: "processed",
        processedRequestId: "request",
      },
      readOnly: true,
      reasoningMissing: false,
      history: { hasMore: false },
      messages: [
        {
          id: "EMPTY_REASONING_HEADER",
          role: "assistant",
          createdAt: "2026-01-01",
          parts: [{ type: "reasoning", text: "hidden only" }],
        },
        {
          id: "internal-status",
          role: "system",
          createdAt: "2026-01-01",
          runtimeInputKind: "subagent-status",
          parts: [{ type: "text", text: "INTERNAL_SENTINEL" }],
        },
        {
          id: "internal-result",
          role: "system",
          createdAt: "2026-01-01",
          runtimeInputKind: "subagent-result",
          parts: [{ type: "text", text: "INTERNAL_SENTINEL" }],
        },
        {
          id: "steer",
          role: "user",
          createdAt: "2026-01-01",
          runtimeInputKind: "user-steer",
          parts: [{ type: "text", text: "user-steer stays visible" }],
        },
        {
          id: "m",
          role: "assistant",
          createdAt: "2026-01-01",
          parts: [
            { type: "reasoning", text: "full reasoning" },
            { type: "text", text: "quote: subagent-status" },
            {
              type: "tool-call",
              call: {
                id: "nested",
                name: "subagent_run",
                input: { name: "Audit UI", prompt: "PRIVATE_SUBAGENT_PROMPT" },
                status: "completed",
              },
            },
            {
              type: "tool-call",
              call: {
                id: "t",
                name: "read",
                input: { path: "file" },
                status: "completed",
              },
            },
            {
              type: "tool-result",
              result: { callId: "t", output: "complete body" },
            },
          ],
        },
      ],
    },
  };
  const app = render(
    <AppShell>
      <SubagentBrowser reader={reader} state={state} onClose={close} />
    </AppShell>,
  );
  expect(app.lastFrame()).toContain("Read only");
  expect(app.lastFrame()).not.toContain("full reasoning");
  expect(app.lastFrame()).not.toContain("EMPTY_REASONING_HEADER");
  expect(app.lastFrame()).not.toContain("INTERNAL_SENTINEL");
  expect(app.lastFrame()).not.toContain("PRIVATE_SUBAGENT_PROMPT");
  expect(app.lastFrame()).toContain("Subagent Run Audit UI");
  expect(app.lastFrame()).toContain("user-steer stays visible");
  expect(app.lastFrame()).toContain("quote: subagent-status");
  expect(app.lastFrame()).toContain("complete body");
  expect(app.lastFrame()).toContain("Processed request: request");
  await new Promise((resolve) => setTimeout(resolve, 10));
  app.stdin.write("\u001b");
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(reader.getSnapshot().selectedId).toBeUndefined();
  expect(close).not.toHaveBeenCalled();
  app.unmount();
  reader.dispose();
});

it("only keeps the elapsed timer while the waiting summary is visible", async () => {
  const interval = vi.spyOn(globalThis, "setInterval");
  const clear = vi.spyOn(globalThis, "clearInterval");
  const state: UiSubagentReaderState = {
    loading: false,
    list: {
      executions: [],
      hasMore: false,
      waiting: false,
      approvalBlocked: false,
      activeCount: 1,
      completedCount: 0,
    },
  };
  const run = {
    id: "run",
    sessionId: "root",
    status: { kind: "running" as const, runId: "run" },
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const sample = { serverNow: Date.now(), receivedAt: performance.now() };
  const view = (waiting: boolean): ReactElement => (
    <DurationSampleContext.Provider value={sample}>
      <SubagentWait
        state={{
          ...state,
          list: {
            executions: [],
            hasMore: false,
            activeCount: 1,
            completedCount: 0,
            approvalBlocked: false,
            waiting,
          },
        }}
        run={run}
      />
    </DurationSampleContext.Provider>
  );
  const app = render(view(false));
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(interval.mock.calls.filter((call) => call[1] === 1000)).toHaveLength(
      0,
    );
    app.rerender(view(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const timerIndex = interval.mock.calls.findIndex(
      (call) => call[1] === 1000,
    );
    expect(timerIndex).toBeGreaterThanOrEqual(0);
    expect(app.lastFrame()).toContain("Waiting for subagents");
    app.rerender(view(false));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(clear).toHaveBeenCalledWith(
      interval.mock.results[timerIndex]?.value,
    );
    expect(app.lastFrame()).not.toContain("Waiting for subagents");
  } finally {
    app.unmount();
    interval.mockRestore();
    clear.mockRestore();
  }
});

it("keeps short-terminal execution headers visible and pages every detail line both ways", async () => {
  const reader = createSubagentReader({}, "root");
  const loadMore = vi.spyOn(reader, "loadMore").mockResolvedValue(undefined);
  const state: UiSubagentReaderState = {
    loading: false,
    selectedId: "execution",
    view: {
      execution: {
        executionId: "execution",
        subagentId: "agent",
        rootSessionId: "root",
        rootRunId: "run",
        status: "completed",
        createdAt: 1,
        updatedAt: 2,
        resultStored: true,
        delivery: "processed",
        processedRequestId: "request",
        artifactPath: "/workspace/results/complete-result.json",
      },
      readOnly: true,
      reasoningMissing: false,
      history: { hasMore: true },
      messages: [
        {
          id: "message",
          role: "assistant",
          createdAt: "2026-01-01",
          parts: [
            {
              type: "text",
              text: Array.from(
                { length: 35 },
                (_, index) => `detail-${String(index).padStart(2, "0")}`,
              ).join("\n"),
            },
          ],
        },
      ],
    },
  };
  const app = render(
    <LayoutProvider value={computeLayoutMetrics({ columns: 60, rows: 20 })}>
      <SubagentBrowser
        reader={reader}
        state={state}
        onClose={() => undefined}
      />
    </LayoutProvider>,
  );
  const seen = new Set<string>();
  const check = (): void => {
    const frame = app.lastFrame() ?? "";
    expect(frame.split("\n").length).toBeLessThan(20);
    expect(frame).toContain("Subagents · Read only");
    expect(frame).toContain("agent · completed");
    for (const match of frame.matchAll(/detail-\d+/gu)) seen.add(match[0]);
  };
  const tick = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 35));
  };
  await tick();
  check();
  for (let page = 0; page < 20; page++) {
    app.stdin.write("\u001b[6~");
    await tick();
    check();
  }
  expect(seen.size).toBe(35);
  expect(app.lastFrame()).toContain("detail-34");
  for (let page = 0; page < 20; page++) {
    app.stdin.write("\u001b[5~");
    await tick();
    check();
  }
  expect(app.lastFrame()).toContain("Processed request: request");
  expect(loadMore).toHaveBeenCalled();
  app.unmount();
  reader.dispose();
});

it("keeps the selected execution reachable in a short-terminal list", async () => {
  const reader = createSubagentReader({}, "root");
  const select = vi.spyOn(reader, "select");
  const state: UiSubagentReaderState = {
    loading: false,
    list: {
      executions: Array.from({ length: 25 }, (_, index) => ({
        executionId: `execution-${String(index)}`,
        subagentId: `agent-${String(index)}`,
        rootSessionId: "root",
        rootRunId: "run",
        status: "completed",
        createdAt: 1,
        updatedAt: 2,
        resultStored: true,
        delivery: "processed",
      })),
      hasMore: false,
      activeCount: 0,
      completedCount: 25,
      waiting: false,
      approvalBlocked: false,
    },
  };
  const app = render(
    <LayoutProvider value={computeLayoutMetrics({ columns: 60, rows: 20 })}>
      <SubagentBrowser
        reader={reader}
        state={state}
        onClose={() => undefined}
      />
    </LayoutProvider>,
  );
  await new Promise((resolve) => setTimeout(resolve, 35));
  for (let index = 1; index < 25; index++) {
    app.stdin.write("\u001b[B");
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(app.lastFrame()).toContain(`› agent-${String(index)} ·`);
    expect((app.lastFrame() ?? "").split("\n").length).toBeLessThan(20);
  }
  app.stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 35));
  expect(select).toHaveBeenCalledWith("execution-24");
  const list = state.list;
  if (!list) throw new Error("Expected execution list fixture");
  app.rerender(
    <LayoutProvider value={computeLayoutMetrics({ columns: 60, rows: 20 })}>
      <SubagentBrowser
        reader={reader}
        state={{
          ...state,
          list: {
            ...list,
            executions: list.executions.slice(0, 3),
          },
        }}
        onClose={() => undefined}
      />
    </LayoutProvider>,
  );
  await new Promise((resolve) => setTimeout(resolve, 35));
  expect(app.lastFrame()).toContain("› agent-2 ·");
  app.stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 35));
  expect(select).toHaveBeenLastCalledWith("execution-2");
  app.stdin.write("\u001b[A");
  await new Promise((resolve) => setTimeout(resolve, 35));
  expect(app.lastFrame()).toContain("› agent-1 ·");
  app.stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 35));
  expect(select).toHaveBeenLastCalledWith("execution-1");
  app.unmount();
  reader.dispose();
});
