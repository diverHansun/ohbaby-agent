// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import {
  createSubagentConversationReader,
  type UiSubagentConversationReaderState,
  type UiSubagentExecution,
} from "ohbaby-sdk";
import { SubagentView } from "./SubagentView.js";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of mounted.splice(0)) cleanup();
});
const execution: UiSubagentExecution = {
  executionId: "exec",
  subagentId: "worker",
  rootSessionId: "root",
  rootRunId: "run",
  childUserMessageId: "parent",
  status: "queued",
  createdAt: 1,
  updatedAt: 1,
  resultStored: false,
  delivery: "none",
};
function state(): UiSubagentConversationReaderState {
  const messages = [
    {
      id: "parent",
      role: "user" as const,
      createdAt: "2026-01-02",
      parts: [{ type: "text" as const, text: "Investigate the issue" }],
    },
    {
      id: "m",
      role: "assistant" as const,
      createdAt: "2026-01-01",
      parts: [
        { type: "reasoning" as const, text: "reasoning " + "x".repeat(20000) },
        {
          type: "tool-call" as const,
          call: {
            id: "tool",
            name: "read",
            input: { path: "/full/path" },
            status: "completed" as const,
          },
        },
        {
          type: "tool-result" as const,
          result: { callId: "tool", output: "entire " + "y".repeat(20000) },
        },
      ],
    },
  ];
  return {
    loading: false,
    locating: false,
    selected: execution,
    conversation: {
      rootSessionId: "root",
      subagentId: "worker",
      readOnly: true,
      anchorFound: true,
      anchorMessageId: "parent",
      executions: [execution],
      messages,
      history: { hasMore: false, hasLater: false },
      view: {
        version: {
          runtimeEpoch: "epoch",
          viewGeneration: "g",
          sessionId: "child",
          sessionRevision: 1,
        },
        session: {
          id: "child",
          title: "Worker",
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
          messages,
        },
        runs: [],
        prompts: [],
        history: { hasMore: false },
        reasoningMissing: false,
        todo: { status: "unavailable", reason: "none" },
        goal: { status: "unavailable", reason: "none" },
        context: { status: "unavailable", reason: "none" },
      },
    },
  };
}
it("keeps the same child transcript and open tools when expanding, with parent labels and no writable controls", () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const reader = createSubagentConversationReader({}, "root");
  const onClose = vi.fn();
  const onExpandedChange = vi.fn();
  const data = state();
  const render = (expanded: boolean): void => {
    act(() => {
      root.render(
        <SubagentView
          reader={reader}
          state={data}
          rootTitle="Main task"
          title="Investigate issue"
          expanded={expanded}
          onExpandedChange={onExpandedChange}
          onClose={onClose}
        />,
      );
    });
  };
  mounted.push(() => {
    act(() => {
      root.unmount();
    });
    reader.dispose();
    element.remove();
  });
  render(false);
  expect(element.querySelector('[role="dialog"]')).not.toBeNull();
  expect(element.textContent).toContain("From parent");
  expect(element.textContent).toContain("Queued");
  expect(
    [...element.querySelectorAll("[data-message-id]")].map((row) =>
      row.getAttribute("data-message-id"),
    ),
  ).toEqual(["parent", "m"]);
  expect(element.querySelector(".ohb-child-footer")?.textContent).not.toContain(
    "Read-only",
  );
  const transcript = element.querySelector(".ohb-stream");
  act(() =>
    element.querySelector<HTMLButtonElement>("button[aria-expanded]")?.click(),
  );
  expect(element.textContent).toContain("y".repeat(20000));
  render(true);
  expect(element.querySelector(".ohb-stream")).toBe(transcript);
  expect(element.querySelector(".ohb-child-footer")?.textContent).toContain(
    "Read-only",
  );
  expect(element.textContent).toContain("y".repeat(20000));
  expect(element.querySelector("textarea")).toBeNull();
  expect(element.querySelector('button[aria-label="Collapse"]')).not.toBeNull();
  expect(element.textContent).toContain("Main task");
  act(() =>
    element
      .querySelector<HTMLButtonElement>('button[aria-label="Close"]')
      ?.click(),
  );
  expect(onClose).toHaveBeenCalledOnce();
});
it("handles Escape by collapsing first and closing a sheet, while ignoring IME composition", () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const reader = createSubagentConversationReader({}, "root");
  const onClose = vi.fn();
  const onExpandedChange = vi.fn();
  mounted.push(() => {
    act(() => {
      root.unmount();
    });
    reader.dispose();
    element.remove();
  });
  const render = (expanded: boolean): void => {
    act(() => {
      root.render(
        <SubagentView
          reader={reader}
          state={state()}
          rootTitle="Main"
          title="Worker"
          expanded={expanded}
          onExpandedChange={onExpandedChange}
          onClose={onClose}
        />,
      );
    });
  };
  render(true);
  void act(() =>
    element.querySelector('[role="dialog"]')?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        isComposing: true,
      }),
    ),
  );
  expect(onExpandedChange).not.toHaveBeenCalled();
  void act(() =>
    element
      .querySelector('[role="dialog"]')
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
  );
  expect(onExpandedChange).toHaveBeenCalledWith(false);
  expect(onClose).not.toHaveBeenCalled();
  render(false);
  void act(() =>
    element
      .querySelector('[role="dialog"]')
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
  );
  expect(onClose).toHaveBeenCalledOnce();
});

