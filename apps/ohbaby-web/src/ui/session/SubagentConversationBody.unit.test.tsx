// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import {
  createSubagentConversationReader,
  type UiPromptError,
  type UiSubagentConversationReaderState,
  type UiSubagentExecution,
} from "ohbaby-sdk";
import {
  readingMemory,
  SubagentConversationBody,
  type SubagentReadingCache,
} from "./SubagentConversationBody.js";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of mounted.splice(0)) cleanup();
});
/** The reading body as a page hosts it; heading and controls belong to the host. */
function ChildReading(props: {
  readonly reader: ReturnType<typeof createSubagentConversationReader>;
  readonly readingCache: SubagentReadingCache;
  readonly state: UiSubagentConversationReaderState;
  readonly anchorToken?: string;
  readonly followAnchor?: boolean;
}): ReactElement {
  const selected = props.state.selected;
  const identity = `${selected?.rootSessionId ?? ""}:${selected?.subagentId ?? ""}`;
  return (
    <section>
      <SubagentConversationBody
        reader={props.reader}
        state={props.state}
        memory={readingMemory(props.readingCache, identity)}
        identity={identity}
        anchorToken={props.anchorToken}
        followAnchor={props.followAnchor}
      />
    </section>
  );
}
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
it("retains each logical child's tool expansion and updates the existing streaming message", () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const reader = createSubagentConversationReader({}, "root");
  const readingCache: SubagentReadingCache = new Map();
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
        <ChildReading
          reader={reader}
          readingCache={readingCache}
          state={data}
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

it("only loads later history after user scrolling", () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const reader = createSubagentConversationReader({}, "root");
  const readingCache: SubagentReadingCache = new Map();
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
      <ChildReading
        reader={reader}
        readingCache={readingCache}
        state={anchored}
      />,
    );
  });
  const last = element.querySelector<HTMLButtonElement>(
    ".ohb-child-gap button",
  );
  expect(last?.textContent).toContain("Load later messages");
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
  const readingCache: SubagentReadingCache = new Map();
  try {
    act(() => {
      root.render(
        <ChildReading
          reader={reader}
          readingCache={readingCache}
          state={state()}
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

it("retains expanded tools after closing and reopening through the root-owned cache", () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const reader = createSubagentConversationReader({}, "root");
  const readingCache: SubagentReadingCache = new Map();
  mounted.push(() => {
    act(() => {
      root.unmount();
    });
    reader.dispose();
    element.remove();
  });
  const render = (): void => {
    act(() => {
      root.render(
        <ChildReading
          reader={reader}
          readingCache={readingCache}
          state={state()}
        />,
      );
    });
  };
  render();
  act(() => {
    element.querySelector<HTMLButtonElement>("button[aria-expanded]")?.click();
  });
  expect(element.querySelector('button[aria-expanded="true"]')).not.toBeNull();
  act(() => {
    root.render(null);
  });
  render();
  expect(element.querySelector('button[aria-expanded="true"]')).not.toBeNull();
});

it("shows available-history guidance when the delegation has no exact parent anchor", () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const reader = createSubagentConversationReader({}, "root");
  const readingCache: SubagentReadingCache = new Map();
  const current = state();
  const legacy = {
    ...current,
    conversation: current.conversation
      ? {
          ...current.conversation,
          anchorFound: false,
          anchorMessageId: undefined,
        }
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
      <ChildReading
        reader={reader}
        readingCache={readingCache}
        state={legacy}
      />,
    );
  });
  expect(element.textContent).toContain(
    "This delegation’s original message is unavailable. Showing available conversation history.",
  );
  expect(element.textContent).toContain("Investigate the issue");
});

const providerError = {
  code: "PROVIDER_API",
  message: "The model rejected the request. Check the model configuration.",
  source: "provider" as const,
  retryable: false,
  providerId: "zenmux",
  statusCode: 400,
};
/**
 * A child whose run failed. Its turns live in the physical child session,
 * which several subagents can share; `root:subagent` only keys reading state.
 */
