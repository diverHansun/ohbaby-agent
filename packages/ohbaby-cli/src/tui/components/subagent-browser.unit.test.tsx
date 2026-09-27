import { render } from "ink-testing-library";
import { expect, it, vi } from "vitest";
import { SubagentBrowser } from "./subagent-browser.js";
import { AppShell } from "../layout/app-shell.js";
import { createSubagentReader, type UiSubagentReaderState } from "ohbaby-sdk";
it("renders read-only child text, reasoning and complete tool bodies and returns with Escape", async () => {
  const reader = createSubagentReader({}, "root");
  const close = vi.fn();
  const state: UiSubagentReaderState = {
    loading: false,
    selectedId: "execution",
    view: {
      execution: {
        executionId: "execution",
        subagentId: "agent",
        rootSessionId: "root",
        rootRunId: "run",
        status: "completed",
        createdAt: 1,
        updatedAt: 2,
        resultStored: true,
        delivery: "processed",
        processedRequestId: "request",
      },
      readOnly: true,
      reasoningMissing: false,
      history: { hasMore: false },
      messages: [
        {
          id: "m",
          role: "assistant",
          createdAt: "2026-01-01",
          parts: [
            { type: "reasoning", text: "full reasoning" },
            {
              type: "tool-call",
              call: {
                id: "t",
                name: "read",
                input: { path: "file" },
                status: "completed",
              },
            },
            {
              type: "tool-result",
              result: { callId: "t", output: "complete body" },
            },
          ],
        },
      ],
    },
  };
  const app = render(
    <AppShell>
      <SubagentBrowser reader={reader} state={state} onClose={close} />
    </AppShell>,
  );
  expect(app.lastFrame()).toContain("Read only");
  expect(app.lastFrame()).toContain("full reasoning");
  expect(app.lastFrame()).toContain("complete body");
  expect(app.lastFrame()).toContain("Processed request: request");
  await new Promise((resolve) => setTimeout(resolve, 10));
  app.stdin.write("\u001b");
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(reader.getSnapshot().selectedId).toBeUndefined();
  expect(close).not.toHaveBeenCalled();
  app.unmount();
  reader.dispose();
});