it("retains each logical child's tool expansion and updates the existing streaming message", () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const reader = createSubagentConversationReader({}, "root");
  mounted.push(() => {
    act(() => {
      root.unmount();
    });
    reader.dispose();
    element.remove();
  });
  const a = state();
  const b = {
    ...a,
    selected: { ...execution, subagentId: "other" },
    conversation: a.conversation
      ? { ...a.conversation, subagentId: "other" }
      : undefined,
  };
  const render = (data: UiSubagentConversationReaderState): void => {
    act(() => {
      root.render(
        <SubagentView
          reader={reader}
          state={data}
          rootTitle="Main"
          title="Task"
          expanded={false}
          onExpandedChange={() => undefined}
          onClose={() => undefined}
        />,
      );
    });
  };
  render(a);
  act(() => {
    element.querySelector<HTMLButtonElement>("button[aria-expanded]")?.click();
  });
  expect(element.querySelector('button[aria-expanded="true"]')).not.toBeNull();
  render(b);
  expect(element.querySelector('button[aria-expanded="false"]')).not.toBeNull();
  act(() => {
    element.querySelector<HTMLButtonElement>("button[aria-expanded]")?.click();
  });
  expect(element.querySelector('button[aria-expanded="true"]')).not.toBeNull();
  render(a);
  expect(element.querySelector('button[aria-expanded="true"]')).not.toBeNull();
  const streaming = {
    ...a,
    conversation: a.conversation
      ? {
          ...a.conversation,
          messages: [
            ...a.conversation.messages,
            {
              id: "stream",
              role: "assistant" as const,
              status: "streaming" as const,
              createdAt: "2026-01-03",
              parts: [{ type: "text" as const, text: "hello" }],
            },
          ],
        }
      : undefined,
  };
  render(streaming);
  const row = element.querySelector('[data-message-id="stream"]');
  const next = {
    ...streaming,
    conversation: streaming.conversation
      ? {
          ...streaming.conversation,
          messages: streaming.conversation.messages.map((message) =>
            message.id === "stream"
              ? {
                  ...message,
                  parts: [{ type: "text" as const, text: "hello world" }],
                }
              : message,
          ),
        }
      : undefined,
  };
  render(next);
  expect(element.querySelector('[data-message-id="stream"]')).toBe(row);
  expect(row?.textContent).toBe("hello world");
});

it("keeps keyboard focus inside the child and only loads later history after user scrolling", () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const reader = createSubagentConversationReader({}, "root");
  const loadLater = vi.spyOn(reader, "loadLater").mockResolvedValue();
  const data = state();
  const anchored = {
    ...data,
    conversation: data.conversation
      ? { ...data.conversation, history: { hasMore: false, hasLater: true } }
      : undefined,
  };
  mounted.push(() => {
    act(() => {
      root.unmount();
    });
    reader.dispose();
    element.remove();
  });
  act(() => {
    root.render(
      <SubagentView
        reader={reader}
        state={anchored}
        rootTitle="Main"
        title="Worker"
        expanded={false}
        onExpandedChange={() => undefined}
        onClose={() => undefined}
      />,
    );
  });
  expect(document.activeElement).toBe(element.querySelector("h2"));
  const last = element.querySelector<HTMLButtonElement>(
    'button[aria-label="Jump to latest"]',
  );
  last?.focus();
  act(() => {
    last?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
    );
  });
  expect(document.activeElement).toBe(
    element.querySelector('button[aria-label="Expand"]'),
  );
  const stream = element.querySelector(".ohb-stream");
  act(() => {
    stream?.dispatchEvent(new Event("scroll"));
  });
  expect(loadLater).not.toHaveBeenCalled();
  act(() => {
    stream?.dispatchEvent(new WheelEvent("wheel"));
    stream?.dispatchEvent(new Event("scroll"));
  });
  expect(loadLater).toHaveBeenCalledOnce();
});

it("keeps an explicit parent anchor even when it is within the auto-follow threshold", () => {
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(535);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const stream = this.closest<HTMLElement>(".ohb-stream");
      const top = this.dataset.messageId ? 320 - (stream?.scrollTop ?? 0) : 300;
      return new DOMRect(0, top, 100, 20);
    },
  );
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const reader = createSubagentConversationReader({}, "root");
  try {
    act(() => {
      root.render(
        <SubagentView
          reader={reader}
          state={state()}
          rootTitle="Main"
          title="Worker"
          expanded={false}
          onExpandedChange={() => undefined}
          onClose={() => undefined}
        />,
      );
    });
    const stream = element.querySelector<HTMLElement>(".ohb-stream");
    expect(stream?.scrollTop).toBe(8);
    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(stream?.scrollTop).toBe(8);
  } finally {
    act(() => {
      root.unmount();
    });
    reader.dispose();
    element.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});
