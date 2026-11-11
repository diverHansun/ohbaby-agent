// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiMessage, UiPromptSubmission } from "ohbaby-sdk";
import { ConversationStream } from "./ConversationStream.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

const at = "2026-11-06T00:00:01Z";

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
    text: `question ${runId}`,
    status: "succeeded",
    runId,
    createdAt: at,
    updatedAt: at,
    endedAt: at,
    ...patch,
  };
}

function msg(
  id: string,
  role: UiMessage["role"],
  runId: string,
  patch: Partial<UiMessage> = {},
): UiMessage {
  return {
    id,
    role,
    createdAt: at,
    status: "completed",
    // Like the server, user messages carry no run id; their prompt does.
    ...(role === "user" ? {} : { runId }),
    parts: [{ type: "text", text: id }],
    ...patch,
  };
}

const send = vi.fn(() => Promise.resolve(null));

function render(
  messages: readonly UiMessage[],
  prompts: readonly UiPromptSubmission[],
  options: {
    readonly variant?: "side-chat";
    readonly unavailable?: string;
    readonly isRunning?: boolean;
  } = {},
): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  act(() => {
    createRoot(container).render(
      <ConversationStream
        historyState="ready"
        historyHasMore={false}
        historyStale={false}
        onLoadHistory={() => Promise.resolve()}
        promptRows={[]}
        messages={messages}
        sessionId="session"
        prompts={prompts}
        activeRun={undefined}
        isRunning={options.isRunning ?? false}
        reasoningByMessageId={{}}
        commandNotices={null}
        variant={options.variant}
        onFork={() => Promise.resolve()}
        edit={{
          unavailable: options.unavailable,
          stateHints: [],
          send,
        }}
      />,
    );
  });
  return container;
}

function buttons(container: HTMLElement, label: string): HTMLButtonElement[] {
  return [
    ...container.querySelectorAll<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
    ),
  ];
}

const turn = [msg("user-a", "user", "a"), msg("answer-a", "assistant", "a")];

describe("Edit and Fork buttons (rewind T18, fork T15)", () => {
  it("puts Edit on user messages and Fork on final answers", () => {
    const container = render(turn, [prompt("a")]);
    expect(buttons(container, "Edit")).toHaveLength(1);
    expect(buttons(container, "Fork from here")).toHaveLength(1);
  });

  it("shows Edit on the user message of a running turn", () => {
    const container = render(
      [msg("user-a", "user", "a")],
      [prompt("a", { status: "running", endedAt: undefined })],
      { isRunning: true },
    );
    expect(buttons(container, "Edit")).toHaveLength(1);
  });

  it("leaves Edit off steer messages and messages without a prompt", () => {
    const container = render(
      [
        ...turn,
        msg("steer", "user", "a", { runtimeInputKind: "user-steer" }),
        msg("orphan", "user", "b"),
      ],
      [prompt("a")],
    );
    expect(buttons(container, "Edit")).toHaveLength(1);
  });

  it("offers neither in a side chat", () => {
    const container = render(turn, [prompt("a")], { variant: "side-chat" });
    expect(buttons(container, "Edit")).toHaveLength(0);
    expect(buttons(container, "Fork from here")).toHaveLength(0);
  });

  it("dims Edit while the chat compacts", () => {
    const container = render(turn, [prompt("a")], {
      unavailable: "Compacting…",
    });
    const [edit] = buttons(container, "Edit");
    expect(edit.disabled).toBe(true);
    expect(edit.title).toBe("Compacting…");
  });

  it("edits in place: one bubble, Esc restores, empty text cannot send", () => {
    const container = render(
      [...turn, msg("user-b", "user", "b"), msg("answer-b", "assistant", "b")],
      [prompt("a"), prompt("b")],
    );
    act(() => {
      buttons(container, "Edit")[0].click();
    });
    const editor = container.querySelector("form[aria-label='Edit message']");
    const textarea = editor?.querySelector("textarea");
    expect(textarea?.value).toBe("question a");
    expect(document.activeElement).toBe(textarea);
    expect(editor?.textContent).toContain(
      "File changes won't be undone · 1 later turn will be removed",
    );
    // Opening another bubble moves the editor: only one edits at a time.
    act(() => {
      buttons(container, "Edit")[0].click();
    });
    const forms = container.querySelectorAll("form[aria-label='Edit message']");
    expect(forms).toHaveLength(1);
    const moved = forms[0].querySelector("textarea");
    expect(moved?.value).toBe("question b");
    const sendButton = [...forms[0].querySelectorAll("button")].find(
      (button) => button.textContent === "Send",
    );
    act(() => {
      // React tracks the value; set it the way a user's typing would.
      if (moved)
        Reflect.set(
          Object.getPrototypeOf(moved) as object,
          "value",
          "   ",
          moved,
        );
      moved?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(sendButton?.disabled).toBe(true);
    act(() => {
      moved?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(container.querySelector("form[aria-label='Edit message']")).toBe(
      null,
    );
    expect(send).not.toHaveBeenCalled();
  });
});
