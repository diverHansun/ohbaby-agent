// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { UiMessage, UiSubagentExecution, UiToolCall } from "ohbaby-sdk";
import {
  DelegationRow,
  isDelegationCall,
  delegationExecution,
  delegationNotStarted,
  delegationTitle,
} from "./DelegationRow.js";
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
          available: false,
          onOpen,
        }),
      );
    });
    expect(container.querySelector(".ohb-delegation-row")).toBeNull();
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

it("keeps the tool card and adds an entry that opens the instance at this delegation", () => {
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
          instanceName: "Code reviewer",
          available: true,
          onOpen,
        }),
      );
    });
    expect(container.textContent).toContain("Timed out");
    expect(container.textContent).not.toContain("timed_out");
    // The agent tool card stays whole above the entry (D39).
    expect(container.querySelector(".ohb-tool-panel")).not.toBeNull();
    const entry = container.querySelector<HTMLButtonElement>(
      ".ohb-delegation-row",
    );
    expect(entry?.textContent).toContain("Code reviewer");
    expect(entry?.getAttribute("aria-label")).toBe(
      "Open Code reviewer in Subagents",
    );
    act(() => {
      entry?.click();
    });
    expect(onOpen).toHaveBeenCalledWith({
      subagentId: "worker",
      executionId: "execution",
    });
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
          available: true,
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

it("labels each delegation with its own task even for the same named instance", () => {
  const first = {
    ...call,
    input: {
      subagentId: "worker",
      name: "Researcher",
      description: "Inspect recovery",
    },
  };
  const next = {
    ...call,
    input: {
      subagentId: "worker",
      name: "Researcher",
      description: "Verify the fix",
    },
  };
  expect(delegationTitle(first)).toBe("Inspect recovery");
  expect(delegationTitle(next)).toBe("Verify the fix");
  expect(delegationTitle({ ...call, input: { name: "Researcher" } })).toBe(
    "Researcher",
  );
});

it("shows an accepted failed child as Failed and withdraws the entry once it is unavailable", () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onOpen = vi.fn();
  const failed = {
    ...execution,
    status: "failed" as const,
    error: "Context compaction failed",
  };
  try {
    act(() => {
      root.render(
        createElement(DelegationRow, {
          call,
          execution: failed,
          available: true,
          onOpen,
        }),
      );
    });
    const entry = container.querySelector<HTMLButtonElement>(
      ".ohb-delegation-row",
    );
    expect(entry?.textContent).toContain("Failed");
    act(() => entry?.click());
    expect(onOpen).toHaveBeenCalledWith({
      subagentId: "worker",
      executionId: "execution",
    });
    // Closed instance or a result that says nothing started: no entry, card stays.
    act(() => {
      root.render(
        createElement(DelegationRow, {
          call,
          execution: failed,
          available: false,
          onOpen,
        }),
      );
    });
    expect(container.querySelector(".ohb-delegation-row")).toBeNull();
    expect(container.querySelector(".ohb-tool-panel")).not.toBeNull();
  } finally {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
});

it("renders new dispatches and history as delegations, while running sends stay ordinary tools", () => {
  expect(isDelegationCall(call)).toBe(true);
  expect(
    isDelegationCall({ ...call, name: "agent", input: { action: "spawn" } }),
  ).toBe(true);
  expect(
    isDelegationCall({
      ...call,
      name: "agent",
      input: { action: "send", agent_id: "worker" },
    }),
  ).toBe(false);
  expect(
    isDelegationCall(
      { ...call, name: "agent", input: { action: "send", agent_id: "worker" } },
      execution,
    ),
  ).toBe(true);
  for (const action of ["list", "monitor", "stop", "close"])
    expect(
      isDelegationCall(
        { ...call, name: "agent", input: { action } },
        execution,
      ),
    ).toBe(false);
});

it("reads from the tool result whether an execution started", () => {
  const withResult = (subagent: Record<string, unknown>): UiMessage => ({
    ...message,
    parts: [
      { type: "tool-call", call },
      {
        type: "tool-result",
        result: { callId: call.id, output: "receipt" },
        metadata: { subagent },
      },
    ],
  });
  expect(delegationNotStarted(message, call)).toBe(false);
  expect(
    delegationNotStarted(withResult({ started: false, reason: "full" }), call),
  ).toBe(true);
  expect(
    delegationNotStarted(withResult({ started: false, accepted: true }), call),
  ).toBe(true);
  expect(delegationNotStarted(withResult({ started: true }), call)).toBe(false);
});
