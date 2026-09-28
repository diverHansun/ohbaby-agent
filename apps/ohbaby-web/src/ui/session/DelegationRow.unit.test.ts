// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { UiMessage, UiSubagentExecution, UiToolCall } from "ohbaby-sdk";
import { DelegationRow, delegationExecution } from "./DelegationRow.js";
const call: UiToolCall = {
  id: "tool",
  name: "subagent_run",
  input: { prompt: "task" },
  status: "completed",
};
const message: UiMessage = {
  id: "message",
  role: "assistant",
  runId: "run",
  createdAt: "2026-01-01",
  parts: [{ type: "tool-call", call }],
};
const execution: UiSubagentExecution = {
  executionId: "execution",
  subagentId: "worker",
  rootSessionId: "root",
  rootRunId: "run",
  requestId: JSON.stringify([message.id, call.id]),
  status: "completed",
  createdAt: 1,
  updatedAt: 2,
  resultStored: true,
  delivery: "foreground",
};
it("joins delegation by exact message and call identity within the authorized root", () => {
  expect(delegationExecution(message, call, [execution], "root")).toBe(
    execution,
  );
  expect(
    delegationExecution({ ...message, id: "other" }, call, [execution], "root"),
  ).toBeUndefined();
  expect(
    delegationExecution(message, call, [execution], "other-root"),
  ).toBeUndefined();
});
it("opens legacy result metadata without inventing a parent anchor", () => {
  const legacy = {
    ...message,
    parts: [
      ...message.parts,
      {
        type: "tool-result" as const,
        result: { callId: call.id, output: "done" },
        metadata: {
          subagent: {
            execution: {
              executionId: "old",
              subagentId: "worker",
              status: "completed",
              childSessionId: "child",
            },
          },
        },
      },
    ],
  };
  const result = delegationExecution(legacy, call, [], "root");
  expect(result?.executionId).toBe("old");
  expect(result?.childUserMessageId).toBeUndefined();
});

it("keeps input and error output accessible when delegation failed before acceptance", () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onOpen = vi.fn();
  try {
    act(() => {
      root.render(
        createElement(DelegationRow, {
          call: { ...call, status: "failed" },
          result: {
            callId: call.id,
            output: "admission failed",
            error: "invalid subagent",
          },
          onOpen,
        }),
      );
    });
    const button = container.querySelector<HTMLButtonElement>("button");
    expect(button?.disabled).toBe(false);
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    act(() => {
      button?.click();
    });
    expect(container.textContent).toContain("Input");
    expect(container.textContent).toContain("Output");
    expect(container.textContent).toContain("invalid subagent");
    expect(container.textContent).toContain("task");
    expect(onOpen).not.toHaveBeenCalled();
  } finally {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
});

it("renders accepted timeouts as a readable task status with an active conversation entry", () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onOpen = vi.fn();
  const timedOut = { ...execution, status: "timed_out" as const };
  try {
    act(() => {
      root.render(
        createElement(DelegationRow, {
          call: { ...call, status: "failed" },
          execution: timedOut,
          onOpen,
        }),
      );
    });
    expect(container.textContent).toContain("Timed out");
    expect(container.textContent).not.toContain("timed_out");
    const button = container.querySelector<HTMLButtonElement>("button");
    expect(button?.disabled).toBe(false);
    act(() => {
      button?.click();
    });
    expect(onOpen).toHaveBeenCalledWith(timedOut, button);
  } finally {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
});

it("keeps completed legacy delegation input and saved result readable without an execution record", () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    act(() => {
      root.render(
        createElement(DelegationRow, {
          call,
          result: { callId: call.id, output: "Legacy stored answer" },
          onOpen: vi.fn(),
        }),
      );
    });
    expect(container.textContent).not.toContain("Connecting");
    const button = container.querySelector<HTMLButtonElement>("button");
    expect(button?.disabled).toBe(false);
    act(() => button?.click());
    expect(container.textContent).toContain("Legacy stored answer");
    expect(container.textContent).toContain("Input");
  } finally {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
});