function failedState(
  subagentId = "worker",
  runId = "child-run",
  error: UiPromptError = providerError,
): UiSubagentConversationReaderState {
  const failed = {
    ...execution,
    subagentId,
    status: "failed" as const,
    childSessionId: "child",
    childRunId: runId,
  };
  const messages = [
    {
      id: `${subagentId}-task`,
      role: "user" as const,
      createdAt: "2026-11-12T15:28:00Z",
      parts: [{ type: "text" as const, text: "Check both items." }],
    },
    {
      id: `${subagentId}-step`,
      role: "assistant" as const,
      runId,
      status: "completed" as const,
      createdAt: "2026-11-12T15:28:05Z",
      parts: [
        {
          type: "tool-call" as const,
          call: {
            id: `${subagentId}-tool`,
            name: "read",
            input: { path: "/a" },
            status: "completed" as const,
          },
        },
        {
          type: "tool-result" as const,
          result: { callId: `${subagentId}-tool`, output: "a" },
        },
      ],
    },
    {
      id: `${subagentId}-failed`,
      role: "assistant" as const,
      runId,
      status: "error" as const,
      finishReason: "error",
      createdAt: "2026-11-12T15:28:10Z",
      parts: [],
    },
  ];
  const base = state();
  return {
    ...base,
    selected: failed,
    conversation: base.conversation && {
      ...base.conversation,
      subagentId,
      anchorMessageId: `${subagentId}-task`,
      executions: [failed],
      messages,
      view: {
        ...base.conversation.view,
        session: { ...base.conversation.view.session, messages },
        runs: [
          {
            id: runId,
            sessionId: "child",
            status: { kind: "idle" },
            outcome: "failed",
            startedAt: "2026-11-12T15:28:00Z",
            endedAt: "2026-11-12T15:28:10Z",
            updatedAt: "2026-11-12T15:28:10Z",
            error,
          },
        ],
      },
    },
  };
}
/** The body on one root, as a host page keeps it across selections. */
function mountReading(): {
  readonly element: HTMLDivElement;
  readonly readingCache: SubagentReadingCache;
  readonly render: (
    data: UiSubagentConversationReaderState | null,
    followAnchor?: boolean,
  ) => void;
} {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const reader = createSubagentConversationReader({}, "root");
  const readingCache: SubagentReadingCache = new Map();
  mounted.push(() => {
    act(() => {
      root.unmount();
    });
    reader.dispose();
    element.remove();
  });
  return {
    element,
    readingCache,
    render: (data, followAnchor): void => {
      act(() => {
        root.render(
          data ? (
            <ChildReading
              reader={reader}
              readingCache={readingCache}
              state={data}
              followAnchor={followAnchor}
            />
          ) : null,
        );
      });
    },
  };
}
function scrollTo(element: HTMLElement, top: number): void {
  const stream = element.querySelector<HTMLElement>(".ohb-stream");
  if (!stream) throw new Error("No stream");
  act(() => {
    stream.scrollTop = top;
    stream.dispatchEvent(new Event("scroll"));
  });
}

it.each([400, 429, undefined])(
  "shows a child's failure once with its actual HTTP status (%s)",
  (statusCode) => {
    const { element, render } = mountReading();
    render(
      failedState("worker", "child-run", { ...providerError, statusCode }),
    );
    const errors = element.querySelectorAll(".ohb-turn-error");
    expect(errors).toHaveLength(1);
    expect(errors[0].textContent).toContain(providerError.message);
    if (statusCode === undefined) {
      expect(errors[0].textContent).not.toContain("HTTP");
    } else {
      expect(errors[0].textContent).toContain(`HTTP ${String(statusCode)}`);
      if (statusCode === 429)
        expect(errors[0].textContent).not.toContain("HTTP 400");
    }
    expect(
      element.querySelector(
        '[data-message-id="worker-failed"] .ohb-turn-error',
      ),
    ).toBe(errors[0]);
    // A run failure is not a reading problem: no reader alert or Retry.
    expect(element.querySelector('[role="alert"]')).toBeNull();
  },
);

it("keeps a reader error apart from a run failure", () => {
  const { element, render } = mountReading();
  render({ ...failedState(), error: "Connection lost" });
  const alert = element.querySelector(".ohb-child-notice[role='alert']");
  const turnError = element.querySelector(".ohb-turn-error");
  expect(alert?.textContent).toContain("Connection lost");
  expect(alert?.textContent).not.toContain(providerError.message);
  expect(turnError?.textContent).toContain(providerError.message);
  expect(turnError?.textContent).not.toContain("Connection lost");
  render({ ...state(), error: "Connection lost" });
  expect(
    element.querySelector(".ohb-child-notice[role='alert']"),
  ).not.toBeNull();
  expect(element.querySelector(".ohb-turn-error")).toBeNull();
});

it("keeps a failed child's reason and reading place when reopened", () => {
  const { element, render } = mountReading();
  render(failedState(), false);
  scrollTo(element, 25);
  render(null);
  render(failedState(), false);
  expect(element.querySelector(".ohb-stream")?.scrollTop).toBe(25);
  expect(element.querySelector(".ohb-turn-error")?.textContent).toContain(
    providerError.message,
  );
});

it("keeps reading places apart for subagents sharing one child session", () => {
  const { element, readingCache, render } = mountReading();
  const worker = failedState("worker", "run-a");
  const other = failedState("other", "run-b");
  render(worker, false);
  scrollTo(element, 25);
  render(other, false);
  expect(element.querySelector(".ohb-stream")?.scrollTop).toBe(0);
  expect(
    element.querySelector('[data-message-id="other-failed"] .ohb-turn-error'),
  ).not.toBeNull();
  scrollTo(element, 12);
  render(worker, false);
  expect(element.querySelector(".ohb-stream")?.scrollTop).toBe(25);
  expect(readingCache.get("root:worker")?.position.top).toBe(25);
  expect(readingCache.get("root:other")?.position.top).toBe(12);
});
