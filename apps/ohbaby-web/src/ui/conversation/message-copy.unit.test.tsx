// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiMessage, UiPromptSubmission, UiRun } from "ohbaby-sdk";
import { ConversationStream } from "./ConversationStream.js";
import { messageBodyText } from "./message-text.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const writeText = vi.fn((_text: string) => Promise.resolve());
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: { writeText },
});

afterEach(() => {
  writeText.mockClear();
  document.body.innerHTML = "";
});

function prompt(
  runId: string,
  patch: Partial<UiPromptSubmission> = {},
): UiPromptSubmission {
  return {
    promptId: `prompt-${runId}`,
    clientRequestId: `client-${runId}`,
    scopeKey: "scope",
    sessionId: "session",
    userMessageId: `user-${runId}`,
    text: "question",
    status: "succeeded",
    runId,
    createdAt: "2026-11-06T00:00:00Z",
    updatedAt: "2026-11-06T00:00:10Z",
    endedAt: "2026-11-06T00:00:10Z",
    ...patch,
  };
}

function msg(
  id: string,
  role: UiMessage["role"],
  parts: UiMessage["parts"],
  patch: Partial<UiMessage> = {},
): UiMessage {
  return {
    id,
    role,
    createdAt: "2026-11-06T00:00:01Z",
    status: "completed",
    runId: "run",
    parts,
    ...patch,
  };
}

const text = (value: string): UiMessage["parts"][number] => ({
  type: "text",
  text: value,
});

function render(
  messages: readonly UiMessage[],
  prompts: readonly UiPromptSubmission[] = [prompt("run")],
  isRunning = false,
  runs: readonly UiRun[] = [],
): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <ConversationStream
        historyState="ready"
        historyHasMore={false}
        historyStale={false}
        onLoadHistory={() => Promise.resolve()}
        promptRows={[]}
        messages={messages}
        sessionId="session"
        prompts={prompts}
        runs={runs}
        activeRun={undefined}
        isRunning={isRunning}
        reasoningByMessageId={{}}
        commandNotices={null}
      />,
    );
  });
  return container;
}

