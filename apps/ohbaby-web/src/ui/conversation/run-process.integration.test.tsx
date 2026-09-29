// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import type {
  UiEvent,
  UiMessage,
  UiPromptSubmission,
  UiSnapshot,
} from "ohbaby-sdk";
import {
  reduceUiEvent,
  replaceSnapshot,
} from "../../api/daemon/eventReducer.js";
import { ConversationStream } from "./ConversationStream.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const time = "2026-09-29T00:00:00Z";
const prompt: UiPromptSubmission = {
  promptId: "p",
  clientRequestId: "c",
  scopeKey: "scope",
  sessionId: "s",
  userMessageId: "u",
  text: "Read note",
  status: "running",
  runId: "r",
  createdAt: time,
  updatedAt: time,
};
const snapshot: UiSnapshot = {
  activeSessionId: "s",
  permission: { level: "default", mode: "auto", sessionRules: [] },
  permissions: [],
  runs: [],
  prompts: [prompt],
  status: { kind: "idle" },
  sessions: [
    {
      id: "s",
      title: "test",
      createdAt: time,
      updatedAt: time,
      messages: [
        {
          id: "u",
          role: "user",
          createdAt: time,
          parts: [{ type: "text", text: "Read note" }],
        },
      ],
    },
  ],
};
const progress: UiMessage = {
  id: "progress",
  runId: "r",
  role: "assistant",
  createdAt: time,
  status: "completed",
  parts: [
    { type: "text", text: "Reading the file." },
    {
      type: "tool-call",
      call: {
        id: "read1",
        name: "read",
        input: { file_path: "note.md" },
        status: "completed",
      },
    },
    {
      type: "tool-result",
      result: { callId: "read1", output: "Cedar" },
    },
  ],
};
const answer: UiMessage = {
  id: "answer",
  runId: "r",
  role: "assistant",
  createdAt: time,
  status: "streaming",
  parts: [
    { id: "thought", type: "reasoning", text: "Check the release" },
    { id: "text", type: "text", text: "Project: Cedar" },
  ],
};

it.each(["prompt-first", "message-first"])(
  "integrates projected streaming, tools, completion and history: %s",
  (order) => {
    let state = replaceSnapshot(snapshot, 0);
    let seq = 0;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = (): void => {
      const current = state.snapshot;
      if (!current) throw new Error("Missing snapshot");
      act(() => {
        root.render(
          <ConversationStream
            sessionId="s"
            messages={current.sessions[0].messages}
            prompts={current.prompts ?? []}
            reasoningByMessageId={state.reasoningByMessageId}
            activeRun={undefined}
            isRunning={false}
            promptRows={[]}
            historyState="ready"
            historyHasMore={false}
            historyStale={false}
            onLoadHistory={() => Promise.resolve()}
            commandNotices={null}
          />,
        );
      });
    };
    const emit = (event: UiEvent): void => {
      state = reduceUiEvent(state, event, ++seq);
      render();
    };
    const control = (): HTMLButtonElement | null =>
      container.querySelector<HTMLButtonElement>(".ohb-run-disclosure");
    try {
      emit({ type: "message.appended", sessionId: "s", message: progress });
      emit({ type: "message.appended", sessionId: "s", message: answer });
      expect(control()).toBeNull();
      const terminal: UiEvent = {
        type: "prompt.updated",
        prompt: {
          ...prompt,
          status: "succeeded",
          endedAt: "2026-09-29T00:00:10Z",
        },
      };
      const settled: UiEvent = {
        type: "message.updated",
        sessionId: "s",
        message: {
          ...answer,
          status: "completed",
          parts: [{ ...answer.parts[0], endReason: "normal" }, answer.parts[1]],
        },
      };
      emit(order === "prompt-first" ? terminal : settled);
      expect(control()).toBeNull();
      emit(order === "prompt-first" ? settled : terminal);
      expect(control()?.getAttribute("aria-expanded")).toBe("false");
      expect(
        container.querySelector<HTMLElement>('[data-message-id="progress"]')
          ?.hidden,
      ).toBe(true);
      expect(
        container
          .querySelector('[data-message-id="answer"] .ohb-markdown')
          ?.closest("[hidden]"),
      ).toBeNull();
      act(() => {
        control()?.click();
      });
      const tool = container.querySelector<HTMLButtonElement>(
        '[aria-label="read"]',
      );
      expect(
        container.querySelector<HTMLElement>('[data-message-id="progress"]')
          ?.hidden,
      ).toBe(false);
      if (!state.snapshot) throw new Error("Missing snapshot");
      state = replaceSnapshot(state.snapshot, ++seq);
      render();
      expect(control()?.getAttribute("aria-expanded")).toBe("true");
      if (tool) expect(container.contains(tool)).toBe(true);
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
  },
);
