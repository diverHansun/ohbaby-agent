// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { createSubagentReader, type UiSubagentReaderState } from "ohbaby-sdk";
import { SubagentView } from "./SubagentView.js";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
it("shows complete child process without composer or approval actions", () => {
  const element = document.createElement("div");
  const root = createRoot(element);
  const reader = createSubagentReader({}, "root");
  const state: UiSubagentReaderState = {
    loading: false,
    selectedId: "exec",
    view: {
      readOnly: true,
      execution: {
        executionId: "exec",
        subagentId: "worker",
        rootSessionId: "root",
        rootRunId: "run",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
        resultStored: false,
        delivery: "none",
      },
      history: { hasMore: false },
      reasoningMissing: false,
      messages: [
        {
          id: "m",
          role: "assistant",
          createdAt: "2026-01-01",
          parts: [
            { type: "reasoning", text: "reasoning " + "x".repeat(20000) },
            {
              type: "tool-call",
              call: {
                id: "tool",
                name: "read",
                input: { path: "/full/path" },
                status: "completed",
              },
            },
            {
              type: "tool-result",
              result: { callId: "tool", output: "entire " + "y".repeat(20000) },
            },
          ],
        },
      ],
    },
  };
  act(() => {
    root.render(<SubagentView reader={reader} state={state} />);
  });
  expect(element.textContent).toContain("x".repeat(20000));
  act(() =>
    element.querySelector<HTMLButtonElement>("button[aria-expanded]")?.click(),
  );
  expect(element.textContent).toContain("y".repeat(20000));
  expect(element.querySelector("textarea")).toBeNull();
  expect(element.querySelector('button[aria-label*="Approve"]')).toBeNull();
  expect(element.textContent).toContain("Back to root conversation");
  act(() => {
    root.unmount();
  });
  reader.dispose();
});
