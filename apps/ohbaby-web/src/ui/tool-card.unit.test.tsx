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
  it.each([
    ["read_file", "ohb-tool-gold"],
    ["write_file", "ohb-tool-green"],
    ["edit_file", "ohb-tool-green"],
    ["bash", "ohb-tool-blue"],
    ["web_search", "ohb-tool-blue"],
  ] as const)("keeps the semantic name color for %s", (name, className) => {
    const app = mountCard(
      { ...toolCall({ status: "completed" }), name },
      undefined,
    );

    expect(app.container.querySelector(".ohb-tool-panel")?.classList).toContain(
      className,
    );
  });

  it("uses the red name color for a failed tool without exposing status", () => {
    const app = mountCard(
      { ...toolCall({ status: "failed" }), name: "read_file" },
      {
        callId: "call_bash",
        error: "permission denied",
        output: "",
      },
    );

    expect(app.container.querySelector(".ohb-tool-panel")?.classList).toContain(
      "ohb-tool-red",
    );
    expect(app.container.textContent).not.toContain("failed");
    expect(
      app.container.querySelector("button")?.getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it.each(["subagent_run", "web_search", "bash"])(
    "uses the shared disclosure arrow for %s",
    (name) => {
      const app = mountCard(
        { ...toolCall({ status: "running" }), name },
        undefined,
      );
      const arrow = app.container.querySelector(".ohb-tool-chevron");
      expect(arrow?.tagName.toLowerCase()).toBe("svg");
    },
  );

  it("keeps a short failed result collapsed without exposing failure status", () => {
    const app = mountCard(toolCall({ status: "failed" }), {
      callId: "call_bash",
      error: "exit code 1",
      output: "stderr text",
    });

    expect(app.container.textContent).toContain("bash");
    expect(app.container.textContent).toContain("sleep 10");
    expect(app.container.textContent).not.toContain("failed");
    expect(app.container.textContent).not.toContain("stderr text");
    expect(app.container.textContent).not.toContain("call_bash");
    expect(
      app.container.querySelector("button")?.getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("stays collapsed when a running call transitions to failure", () => {
    const app = mountCard(toolCall({ status: "running" }), undefined);
    expect(app.container.querySelector("pre")).toBeNull();

    renderCard(app.root, toolCall({ status: "failed" }), {
      callId: "call_bash",
      error: "timed out",
      output: "partial output",
    });
    expect(app.container.querySelector("pre")).toBeNull();
  });

  it("shows input and the fallback error only after explicit expansion", () => {
    const app = mountCard(toolCall({ status: "failed" }), {
      callId: "call_bash",
      error: "permission denied",
      output: "",
    });

    expect(app.container.textContent).not.toContain("permission denied");
    act(() => {
      app.container.querySelector("button")?.click();
    });
    expect(
      app.container.querySelector(".ohb-tool-input")?.textContent,
    ).toContain('"command": "sleep 10"');
    expect(
      app.container.querySelector(".ohb-tool-output")?.textContent,
    ).toContain("permission denied");
  });

  it("keeps partial output and a distinct error together after expansion", () => {
    const app = mountCard(toolCall({ status: "failed" }), {
      callId: "call_bash",
      error: "exit code 1",
      output: "partial stderr",
    });

    act(() => {
      app.container.querySelector("button")?.click();
    });

    const output = app.container.querySelector(".ohb-tool-output")?.textContent;
    expect(output).toContain("partial stderr");
    expect(output).toContain("exit code 1");
  });

  it("renders an orphan result without exposing its call id", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push({ container, root });

    act(() => {
      root.render(
        <OrphanToolResultCard
          result={{
            callId: "internal_call_id",
            error: "failed internally",
            output: "visible output",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("tool result");
    expect(container.textContent).not.toContain("internal_call_id");
    expect(container.textContent).not.toContain("failed internally");
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
