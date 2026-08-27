// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { UiContextWindowUsage } from "ohbaby-sdk";
import { ContextUsageControl } from "./ContextUsage.js";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => {
      root.unmount();
    });
  }
  document.body.replaceChildren();
});

function usage(withComposition: boolean): UiContextWindowUsage {
  return {
    ...(withComposition
      ? {
          composition: {
            "system-prompt": 10_000,
            "builtin-tools": 5_000,
            mcp: 2_000,
            skills: 1_000,
            conversation: 15_000,
            "summarized-conversation": 4_000,
            "subagent-exchanges": 0,
          },
        }
      : {}),
    contextWindowRatio: 0.37,
    contextWindowTokens: 100_000,
    currentTokens: 37_000,
    estimatedAt: "2026-08-27T00:00:00.000Z",
    modelId: "model-a",
    sessionId: "session_1",
  };
}

function render(usageValue: UiContextWindowUsage | null): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(<ContextUsageControl usage={usageValue} />);
  });
  return container;
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("ContextUsageControl", () => {
  it("does not render an empty ring when usage is unavailable", () => {
    const container = render(null);

    expect(container.querySelector("button")).toBeNull();
  });

  it("opens a total-only detail without inventing composition rows", () => {
    const container = render(usage(false));
    const trigger = container.querySelector(".ohb-context-ring-button");
    if (!trigger) {
      throw new Error("context trigger missing");
    }

    expect(trigger.getAttribute("aria-label")).toContain("37% context used");
    click(trigger);

    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
      "~37K / 100K",
    );
    expect(container.querySelector(".ohb-context-composition")).toBeNull();
  });

  it("renders all seven rows in order, including a zero category", () => {
    const container = render(usage(true));
    const trigger = container.querySelector(".ohb-context-ring-button");
    if (!trigger) {
      throw new Error("context trigger missing");
    }
    click(trigger);

    const rows = Array.from(
      container.querySelectorAll(".ohb-context-composition-row"),
    ).map((row) => row.textContent);
    expect(rows).toEqual([
      "System prompt~10K",
      "Built-in tools~5K",
      "MCP tools~2K",
      "Skills~1K",
      "Conversation~15K",
      "Summarized conversation~4K",
      "Subagent exchanges~0",
    ]);
    expect(
      container.querySelectorAll(".ohb-context-stack-segment"),
    ).toHaveLength(6);
  });

  it("closes the detail with Escape and outside pointer input", () => {
    const container = render(usage(true));
    const trigger = container.querySelector(".ohb-context-ring-button");
    if (!trigger) {
      throw new Error("context trigger missing");
    }
    click(trigger);
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    click(trigger);
    act(() => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("does not carry an open detail across sessions", () => {
    const container = render(usage(true));
    const root = roots.at(-1);
    const trigger = container.querySelector(".ohb-context-ring-button");
    if (!root || !trigger) {
      throw new Error("context test fixture missing");
    }
    click(trigger);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    act(() => {
      root.render(
        <ContextUsageControl
          usage={{ ...usage(true), sessionId: "session_2" }}
        />,
      );
    });

    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});
