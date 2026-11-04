// @vitest-environment jsdom
import type { UiContextWindowUsage } from "ohbaby-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
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

function render(
  usageValue: UiContextWindowUsage | null,
  sessionId = usageValue?.sessionId ?? "session_1",
): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      <ContextUsageControl sessionId={sessionId} usage={usageValue} />,
    );
  });
  return container;
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("ContextUsageControl", () => {
  it("keeps an honest empty ring when usage is unavailable", () => {
    const container = render(null);
    const trigger = container.querySelector(".ohb-context-ring-button");
    if (!trigger) {
      throw new Error("context trigger missing");
    }

    expect(trigger.getAttribute("aria-label")).toBe(
      "Context usage unavailable",
    );
    expect(container.querySelector(".ohb-context-ring-progress")).toBeNull();
    click(trigger);

    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
      "Usage data is not available yet.",
    );
  });

  it("keeps the ring blue until it turns orange at 70%", () => {
    const at = (ratio: number): string | undefined =>
      render({
        ...usage(false),
        contextWindowRatio: ratio,
        currentTokens: ratio * 100_000,
      }).querySelector(".ohb-context-usage-control")?.className;
    expect(at(0.69)).not.toContain("is-warning");
    expect(at(0.7)).toContain("is-warning");
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

  it("renders non-empty rows in fixed order with tokens and window share", () => {
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
      "System prompt10K10.0%",
      "Built-in tools5K5.0%",
      "MCP tools2K2.0%",
      "Skills1K1.0%",
      "Conversation15K15.0%",
      "Summarized conversation4K4.0%",
    ]);
    expect(
      container.querySelectorAll(".ohb-context-stack-segment"),
    ).toHaveLength(6);
  });

  it("shows one decimal and a floor for tiny shares", () => {
    const base = usage(true);
    if (!base.composition) throw new Error("composition missing");
    const container = render({
      ...base,
      composition: { ...base.composition, mcp: 1_234, skills: 50 },
    });
    const trigger = container.querySelector(".ohb-context-ring-button");
    if (!trigger) throw new Error("context trigger missing");
    click(trigger);

    const text = Array.from(
      container.querySelectorAll(".ohb-context-composition-percent"),
    ).map((cell) => cell.textContent);
    expect(text).toContain("1.2%");
    expect(text).toContain("<0.1%");
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
          sessionId="session_2"
          usage={{ ...usage(true), sessionId: "session_2" }}
        />,
      );
    });

    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("closes unavailable detail when the active session changes", () => {
    const container = render(null, "session_1");
    const root = roots.at(-1);
    const trigger = container.querySelector(".ohb-context-ring-button");
    if (!root || !trigger) {
      throw new Error("context test fixture missing");
    }
    click(trigger);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    act(() => {
      root.render(<ContextUsageControl sessionId="session_2" usage={null} />);
    });

    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});

it("keeps the open popover when asynchronous context usage arrives", () => {
  const container = render(null);
  const root = roots.at(-1);
  if (!root) throw new Error("root missing");
  const trigger = container.querySelector(".ohb-context-ring-button");
  if (!trigger) throw new Error("context trigger missing");
  click(trigger);
  act(() => {
    root.render(
      <ContextUsageControl sessionId="session_1" usage={usage(false)} />,
    );
  });
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
    "~37K / 100K",
  );
});

it("keeps cache out of context details", () => {
  const container = render(usage(true));
  const trigger = container.querySelector(".ohb-context-ring-button");
  if (!trigger) throw new Error("context trigger missing");
  click(trigger);
  expect(container.querySelector('[role="dialog"]')?.textContent).not.toContain(
    "Cache",
  );
});
