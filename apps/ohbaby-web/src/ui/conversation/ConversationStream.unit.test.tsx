// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { UiMessage } from "ohbaby-sdk";
import { ConversationStream } from "./ConversationStream.js";
import { ConversationPresentation } from "./ConversationPresentation.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function message(
  id: string,
  role: UiMessage["role"],
  runtimeInputKind?: "subagent-status" | "subagent-result" | "user-steer",
): UiMessage {
  return {
    id,
    role,
    runtimeInputKind,
    createdAt: "2026-09-28T00:00:00Z",
    parts: [{ type: "text", text: id }],
  };
}

describe("shared conversation visibility", () => {
  it.each([false, true])(
    "hides internal inputs on history and live updates (child=%s)",
    (child) => {
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      const ordinary = [
        message("parent prompt", "user"),
        message("normal notice", "system"),
        message("Runtime subagent result quoted by assistant", "assistant"),
        message("user steer", "user", "user-steer"),
      ];
      const render = (messages: readonly UiMessage[]): void => {
        act(() => {
          root.render(
            <ConversationPresentation.Provider value={{ fromParent: child }}>
              <ConversationStream
                historyState="ready"
                historyHasMore={false}
                historyStale={false}
                onLoadHistory={() => Promise.resolve()}
                promptRows={[]}
                messages={messages}
                sessionId="session"
                prompts={[]}
                activeRun={undefined}
                isRunning={false}
                reasoningByMessageId={{}}
                commandNotices={null}
                preserveMessageOrder={child}
              />
            </ConversationPresentation.Provider>,
          );
        });
      };
      try {
        render([
          ...ordinary,
          message("internal result", "system", "subagent-result"),
        ]);
        expect(
          container.querySelector<HTMLElement>(
            '[data-message-id="internal result"]',
          ),
        ).toBeNull();
        render([
          ...ordinary,
          message("internal result", "system", "subagent-result"),
          message("internal observation", "system", "subagent-status"),
          message("normal progress", "assistant"),
        ]);
        expect(container.textContent).not.toContain("internal result");
        expect(container.textContent).not.toContain("internal observation");
        for (const item of ordinary)
          expect(container.textContent).toContain(item.id);
        expect(container.textContent).toContain("normal progress");
        expect(container.querySelectorAll("[data-message-id]")).toHaveLength(5);
        if (child) expect(container.textContent).toContain("From parent");
      } finally {
        act(() => {
          root.unmount();
        });
        container.remove();
      }
    },
  );
});

const completedPrompt = {
  promptId: "p",
  clientRequestId: "c",
  scopeKey: "scope",
  sessionId: "session",
  userMessageId: "user",
  text: "question",
  status: "succeeded" as const,
  runId: "run",
  createdAt: "2026-09-29T00:00:00Z",
  updatedAt: "2026-09-29T00:00:10Z",
  endedAt: "2026-09-29T00:00:10Z",
};
function runMessage(id: string, patch: Partial<UiMessage> = {}): UiMessage {
  return {
    ...message(id, "assistant"),
    runId: "run",
    status: "completed",
    ...patch,
  };
}
type StreamProps = React.ComponentProps<typeof ConversationStream>;
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("Expected test element");
  return value;
}
function conversationHarness(): {
  container: HTMLDivElement;
  render: (patch?: Partial<StreamProps>) => void;
  close: () => void;
} {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const defaults: React.ComponentProps<typeof ConversationStream> = {
    historyState: "ready",
    historyHasMore: false,
    historyStale: false,
    onLoadHistory: () => Promise.resolve(),
    promptRows: [],
    messages: [
      runMessage("user", { role: "user" }),
      runMessage("progress"),
      runMessage("answer"),
    ],
    sessionId: "session",
    prompts: [completedPrompt],
    activeRun: undefined,
    isRunning: false,
    reasoningByMessageId: {},
    commandNotices: null,
  };
  return {
    container,
    render: (patch: Partial<typeof defaults> = {}): void => {
      act(() => {
        root.render(<ConversationStream {...defaults} {...patch} />);
      });
    },
    close: (): void => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}
function processButton(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    "button.ohb-prompt-duration",
  );
}

