import { render } from "ink-testing-library";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TuiRuntimeStatus } from "../store/snapshot.js";
import { WorkingSpinner } from "./working-spinner.js";
import { WORKING_PHRASES } from "./working-phrases.js";

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

function frameOf(runtime: TuiRuntimeStatus): string {
  let app: ReturnType<typeof render> | undefined;
  act(() => {
    app = render(<WorkingSpinner runtime={runtime} />);
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

  it("renders the dot glyph and a phrase while running", () => {
    const frame = frameOf({ kind: "running", runId: "run_1" });
    expect(frame).toContain("⠋");
    expect(matchedPhrase(frame)).toBeDefined();
  });

  it("uses the runtime title when one is provided", () => {
    const frame = frameOf({
      kind: "running",
      runId: "command_compact",
      title: "Compacting...",
    });
    expect(frame).toContain("Compacting...");
    expect(matchedPhrase(frame)).toBeUndefined();
  });

  it("keeps the same phrase across re-renders within one turn", () => {
    let app: ReturnType<typeof render> | undefined;
    act(() => {
      app = render(
        <WorkingSpinner runtime={{ kind: "running", runId: "run_1" }} />,
      );
    });
    const phrase = matchedPhrase(app?.lastFrame() ?? "");
    expect(phrase).toBeDefined();

    act(() => {
      // New runtime object, same runId → same turn → same phrase.
      app?.rerender(
        <WorkingSpinner runtime={{ kind: "running", runId: "run_1" }} />,
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
