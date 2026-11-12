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
import type { UiModelActivity, UiRun } from "ohbaby-sdk";
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
  purpose: "agent-step" as const,
  step: 0,
  attempt: 0,
  startedAt: 1000,
  outcome: "running" as const,
};

/** The run behind a running status; it started at t=1000 like `request`. */
function runOf(activity?: UiModelActivity, runId = "run_1"): UiRun {
  return {
    id: runId,
    sessionId: "session",
    status: { kind: "running", runId },
    startedAt: new Date(1000).toISOString(),
    updatedAt: new Date(1000).toISOString(),
    ...(activity === undefined ? {} : { modelActivity: activity }),
  };
}

function frameOf(runtime: TuiRuntimeStatus): string {
  let app: ReturnType<typeof render> | undefined;
  act(() => {
    app = render(
      <WorkingSpinner
        runtime={runtime}
        run={runOf(
          runtime.kind === "running" && runtime.title
            ? {
                requestId: "summary-request",
                messageId: "summary-message",
                compactionId: "compaction",
                purpose: "context-summary",
                attempt: 1,
                startedAt: 1000,
                outcome: "running",
              }
            : {
                ...request,
                runId: runtime.kind === "running" ? runtime.runId : "run_1",
              },
          runtime.kind === "running" ? runtime.runId : "run_1",
        )}
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
          run={runOf(request)}
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
          run={runOf(request)}
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
              run={runOf(request)}
            />
          </DurationSampleContext.Provider>
        </Box>,
      );
    });
    const frame = app.lastFrame() ?? "";
    expect(frame.split("\n")).toHaveLength(1);
    expect(frame).toContain(" 1s");
    expect(stringWidth(frame)).toBeLessThanOrEqual(columns);
    act(() => {
      app.unmount();
    });
  },
);

it("holds the slot from the turn's start and while text streams, as in pi", () => {
  let app!: ReturnType<typeof render>;
  act(() => {
    app = render(
      <WorkingSpinner
        runtime={{ kind: "running", runId: "run_1" }}
        run={runOf()}
      />,
    );
  });
  const phrase = matchedPhrase(app.lastFrame() ?? "");
  expect(phrase).toBeDefined();
  act(() => {
    app.rerender(
      <WorkingSpinner
        runtime={{ kind: "running", runId: "run_1" }}
        run={runOf({ ...request, firstTextAt: 2000 })}
      />,
    );
  });
  expect(app.lastFrame()).toContain(phrase);
  // A command run (no agent run behind it) keeps its own status instead.
  act(() => {
    app.rerender(
      <WorkingSpinner runtime={{ kind: "running", runId: "command_x" }} />,
    );
  });
  expect(app.lastFrame()).toBe("");
  act(() => {
    app.unmount();
  });
});

it("turns into Retrying #n in the same slot while retries run, without a timer", () => {
  const sample = { serverNow: 5000, receivedAt: performance.now() };
  const failed = {
    ...request,
    attempt: 1,
    endedAt: 2000,
    outcome: "error" as const,
    retryScheduled: true as const,
    phase: "retrying" as const,
    waitingStartedAt: 1000,
  };
  const view = (activity: UiModelActivity): ReactElement => (
    <DurationSampleContext.Provider value={sample}>
      <WorkingSpinner
        runtime={{ kind: "running", runId: "run_1" }}
        run={runOf(activity)}
      />
    </DurationSampleContext.Provider>
  );
  let app!: ReturnType<typeof render>;
  act(() => {
    app = render(view(failed));
  });
  expect(app.lastFrame()).toBe("Retrying #1");
  // The retry request itself is still retry #1.
  act(() => {
    app.rerender(
      view({
        ...failed,
        requestId: "r2",
        attempt: 2,
        endedAt: undefined,
        outcome: "running",
        retryScheduled: undefined,
      }),
    );
  });
  expect(app.lastFrame()).toBe("Retrying #1");
  act(() => {
    app.rerender(view({ ...failed, requestId: "r2", attempt: 2 }));
  });
  expect(app.lastFrame()).toBe("Retrying #2");
  // Recovered: back to the phrase with the turn's time.
  act(() => {
    app.rerender(
      view({
        ...failed,
        requestId: "r3",
        attempt: 3,
        endedAt: undefined,
        outcome: "running",
        retryScheduled: undefined,
        phase: "requesting",
      }),
    );
  });
  expect(matchedPhrase(app.lastFrame() ?? "")).toBeDefined();
  expect(app.lastFrame()).toContain("4s");
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
          run={runOf(request)}
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
  expect(report).toHaveBeenCalledWith("run_1");
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
        run={runOf(request)}
      />,
    );
  });
  const phrase = matchedPhrase(app.lastFrame() ?? "");
  act(() => {
    app.rerender(
      <WorkingSpinner
        runtime={{ kind: "waiting-for-permission", requestId: "approve" }}
        run={runOf(request)}
      />,
    );
  });
  act(() => {
    app.rerender(
      <WorkingSpinner
        runtime={{ kind: "running", runId: "run_1" }}
        run={runOf({ ...request, requestId: "retry", attempt: 1 })}
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
        run={hidden ? undefined : runOf(request)}
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

it("keeps the run phrase while displaying current state titles and the turn's time", () => {
  const sample = { serverNow: 5000, receivedAt: performance.now() };
  const view = (retry: boolean, title?: string): ReactElement => (
    <DurationSampleContext.Provider value={sample}>
      <WorkingSpinner
        runtime={{ kind: "running", runId: "run_1", title }}
        run={runOf(
          retry
            ? { ...request, requestId: "retry", startedAt: 4000, attempt: 1 }
            : request,
        )}
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
  // A new request does not restart the turn's clock.
  expect(app.lastFrame()).toContain("4s");
  act(() => {
    app.rerender(view(true));
  });
  expect(app.lastFrame()).toContain(phrase);
  expect(app.lastFrame()).toContain("4s");
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