describe("completed run disclosure", () => {
  it("keeps streaming visible, then folds work with duration before the answer and preserves manual expansion", () => {
    const h = conversationHarness();
    try {
      const messages = [
        runMessage("user", { role: "user" }),
        runMessage("progress"),
        runMessage("unknown", { runId: undefined }),
        runMessage("answer", { status: "streaming" }),
      ];
      h.render({ messages });
      expect(processButton(h.container)).toBeNull();
      expect(
        h.container
          .querySelector<HTMLElement>('[data-message-id="progress"]')
          ?.hasAttribute("hidden"),
      ).toBe(false);
      h.render({
        messages: messages.map((m) => ({ ...m, status: "completed" })),
      });
      const button = processButton(h.container);
      expect(button?.getAttribute("aria-expanded")).toBe("false");
      expect(
        h.container.querySelector<HTMLElement>('[data-message-id="progress"]')
          ?.hidden,
      ).toBe(true);
      expect(
        h.container
          .querySelector<HTMLElement>('[data-message-id="unknown"]')
          ?.closest("[hidden]"),
      ).toBeNull();
      expect(
        h.container
          .querySelector<HTMLElement>('[data-message-id="user"]')
          ?.closest("[hidden]"),
      ).toBeNull();
      const answer = h.container.querySelector(
        '[data-message-id="answer"] .ohb-markdown',
      );
      expect(answer).not.toBeNull();
      expect(
        required(button).compareDocumentPosition(required(answer)) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      act(() => {
        required(button).click();
      });
      h.render();
      expect(
        required(processButton(h.container)).getAttribute("aria-expanded"),
      ).toBe("true");
      expect(
        h.container.querySelector<HTMLElement>('[data-message-id="progress"]')
          ?.hidden,
      ).toBe(false);
      for (const id of required(
        required(button).getAttribute("aria-controls"),
      ).split(" "))
        expect(document.getElementById(id)).not.toBeNull();
    } finally {
      h.close();
    }
  });
  it("hides final-step reasoning without hiding either final text part", () => {
    const h = conversationHarness();
    try {
      h.render({
        messages: [
          runMessage("answer", {
            parts: [
              { type: "reasoning", text: "private work", endReason: "normal" },
              { type: "text", text: "First answer." },
              { type: "text", text: "Second answer." },
            ],
          }),
        ],
      });
      expect(processButton(h.container)?.getAttribute("aria-expanded")).toBe(
        "false",
      );
      const thought = required(h.container.querySelector("details"));
      expect(thought.closest("[hidden]")).not.toBeNull();
      const texts = h.container.querySelectorAll(".ohb-markdown");
      expect(texts).toHaveLength(2);
      for (const text of texts) expect(text.closest("[hidden]")).toBeNull();
      act(() => {
        required(processButton(h.container)).click();
      });
      expect(h.container.querySelector("details")).toBe(thought);
      expect(thought.closest("[hidden]")).toBeNull();
    } finally {
      h.close();
    }
  });
  it("does not give stopped, steered, or direct-answer runs a process button", () => {
    const h = conversationHarness();
    try {
      h.render({ prompts: [{ ...completedPrompt, status: "cancelled" }] });
      expect(processButton(h.container)).toBeNull();
      h.render({
        messages: [
          runMessage("progress"),
          runMessage("steer", { role: "user", runtimeInputKind: "user-steer" }),
          runMessage("answer"),
        ],
      });
      expect(processButton(h.container)).toBeNull();
      h.render({ messages: [runMessage("answer")] });
      expect(processButton(h.container)).toBeNull();
      expect(
        h.container.querySelector(".ohb-prompt-duration")?.textContent,
      ).toContain("Total");
    } finally {
      h.close();
    }
  });
  it("reveals a collapsed process before explicit message anchoring", () => {
    const h = conversationHarness();
    try {
      h.render();
      h.render({ anchorMessageId: "progress", anchorToken: "jump" });
      expect(
        h.container.querySelector<HTMLElement>('[data-message-id="progress"]')
          ?.hidden,
      ).toBe(false);
      expect(
        required(processButton(h.container)).getAttribute("aria-expanded"),
      ).toBe("true");
    } finally {
      h.close();
    }
  });
  it("does not steal focus from the composer when previously focused work collapses", () => {
    const h = conversationHarness();
    const composer = document.createElement("textarea");
    document.body.append(composer);
    const messages = [
      runMessage("progress", {
        parts: [{ type: "reasoning", text: "work", endReason: "normal" }],
      }),
      runMessage("answer"),
    ];
    try {
      h.render({
        messages,
        prompts: [
          { ...completedPrompt, status: "running", endedAt: undefined },
        ],
      });
      act(() => {
        required(h.container.querySelector<HTMLElement>("summary")).focus();
      });
      act(() => {
        composer.focus();
      });
      h.render({ messages });
      expect(document.activeElement).toBe(composer);
    } finally {
      h.close();
      composer.remove();
    }
  });
  it("keeps the replacement control visible when reading inside a long process", () => {
    const h = conversationHarness();
    const readingPosition = {
      top: 500,
      sticky: false,
      messageId: "progress",
      offset: -500,
    };
    try {
      h.render({
        readingPosition,
        prompts: [
          { ...completedPrompt, status: "running", endedAt: undefined },
        ],
      });
      const stream = required(
        h.container.querySelector<HTMLElement>(".ohb-stream"),
      );
      h.render({ readingPosition });
      // jsdom rectangles are zero: the replacement must stay at the viewport top,
      // not inherit a negative offset from the middle of the removed long row.
      expect(stream.scrollTop).toBe(500);
      expect(readingPosition.messageId).toBe("answer");
    } finally {
      h.close();
    }
  });
  it("keeps manually reopened reasoning open across unrelated rerenders", () => {
    const h = conversationHarness();
    try {
      const messages = [
        runMessage("answer", {
          parts: [{ type: "reasoning", text: "thinking", endReason: "normal" }],
        }),
      ];
      h.render({ messages });
      const details = required(h.container.querySelector("details"));
      act(() => {
        details.open = true;
        details.dispatchEvent(new Event("toggle"));
      });
      h.render({ messages: [...messages] });
      expect(details.open).toBe(true);
      expect(details.querySelector("summary svg")).not.toBeNull();
    } finally {
      h.close();
    }
  });
});
