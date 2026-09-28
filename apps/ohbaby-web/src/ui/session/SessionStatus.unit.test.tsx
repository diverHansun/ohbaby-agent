// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { StatusBar } from "./SessionStatus.js";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
it("uses the existing status slot for a short Waiting label and keeps counts in its title", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    act(() => {
      root.render(
        <StatusBar
          activeGoal={null}
          onOpenGoalPanel={() => undefined}
          sessionId={null}
          waitingSummary="Waiting for subagents 1 done 3 open"
          header={{
            connectionKind: "running",
            statusLabel: "running",
            modelLabel: "glm",
            contextLabel: "",
            contextRatio: 0,
            contextWindowUsage: null,
          }}
        />,
      );
    });
    const status = container.querySelector(".ohb-status-pill");
    expect(status?.textContent).toBe("Waiting");
    expect(status?.getAttribute("title")).toContain("1 done 3 open");
    expect(container.textContent).not.toContain("1 done");
    expect(container.querySelectorAll(".ohb-status-pill")).toHaveLength(1);
  } finally {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
});
