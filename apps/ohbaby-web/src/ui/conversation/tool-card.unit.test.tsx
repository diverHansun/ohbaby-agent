// @vitest-environment jsdom
import type { UiMessagePart, UiToolCall, UiToolResult } from "ohbaby-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurationSampleContext } from "./use-execution-duration.js";
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

  it("replaces a result-only window with one paired entry when its call arrives", () => {
    const result: UiToolResult = {
      callId: "call_bash",
      output: "saved",
      execution: {
        phase: "ended",
        createdAt: 1,
        phaseStartedAt: 3,
        executionStartedAt: 2,
        endedAt: 3,
        outcome: "success",
      },
    };
    expect(pairToolParts([{ type: "tool-result", result }])).toEqual([
      { kind: "orphan-result", result, sourceIndex: 0 },
    ]);
    expect(
      pairToolParts([
        { type: "tool-call", call: toolCall({ status: "completed" }) },
        { type: "tool-result", result },
      ]),
    ).toEqual([
      {
        kind: "tool",
        call: toolCall({ status: "completed" }),
        result,
        sourceIndex: 0,
      },
    ]);
  });
});

describe("ToolCard", () => {
  it("animates only real executing and freezes the execution duration at logical end", () => {
    const execution = {
      phase: "executing" as const,
      phaseStartedAt: 1000,
      createdAt: 0,
      executionStartedAt: 1000,
    };
    const app = mountCard(toolCall({ execution }), undefined);
    expect(
      app.container.querySelector(".ohb-tool-executing")?.textContent,
    ).toBe("bash");
    renderCard(
      app.root,
      toolCall({
        execution: {
          ...execution,
          phase: "queued",
          waitReason: "resource",
          executionStartedAt: undefined,
        },
      }),
      undefined,
    );
    expect(app.container.querySelector(".ohb-tool-executing")).toBeNull();
    expect(app.container.querySelector(".ohb-tool-duration")).toBeNull();
    act(() => {
      app.container.querySelector("button")?.click();
    });
    expect(app.container.textContent).toContain("resource");
    renderCard(
      app.root,
      toolCall({
        status: "failed",
        execution: {
          ...execution,
          phase: "ended",
          endedAt: 62000,
          outcome: "cancelled",
          cleanup: "in-progress",
        },
      }),
      undefined,
    );
    expect(app.container.querySelector(".ohb-tool-executing")).toBeNull();
    expect(
      app.container.querySelector(".ohb-tool-duration")?.textContent,
    ).toContain("1m 1s");
    expect(
      app.container.querySelector("button")?.getAttribute("aria-label"),
    ).toContain("cancelled");
    expect(app.container.textContent).not.toContain("⚠");
    expect(
      app.container.querySelector(".ohb-tool-details")?.textContent,
    ).toContain("cancelled");
  });

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

  it("renders an orphan result with its own execution without exposing its call id", () => {
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
            execution: {
              phase: "ended",
              createdAt: 1000,
              phaseStartedAt: 3000,
              executionStartedAt: 1000,
              endedAt: 3000,
              outcome: "error",
            },
          }}
        />,
      );
    });

    expect(container.textContent).toContain("tool result");
    expect(container.textContent).not.toContain("internal_call_id");
    expect(container.textContent).not.toContain("failed internally");
    act(() => container.querySelector("button")?.click());
    expect(container.textContent).toContain('"outcome": "error"');
    expect(container.querySelector(".ohb-tool-duration")?.textContent).toBe(
      "2s",
    );
  });

  it.each(["error", "cancelled", "timed-out"] as const)(
    "keeps Bash %s details without the warning decoration",
    (outcome) => {
      const app = mountCard(
        toolCall({
          status: "failed",
          execution: {
            phase: "ended",
            createdAt: 1000,
            phaseStartedAt: 4000,
            executionStartedAt: 1000,
            endedAt: 4000,
            outcome,
          },
        }),
        { callId: "call_bash", error: "real error", output: "partial output" },
      );
      expect(app.container.textContent).not.toContain("⚠");
      expect(
        app.container.querySelector(".ohb-tool-panel")?.classList,
      ).toContain("ohb-tool-red");
      expect(
        app.container.querySelector(".ohb-tool-duration")?.textContent,
      ).toBe("3s");
      expect(
        app.container.querySelector("button")?.getAttribute("aria-label"),
      ).toContain(outcome);
      act(() => app.container.querySelector("button")?.click());
      expect(app.container.textContent).toContain("real error");
      expect(app.container.textContent).toContain(outcome);
    },
  );

  it("keeps the existing abnormal decoration for other tools", () => {
    const app = mountCard(
      {
        ...toolCall({
          status: "failed",
          execution: {
            phase: "ended",
            createdAt: 1,
            phaseStartedAt: 2,
            outcome: "error",
          },
        }),
        name: "web_fetch",
      },
      undefined,
    );
    expect(app.container.textContent).toContain("⚠");
  });

  it("colors a terminal failure from execution facts before call or result status catches up", () => {
    const execution = {
      phase: "ended" as const,
      createdAt: 1,
      phaseStartedAt: 2,
      endedAt: 2,
      outcome: "timed-out" as const,
    };
    const app = mountCard(
      toolCall({ status: "running", execution }),
      undefined,
    );
    expect(app.container.querySelector(".ohb-tool-panel")?.classList).toContain(
      "ohb-tool-red",
    );
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

it("uses independent server durations across rerenders, remounts, and logical completion", () => {
  let now = 100;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  const app = mountCard(toolCall(), undefined);
  const sample = { serverNow: 5000, receivedAt: 100 };
  const execution = {
    phase: "executing" as const,
    createdAt: 0,
    phaseStartedAt: 1000,
    executionStartedAt: 1000,
  };
  const draw = (endedAt?: number): void => {
    act(() => {
      app.root.render(
        <DurationSampleContext.Provider value={sample}>
          <ToolCard
            call={toolCall({
              execution: {
                ...execution,
                ...(endedAt === undefined
                  ? {}
                  : { phase: "ended", endedAt, outcome: "success" }),
              },
            })}
            result={undefined}
          />
          <ToolCard
            call={toolCall({
              id: "second",
              execution: { ...execution, executionStartedAt: 4000 },
            })}
            result={undefined}
          />
        </DurationSampleContext.Provider>,
      );
    });
  };
  try {
    draw();
    expect(
      [...app.container.querySelectorAll(".ohb-tool-duration")].map(
        (node) => node.textContent,
      ),
    ).toEqual(["4s", "1s"]);
    now = 3100;
    draw();
    expect(
      [...app.container.querySelectorAll(".ohb-tool-duration")].map(
        (node) => node.textContent,
      ),
    ).toEqual(["7s", "4s"]);
    act(() => {
      app.root.render(null);
    });
    draw();
    expect(app.container.querySelector(".ohb-tool-duration")?.textContent).toBe(
      "7s",
    );
    draw(6000);
    now = 100100;
    draw(6000);
    expect(app.container.querySelector(".ohb-tool-duration")?.textContent).toBe(
      "5s",
    );
  } finally {
    clock.mockRestore();
  }
});

it("reports an invalid clock once per anchor and never invents an active duration without a sample", () => {
  const diagnostic = vi
    .spyOn(console, "error")
    .mockImplementation(() => undefined);
  try {
    const execution = {
      phase: "executing" as const,
      createdAt: 0,
      phaseStartedAt: 5000,
      executionStartedAt: 5000,
    };
    const app = mountCard(toolCall({ execution }), undefined);
    expect(app.container.querySelector(".ohb-tool-duration")).toBeNull();
    const sample = { serverNow: 1000, receivedAt: performance.now() };
    const draw = (): void => {
      act(() => {
        app.root.render(
          <DurationSampleContext.Provider value={sample}>
            <ToolCard call={toolCall({ execution })} result={undefined} />
          </DurationSampleContext.Provider>,
        );
      });
    };
    draw();
    draw();
    expect(app.container.querySelector(".ohb-tool-duration")?.textContent).toBe(
      "0s",
    );
    expect(diagnostic).toHaveBeenCalledTimes(1);
    expect(String(diagnostic.mock.calls[0][0])).toContain("duration-clock");
  } finally {
    diagnostic.mockRestore();
  }
});

it.each(["bash", "web_fetch", "subagent_status"])(
  "keeps legacy %s details without an execution block or invented duration",
  (name) => {
    const app = mountCard(
      { ...toolCall({ status: "completed" }), name },
      { callId: "call_bash", output: "saved output" },
    );
    const note = "Execution stage history is unavailable for this tool.";
    expect(app.container.textContent).not.toContain(note);
    act(() => app.container.querySelector("button")?.click());
    expect(app.container.textContent).not.toContain(note);
    expect(
      app.container.querySelector(".ohb-tool-details")?.textContent,
    ).toContain("saved output");
    expect(
      app.container.querySelector(".ohb-tool-details")?.textContent,
    ).not.toContain("Execution");
    expect(app.container.querySelector(".ohb-tool-duration")).toBeNull();
    expect(app.container.querySelector(".ohb-tool-executing")).toBeNull();
  },
);
