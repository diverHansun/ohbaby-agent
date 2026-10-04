import type { ReactElement } from "react";
import { Box } from "ink";
import stringWidth from "string-width";
import {
  DurationDiagnosticContext,
  DurationSampleContext,
} from "./execution-duration.js";
import { render } from "ink-testing-library";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TuiRuntimeStatus } from "../store/snapshot.js";
import { WorkingSpinner } from "./working-spinner.js";
import { WORKING_PHRASES } from "./working-phrases.js";
import { SHIMMER_INTERVAL_MS } from "./shimmer-text.js";

const previousNoAnimation = process.env.OHBABY_TUI_NO_ANIM;
const previousActEnvironment = (
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  // Flat rendering makes the whole phrase contiguous in the captured frame.
  process.env.OHBABY_TUI_NO_ANIM = "1";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  if (previousNoAnimation === undefined) {
    delete process.env.OHBABY_TUI_NO_ANIM;
  } else {
    process.env.OHBABY_TUI_NO_ANIM = previousNoAnimation;
  }
});

const request = {
  requestId: "req",
  runId: "run_1",
  messageId: "m",
  purpose: "agent-step",
  step: 0,
  attempt: 0,
  startedAt: 1000,
  outcome: "running" as const,
};

function frameOf(runtime: TuiRuntimeStatus): string {
  let app: ReturnType<typeof render> | undefined;
  act(() => {
    app = render(
      <WorkingSpinner
        runtime={runtime}
        modelActivity={{
          ...request,
          purpose:
            runtime.kind === "running" && runtime.title
              ? "compaction"
              : "agent-step",
          runId: runtime.kind === "running" ? runtime.runId : "run_1",
        }}
      />,
    );
  });
  const frame = app?.lastFrame() ?? "";
  act(() => {
    app?.unmount();
  });
  return frame;
}

function matchedPhrase(frame: string): string | undefined {
  return WORKING_PHRASES.find((phrase) => frame.includes(phrase));
}

describe("WorkingSpinner", () => {
  it.each<TuiRuntimeStatus>([
    { kind: "idle" },
    { kind: "error", message: "boom", recoverable: true },
    { kind: "waiting-for-permission", requestId: "req_1" },
  ])("renders nothing when runtime is %o", (runtime) => {
    expect(frameOf(runtime).trim()).toBe("");
  });

  it("renders a single shimmering phrase while running", () => {
    const frame = frameOf({ kind: "running", runId: "run_1" });
    expect(frame).not.toContain("⠋");
    expect(matchedPhrase(frame)).toBeDefined();
  });

  it("does not treat compaction as model waiting", () => {
    const frame = frameOf({
      kind: "running",
      runId: "command_compact",
      title: "Compacting...",
    });
    expect(frame).toBe("");
    expect(matchedPhrase(frame)).toBeUndefined();
  });

  it("keeps the same phrase across re-renders within one turn", () => {
    let app: ReturnType<typeof render> | undefined;
    act(() => {
      app = render(
        <WorkingSpinner
          runtime={{ kind: "running", runId: "run_1" }}
          modelActivity={request}
        />,
      );
    });
    const phrase = matchedPhrase(app?.lastFrame() ?? "");
    expect(phrase).toBeDefined();

    act(() => {
      // New runtime object, same runId → same turn → same phrase.
      app?.rerender(
        <WorkingSpinner
          runtime={{ kind: "running", runId: "run_1" }}
          modelActivity={request}
        />,
      );
    });
    expect(app?.lastFrame()).toContain(phrase ?? "");

    act(() => {
      app?.unmount();
    });
  });

  it("picks a valid phrase for a new turn", () => {
    const frame = frameOf({ kind: "running", runId: "run_2" });
    expect(matchedPhrase(frame)).toBeDefined();
  });
});

it.each([20, 40])(
  "keeps long phrases and their timer on one row at %i columns",
  (columns) => {
    const sample = { serverNow: 2000, receivedAt: performance.now() };
    let app!: ReturnType<typeof render>;
    act(() => {
      app = render(
        <Box width={columns}>
          <DurationSampleContext.Provider value={sample}>
            <WorkingSpinner
              runtime={{
                kind: "running",
                runId: "run_1",
                title: WORKING_PHRASES[0],
              }}
              modelActivity={request}
            />
          </DurationSampleContext.Provider>
        </Box>,
      );
    });
    const frame = app.lastFrame() ?? "";
    expect(frame.split("\n")).toHaveLength(1);
    expect(frame).toContain(" · 1s");
    expect(stringWidth(frame)).toBeLessThanOrEqual(columns);
    act(() => {
      app.unmount();
    });
  },
);

