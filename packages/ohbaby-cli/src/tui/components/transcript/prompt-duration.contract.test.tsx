import { render } from "ink-testing-library";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UiPromptSubmission, UiSnapshot } from "ohbaby-sdk";
import { createTuiStore } from "../../store/events.js";
import { CommittedTranscript } from "./committed-transcript.js";

const originalAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT;
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = originalAct;
});
const prompt: UiPromptSubmission = {
  promptId: "p",
  clientRequestId: "c",
  sessionId: "s",
  scopeKey: "scope",
  userMessageId: "u",
  runId: "r",
  text: "hello",
  status: "succeeded",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:01:01Z",
  endedAt: "2026-01-01T00:01:01Z",
};
function snapshot(status: UiPromptSubmission["status"]): UiSnapshot {
  return {
    activeSessionId: "s",
    permissions: [],
    runs: [],
    status: { kind: "idle" },
    prompts: [{ ...prompt, status }],
    sessions: [
      {
        id: "s",
        title: "s",
        createdAt: prompt.createdAt,
        updatedAt: prompt.updatedAt,
        messages: [
          {
            id: "u",
            role: "user",
            createdAt: prompt.createdAt,
            parts: [{ type: "text", text: "hello" }],
          },
          ...(status === "succeeded"
            ? [
                {
                  id: "a",
                  role: "assistant" as const,
                  runId: "r",
                  createdAt: prompt.updatedAt,
                  status: "completed" as const,
                  parts: [{ type: "text" as const, text: "final answer" }],
                },
              ]
            : []),
        ],
      },
    ],
  };
}
describe("TUI terminal prompt duration", () => {
  it.each(["succeeded", "failed", "cancelled", "interrupted"] as const)(
    "renders %s duration once across refresh and duplicate terminal events",
    (status) => {
      const original = snapshot(status);
      const store = createTuiStore(original);
      let app!: ReturnType<typeof render>;
      act(() => {
        app = render(
          <CommittedTranscript items={store.getState().committedItems} />,
        );
      });
      expect(app.lastFrame()).toContain("Total 1m 1s");
      if (status !== "succeeded") expect(app.lastFrame()).toContain(status);
      else
        expect((app.lastFrame() ?? "").indexOf("Total")).toBeGreaterThan(
          (app.lastFrame() ?? "").indexOf("final answer"),
        );
      act(() => {
        store.dispatch({
          type: "prompt.updated",
          prompt: { ...prompt, status },
        });
        app.rerender(
          <CommittedTranscript items={store.getState().committedItems} />,
        );
      });
      expect(app.lastFrame()?.match(/Total/g)).toHaveLength(1);
      act(() => {
        store.replaceSnapshot(original);
        app.rerender(
          <CommittedTranscript items={store.getState().committedItems} />,
        );
      });
      expect(app.lastFrame()?.match(/Total/g)).toHaveLength(1);
      act(() => {
        app.unmount();
      });
    },
  );
  it("does not fabricate duration without terminal timestamps", () => {
    const original = snapshot("running");
    const store = createTuiStore({
      ...original,
      prompts: [{ ...prompt, status: "running", endedAt: undefined }],
    });
    let app!: ReturnType<typeof render>;
    act(() => {
      app = render(
        <CommittedTranscript items={store.getState().committedItems} />,
      );
    });
    expect(app.lastFrame()).not.toContain("Total");
    act(() => {
      app.unmount();
    });
  });
});

it("adds a terminal marker when recovery supplies completion after an active snapshot", () => {
  const original = snapshot("running");
  const store = createTuiStore({
    ...original,
    prompts: [{ ...prompt, status: "running", endedAt: undefined }],
  });
  store.replaceSnapshot(snapshot("succeeded"));
  let app!: ReturnType<typeof render>;
  act(() => {
    app = render(
      <CommittedTranscript items={store.getState().committedItems} />,
    );
  });
  expect(app.lastFrame()).toContain("Total 1m 1s");
  act(() => {
    app.unmount();
  });
});

it("places recovered historical totals below their own replies when opening a session", () => {
  const first = snapshot("succeeded");
  const secondPrompt = {
    ...prompt,
    promptId: "p2",
    runId: "r2",
    userMessageId: "u2",
  };
  const store = createTuiStore({
    ...first,
    activeSessionId: null,
    prompts: [prompt, secondPrompt],
    sessions: [
      {
        ...first.sessions[0],
        messages: [
          ...first.sessions[0].messages,
          {
            id: "u2",
            role: "user",
            createdAt: prompt.endedAt ?? "",
            parts: [{ type: "text", text: "second question" }],
          },
          {
            id: "a2",
            role: "assistant",
            runId: "r2",
            createdAt: prompt.endedAt ?? "",
            parts: [{ type: "text", text: "second answer" }],
          },
        ],
      },
    ],
  });
  store.selectSession("s");
  let app!: ReturnType<typeof render>;
  act(() => {
    app = render(
      <CommittedTranscript items={store.getState().committedItems} />,
    );
  });
  const frame = app.lastFrame() ?? "";
  expect(frame.indexOf("Total")).toBeLessThan(frame.indexOf("second question"));
  expect(frame.match(/Total/g)).toHaveLength(2);
  act(() => {
    app.unmount();
  });
});
