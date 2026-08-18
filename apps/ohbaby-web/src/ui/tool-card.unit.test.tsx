// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { UiMessagePart, UiToolCall, UiToolResult } from "ohbaby-sdk";
import { OrphanToolResultCard, pairToolParts, ToolCard } from "./tool-card.js";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { readonly container: HTMLDivElement; readonly root: Root }[] =
  [];

interface MountedCard {
  readonly container: HTMLDivElement;
  readonly root: Root;
}

afterEach(() => {
  for (const app of mounted.splice(0)) {
    act(() => {
      app.root.unmount();
    });
    app.container.remove();
  }
});

describe("pairToolParts", () => {
  it("pairs a tool call and result into one transcript entry", () => {
    const parts: readonly UiMessagePart[] = [
      { text: "before", type: "text" },
      { call: toolCall({ status: "completed" }), type: "tool-call" },
      {
        result: { callId: "call_bash", output: "done" },
        type: "tool-result",
      },
      { text: "after", type: "text" },
    ];

    expect(pairToolParts(parts)).toEqual([
      { kind: "part", part: parts[0], sourceIndex: 0 },
      {
        call: toolCall({ status: "completed" }),
        kind: "tool",
        result: { callId: "call_bash", output: "done" },
        sourceIndex: 1,
      },
      { kind: "part", part: parts[3], sourceIndex: 3 },
    ]);
  });

  it("keeps an orphan result as a defensive fallback", () => {
    const result = { callId: "missing", error: "failed", output: "stderr" };
    expect(pairToolParts([{ result, type: "tool-result" }])).toEqual([
      { kind: "orphan-result", result, sourceIndex: 0 },
    ]);
  });
});

describe("ToolCard", () => {
  it("shows a short failed result expanded without exposing its call id", () => {
    const app = mountCard(toolCall({ status: "failed" }), {
      callId: "call_bash",
      error: "exit code 1",
      output: "stderr text",
    });

    expect(app.container.textContent).toContain("bash");
    expect(app.container.textContent).toContain("failed");
    expect(app.container.textContent).toContain("sleep 10");
    expect(app.container.textContent).toContain("stderr text");
    expect(app.container.textContent).not.toContain("call_bash");
  });

  it("auto-opens once when a running call transitions to a short failure", () => {
    const app = mountCard(toolCall({ status: "running" }), undefined);
    expect(app.container.querySelector("pre")).toBeNull();

    renderCard(app.root, toolCall({ status: "failed" }), {
      callId: "call_bash",
      error: "timed out",
      output: "partial output",
    });
    expect(app.container.querySelector("pre")?.textContent).toBe(
      "partial output",
    );

    act(() => {
      app.container.querySelector("button")?.click();
    });
    expect(app.container.querySelector("pre")).toBeNull();

    renderCard(app.root, toolCall({ status: "failed" }), {
      callId: "call_bash",
      error: "timed out",
      output: "more output",
    });
    expect(app.container.querySelector("pre")).toBeNull();
  });

  it.each([
    ["400 characters", "x".repeat(400), true],
    ["401 characters", "x".repeat(401), false],
    ["8 lines", Array.from({ length: 8 }, () => "x").join("\n"), true],
    ["9 lines", Array.from({ length: 9 }, () => "x").join("\n"), false],
  ] as const)(
    "applies the short failure boundary for %s",
    (_label, output, expectedOpen) => {
      const app = mountCard(toolCall({ status: "failed" }), {
        callId: "call_bash",
        error: "failed",
        output,
      });

      expect(app.container.querySelector("pre") !== null).toBe(expectedOpen);
    },
  );

  it("falls back to the error when failed output is empty", () => {
    const app = mountCard(toolCall({ status: "failed" }), {
      callId: "call_bash",
      error: "permission denied",
      output: "",
    });

    expect(app.container.querySelector("pre")?.textContent).toBe(
      "permission denied",
    );
  });

  it("renders an orphan result without exposing its call id", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push({ container, root });

    act(() => {
      root.render(
        <OrphanToolResultCard
          result={{ callId: "internal_call_id", output: "visible output" }}
        />,
      );
    });

    expect(container.textContent).toContain("tool result");
    expect(container.textContent).not.toContain("internal_call_id");
  });
});

function toolCall(patch: Partial<UiToolCall> = {}): UiToolCall {
  return {
    id: "call_bash",
    input: { command: "sleep 10" },
    name: "bash",
    status: "running",
    ...patch,
  };
}

function mountCard(
  call: UiToolCall,
  result: UiToolResult | undefined,
): MountedCard {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const app = { container, root };
  mounted.push(app);
  renderCard(root, call, result);
  return app;
}

function renderCard(
  root: Root,
  call: UiToolCall,
  result: UiToolResult | undefined,
): void {
  act(() => {
    root.render(<ToolCard call={call} result={result} />);
  });
}