it("hides the heartbeat during startup and after first body text", () => {
  let app!: ReturnType<typeof render>;
  act(() => {
    app = render(
      <WorkingSpinner runtime={{ kind: "running", runId: "run_1" }} />,
    );
  });
  expect(app.lastFrame()).toBe("");
  act(() => {
    app.rerender(
      <WorkingSpinner
        runtime={{ kind: "running", runId: "run_1" }}
        modelActivity={{ ...request, firstTextAt: 2000 }}
      />,
    );
  });
  expect(app.lastFrame()).toBe("");
  act(() => {
    app.unmount();
  });
});

it("routes a clock anomaly once to diagnostics without repeating it on ticks", () => {
  const report = vi.fn();
  const sample = { serverNow: 500, receivedAt: performance.now() };
  let app!: ReturnType<typeof render>;
  const view = (): ReactElement => (
    <DurationDiagnosticContext.Provider value={report}>
      <DurationSampleContext.Provider value={sample}>
        <WorkingSpinner
          runtime={{ kind: "running", runId: "run_1" }}
          modelActivity={request}
        />
      </DurationSampleContext.Provider>
    </DurationDiagnosticContext.Provider>
  );
  act(() => {
    app = render(view());
  });
  expect(app.lastFrame()).toContain("0s");
  act(() => {
    app.rerender(view());
  });
  expect(report).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenCalledWith("req");
  act(() => {
    app.unmount();
  });
});

it("keeps its phrase across permission and retry attempts in the same run", () => {
  const random = vi
    .spyOn(Math, "random")
    .mockReturnValueOnce(0)
    .mockReturnValueOnce(0.9);
  let app!: ReturnType<typeof render>;
  act(() => {
    app = render(
      <WorkingSpinner
        runtime={{ kind: "running", runId: "run_1" }}
        modelActivity={request}
      />,
    );
  });
  const phrase = matchedPhrase(app.lastFrame() ?? "");
  act(() => {
    app.rerender(
      <WorkingSpinner
        runtime={{ kind: "waiting-for-permission", requestId: "approve" }}
        modelActivity={request}
      />,
    );
  });
  act(() => {
    app.rerender(
      <WorkingSpinner
        runtime={{ kind: "running", runId: "run_1" }}
        modelActivity={{ ...request, requestId: "retry", attempt: 1 }}
      />,
    );
  });
  expect(app.lastFrame()).toContain(phrase);
  expect(random).not.toHaveBeenCalled();
  act(() => {
    app.unmount();
  });
});

it("runs one animation timer and stops animation and duration timers when hidden", () => {
  vi.useFakeTimers();
  delete process.env.OHBABY_TUI_NO_ANIM;
  const interval = vi.spyOn(globalThis, "setInterval");
  const sample = { serverNow: 2000, receivedAt: performance.now() };
  const view = (hidden: boolean): ReactElement => (
    <DurationSampleContext.Provider value={sample}>
      <WorkingSpinner
        runtime={{ kind: "running", runId: "run_1" }}
        modelActivity={hidden ? { ...request, firstTextAt: 2000 } : request}
      />
    </DurationSampleContext.Provider>
  );
  let app!: ReturnType<typeof render>;
  act(() => {
    app = render(view(false));
  });
  expect(interval.mock.calls.map((call) => call[1]).sort()).toEqual(
    [1000, SHIMMER_INTERVAL_MS].sort(),
  );
  act(() => {
    vi.advanceTimersByTime(100);
  });
  act(() => {
    app.rerender(view(true));
  });
  act(() => {
    vi.advanceTimersByTime(100);
  });
  expect(app.lastFrame()).toBe("");
  expect(vi.getTimerCount()).toBe(0);
  act(() => {
    app.unmount();
  });
});

it("keeps the run phrase while displaying current state titles and per-request durations", () => {
  const sample = { serverNow: 5000, receivedAt: performance.now() };
  const view = (retry: boolean, title?: string): ReactElement => (
    <DurationSampleContext.Provider value={sample}>
      <WorkingSpinner
        runtime={{ kind: "running", runId: "run_1", title }}
        modelActivity={
          retry
            ? { ...request, requestId: "retry", startedAt: 4000, attempt: 1 }
            : request
        }
      />
    </DurationSampleContext.Provider>
  );
  let app!: ReturnType<typeof render>;
  act(() => {
    app = render(view(false));
  });
  const phrase = matchedPhrase(app.lastFrame() ?? "");
  expect(app.lastFrame()).toContain("4s");
  act(() => {
    app.rerender(view(true, "Retrying request"));
  });
  expect(app.lastFrame()).toContain("Retrying request");
  expect(app.lastFrame()).toContain("1s");
  act(() => {
    app.rerender(view(true));
  });
  expect(app.lastFrame()).toContain(phrase);
  expect(app.lastFrame()).toContain("1s");
  act(() => {
    app.unmount();
  });
});

it("keeps the same run phrase after the transcript is remounted", () => {
  vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValue(0.9);
  const before = matchedPhrase(
    frameOf({ kind: "running", runId: "remounted-run" }),
  );
  expect(before).toBeDefined();
  expect(
    matchedPhrase(frameOf({ kind: "running", runId: "remounted-run" })),
  ).toBe(before);
});