function copyButtonsIn(container: HTMLElement): Map<string, HTMLButtonElement> {
  const buttons = new Map<string, HTMLButtonElement>();
  for (const row of container.querySelectorAll<HTMLElement>(
    "[data-message-id]",
  )) {
    const button = row.querySelector<HTMLButtonElement>(
      ".ohb-message-actions button",
    );
    if (button) buttons.set(row.dataset.messageId ?? "", button);
  }
  return buttons;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

describe("messageBodyText (T3)", () => {
  it("keeps text parts only, a blank line apart", () => {
    const message = msg("a", "assistant", [
      { type: "reasoning", text: "secret thinking", endReason: "normal" },
      text("First paragraph."),
      {
        type: "tool-call",
        call: { id: "c1", name: "read", status: "completed", input: {} },
      },
      text("  Second paragraph.  "),
      text("   "),
    ]);
    expect(messageBodyText(message)).toBe(
      "First paragraph.\n\nSecond paragraph.",
    );
  });
});

describe("message copy buttons", () => {
  it("copies only the turn's final answer, not interim text or tools (T4)", async () => {
    const view = render([
      msg("user-run", "user", [text("Fix the bug")]),
      msg("interim", "assistant", [
        text("Let me look first."),
        {
          type: "tool-call",
          call: { id: "c1", name: "read", status: "completed", input: {} },
        },
      ]),
      msg("answer", "assistant", [
        { type: "reasoning", text: "hidden", endReason: "normal" },
        text("Fixed in `a.ts`."),
      ]),
    ]);
    const buttons = copyButtonsIn(view);
    expect([...buttons.keys()]).toEqual(["user-run", "answer"]);
    const answer = buttons.get("answer");
    if (!answer) throw new Error("no answer button");
    expect(answer.getAttribute("aria-label")).toBe("Copy answer");
    await click(answer);
    expect(writeText).toHaveBeenLastCalledWith("Fixed in `a.ts`.");
  });

  it("offers no answer copy for a turn without a final answer (T5)", () => {
    for (const [messages, prompts] of [
      // Still streaming.
      [
        [
          msg("answer", "assistant", [text("partial")], {
            status: "streaming",
          }),
        ],
        [prompt("run", { status: "running", endedAt: undefined })],
      ],
      // Only a stop note, no model text (turn-projection T11).
      [
        [
          msg("answer", "assistant", [
            {
              ...text("[Response cancelled by the user.]"),
              metadata: { kind: "lifecycle-interruption" },
            },
          ]),
        ],
        [prompt("run", { status: "cancelled" })],
      ],
      // Ended on a tool call.
      [
        [
          msg("answer", "assistant", [
            text("Running it"),
            {
              type: "tool-call",
              call: { id: "c", name: "bash", status: "completed", input: {} },
            },
          ]),
        ],
        [prompt("run", { status: "cancelled" })],
      ],
    ] as const) {
      const view = render(messages, prompts);
      expect(copyButtonsIn(view).has("answer")).toBe(false);
      view.remove();
    }
  });

  it("copies user and steer messages as written, and keeps the latest answer's row visible (T6)", async () => {
    const view = render(
      [
        msg("user-run", "user", [text("First question")]),
        msg("old-answer", "assistant", [text("First answer")]),
        msg("user-run2", "user", [text("Second question")], { runId: "run2" }),
        msg("steer", "user", [text("Also check tests")], {
          runId: "run2",
          runtimeInputKind: "user-steer",
        }),
        msg("new-answer", "assistant", [text("Second answer")], {
          runId: "run2",
        }),
      ],
      [prompt("run"), prompt("run2")],
    );
    const buttons = copyButtonsIn(view);
    expect([...buttons.keys()]).toEqual([
      "user-run",
      "old-answer",
      "user-run2",
      "steer",
      "new-answer",
    ]);
    const steer = buttons.get("steer");
    if (!steer) throw new Error("no steer button");
    await click(steer);
    expect(writeText).toHaveBeenLastCalledWith("Also check tests");
    const persistent = [
      ...view.querySelectorAll<HTMLElement>(
        ".ohb-message-actions.is-persistent",
      ),
    ].map(
      (row) => row.closest<HTMLElement>("[data-message-id]")?.dataset.messageId,
    );
    expect(persistent).toEqual(["new-answer"]);
  });

  it("puts no copy row on compaction summaries", () => {
    const view = render(
      [
        msg(
          "summary",
          "user",
          [
            {
              ...text("Summary of earlier work"),
              metadata: { kind: "context-compaction" },
            },
          ],
          { runId: undefined },
        ),
      ],
      [],
    );
    expect(copyButtonsIn(view).size).toBe(0);
  });

  it("keeps no row visible while a newer turn runs", () => {
    const view = render(
      [
        msg("user-run", "user", [text("First question")]),
        msg("old-answer", "assistant", [text("First answer")]),
        msg("user-run2", "user", [text("Second question")], { runId: "run2" }),
      ],
      [
        prompt("run"),
        prompt("run2", { status: "running", endedAt: undefined }),
      ],
      true,
    );
    expect(view.querySelector(".ohb-message-actions.is-persistent")).toBeNull();
    expect(copyButtonsIn(view).has("old-answer")).toBe(true);
  });

  it("labels a subagent wake-up turn and copies its final answer (T7)", async () => {
    const wake: UiRun = {
      id: "wake",
      sessionId: "session",
      status: { kind: "idle" },
      startedAt: "2026-11-06T00:01:00Z",
      endedAt: "2026-11-06T00:01:04Z",
      updatedAt: "2026-11-06T00:01:04Z",
      trigger: "subagent",
      outcome: "succeeded",
    };
    const view = render(
      [
        msg("user-run", "user", [text("Research both schools")]),
        msg("answer", "assistant", [text("Dispatched two agents.")]),
        msg("status", "user", [text("Runtime subagent result wake-up.")], {
          runId: "wake",
          runtimeInputKind: "subagent-status",
        }),
        msg("wake-progress", "assistant", [text("Reading the reports.")], {
          runId: "wake",
          createdAt: "2026-11-06T00:01:01Z",
        }),
        msg("wake-answer", "assistant", [text("Both plans are out.")], {
          runId: "wake",
          createdAt: "2026-11-06T00:01:03Z",
        }),
      ],
      [prompt("run")],
      false,
      [wake],
    );
    expect(view.textContent).toContain("Subagent update · Total 4s");
    const buttons = copyButtonsIn(view);
    expect([...buttons.keys()]).toEqual(["user-run", "answer", "wake-answer"]);
    const persistent = view.querySelector(".ohb-message-actions.is-persistent");
    expect(
      persistent?.closest<HTMLElement>("[data-message-id]")?.dataset.messageId,
    ).toBe("wake-answer");
    const copy = buttons.get("wake-answer");
    if (!copy) throw new Error("no wake-up copy button");
    await click(copy);
    expect(writeText).toHaveBeenLastCalledWith("Both plans are out.");
  });

  it("copies a stopped reply's own text, not the stop note (T11)", async () => {
    const view = render(
      [
        msg("user-run", "user", [text("Explain")]),
        msg(
          "partial",
          "assistant",
          [
            text("The first half of the reply"),
            {
              ...text("[Response cancelled by the user.]"),
              metadata: { kind: "lifecycle-interruption" },
            },
          ],
          { status: "error" },
        ),
      ],
      [prompt("run", { status: "cancelled" })],
    );
    expect(view.textContent).toContain("[Response cancelled by the user.]");
    const copy = copyButtonsIn(view).get("partial");
    if (!copy) throw new Error("no copy button on the stopped reply");
    await click(copy);
    expect(writeText).toHaveBeenLastCalledWith("The first half of the reply");
  });

  it("gives only the closing reply of a run a copy button, even expanded (T11b)", () => {
    const view = render([
      msg("user-run", "user", [text("Fix it")]),
      msg("interim", "assistant", [
        text("Found the cause; now patching."),
        {
          type: "tool-call",
          call: { id: "c1", name: "edit", status: "completed", input: {} },
        },
      ]),
      msg("closing", "assistant", [text("Patched and tested.")]),
    ]);
    const disclosure = view.querySelector<HTMLButtonElement>(
      "button.ohb-prompt-duration",
    );
    act(() => {
      disclosure?.click();
    });
    expect([...copyButtonsIn(view).keys()]).toEqual(["user-run", "closing"]);
  });
});
