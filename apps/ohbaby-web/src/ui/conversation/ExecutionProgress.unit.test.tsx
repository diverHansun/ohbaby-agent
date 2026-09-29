// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { PromptDuration } from "./ExecutionProgress.js";
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
it("counts from reacceptance and never calls a recovered closure the real execution duration", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const prompt = {
    promptId: "p",
    userMessageId: "u",
    clientRequestId: "c",
    sessionId: "s",
    scopeKey: "scope",
    text: "hi",
    status: "interrupted" as const,
    createdAt: "2026-01-01T00:00:00Z",
    acceptedAt: "2026-01-02T00:00:00Z",
    endedAt: "2026-01-02T00:00:02Z",
    updatedAt: "2026-01-02T00:00:02Z",
  };
  try {
    act(() => {
      root.render(<PromptDuration prompt={prompt} />);
    });
    expect(container.textContent).toContain("Total 2s");
    act(() => {
      root.render(
        <PromptDuration prompt={{ ...prompt, endTimeSource: "recovery" }} />,
      );
    });
    expect(container.textContent).toContain("End time unknown");
    expect(container.textContent).not.toContain("Total");
  } finally {
    act(() => {
      root.unmount();
    });
  }
});
