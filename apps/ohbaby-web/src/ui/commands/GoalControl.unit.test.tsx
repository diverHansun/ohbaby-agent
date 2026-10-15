// @vitest-environment jsdom
import type { UiCommandCompletion, UiGoal } from "ohbaby-sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import {
  type ExecuteGoalCommand,
  GoalComposerStrip,
  type GoalPanelIntent,
} from "./GoalControl.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function fixture(): {
  container: HTMLDivElement;
  execute: ReturnType<typeof vi.fn<ExecuteGoalCommand>>;
  openPanel: ReturnType<typeof vi.fn<(intent?: GoalPanelIntent) => void>>;
  render(goal: UiGoal | null, sessionId?: string): void;
  settle(outcome: "failure" | "rejection"): Promise<void>;
  dispose(): void;
} {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let resolve: (completion: UiCommandCompletion) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const pending = new Promise<UiCommandCompletion>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  const execute = vi.fn<ExecuteGoalCommand>(() => pending);
  const openPanel = vi.fn<(intent?: GoalPanelIntent) => void>();
  return {
    container,
    execute,
    openPanel,
    render(goal, sessionId = "session_1"): void {
      act(() => {
        root.render(
          <GoalComposerStrip
            goal={goal}
            onExecuteSlashCommand={execute}
            onOpenGoalPanel={openPanel}
            scopeKey={`/repo:${sessionId}`}
            sessionId={sessionId}
          />,
        );
      });
    },
    async settle(outcome): Promise<void> {
      await act(async () => {
        if (outcome === "rejection") reject(new Error("Old resume failed"));
        else
          resolve({
            status: "failed",
            commandRunId: "old_resume",
            clientInvocationId: "old_resume_invocation",
            outputCount: 0,
            eventCount: 1,
            error: { code: "budget_reached", message: "Old resume failed" },
          });
        await Promise.resolve();
      });
    },
    dispose(): void {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

const oldGoal: UiGoal = {
  objective: "Finish the old objective",
  status: "paused",
  turnsUsed: 2,
  wallClockMs: 3000,
};

const newGoal: UiGoal = {
  objective: "Finish the new objective",
  status: "active",
  turnsUsed: 1,
  wallClockMs: 1000,
};

function toggle(container: ParentNode): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    '[data-goal-strip-action="pause"], [data-goal-strip-action="resume"]',
  );
  if (!button) throw new Error("Goal toggle missing");
  return button;
}

describe("goal strip request ownership", () => {
  it.each(
    (["cleared goal", "changed objective", "changed session"] as const).flatMap(
      (change) =>
        (["failure", "rejection"] as const).map((outcome) => ({
          change,
          outcome,
        })),
    ),
  )("ignores a stale $outcome after $change", async ({ change, outcome }) => {
    const f = fixture();
    try {
      f.render(oldGoal);
      act(() => {
        toggle(f.container).click();
      });
      expect(f.execute).toHaveBeenCalledWith({
        allowOverlay: true,
        sessionId: "session_1",
        text: "/goal resume",
      });
      expect(toggle(f.container).disabled).toBe(true);

      if (change === "cleared goal") f.render(null);
      f.render(
        change === "changed objective"
          ? newGoal
          : { ...newGoal, objective: oldGoal.objective },
        change === "changed session" ? "session_2" : "session_1",
      );
      expect(toggle(f.container).disabled).toBe(false);

      await f.settle(outcome);
      expect(f.openPanel).not.toHaveBeenCalled();
      expect(toggle(f.container).disabled).toBe(false);
    } finally {
      f.dispose();
    }
  });

  it("keeps an in-flight action owned by the same objective when progress changes", async () => {
    const f = fixture();
    try {
      f.render(oldGoal);
      act(() => {
        toggle(f.container).click();
      });
      f.render({ ...oldGoal, wallClockMs: 4000, turnsUsed: 3 });
      expect(toggle(f.container).disabled).toBe(true);

      await f.settle("failure");
      expect(f.openPanel).toHaveBeenCalledWith({
        action: "resume",
        errorMessage: "Old resume failed",
      });
      expect(toggle(f.container).disabled).toBe(false);
    } finally {
      f.dispose();
    }
  });
});
