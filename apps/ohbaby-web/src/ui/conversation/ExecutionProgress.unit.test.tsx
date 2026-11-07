// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { PromptDuration } from "./ExecutionProgress.js";
import type { TurnTiming } from "./run-process.js";
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
it("shows the result and total, labels non-user turns, and never times a recovered closure", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const timing: TurnTiming = {
    id: "turn",
    startedAt: "2026-01-02T00:00:00Z",
    endedAt: "2026-01-02T00:00:02Z",
    status: "interrupted",
    recovered: false,
  };
  try {
    act(() => {
      root.render(<PromptDuration timing={timing} />);
    });
    expect(container.textContent).toBe("interrupted · Total 2s");
    act(() => {
      root.render(
        <PromptDuration
          timing={{ ...timing, status: "succeeded" }}
          label="Subagent update"
        />,
      );
    });
    expect(container.textContent).toBe("Subagent update · Total 2s");
    act(() => {
      root.render(
        <PromptDuration
          timing={{
            id: "turn",
            endedAt: timing.endedAt,
            status: "interrupted",
            recovered: true,
          }}
        />,
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
