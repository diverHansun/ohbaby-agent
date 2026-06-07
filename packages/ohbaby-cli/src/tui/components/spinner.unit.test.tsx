import { render } from "ink-testing-library";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Spinner } from "./spinner.js";

const previousNoAnimation = process.env.OHBABY_TUI_NO_ANIM;
const previousActEnvironment = (
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
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

describe("Spinner", () => {
  it("renders the first frame without starting an interval when animation is disabled", () => {
    process.env.OHBABY_TUI_NO_ANIM = "1";
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    let app: ReturnType<typeof render> | undefined;

    act(() => {
      app = render(<Spinner label="Bash pnpm test" />);
    });

    expect(app?.lastFrame()).toContain("⠋ Bash pnpm test");
    expect(setIntervalSpy).not.toHaveBeenCalled();
    act(() => {
      app?.unmount();
    });
  });

  it("advances frames on the spinner interval", () => {
    vi.useFakeTimers();
    let app: ReturnType<typeof render> | undefined;

    act(() => {
      app = render(<Spinner label="Bash pnpm test" />);
    });

    expect(app?.lastFrame()).toContain("⠋ Bash pnpm test");
    act(() => {
      vi.advanceTimersByTime(80);
    });
    expect(app?.lastFrame()).toContain("⠙ Bash pnpm test");

    act(() => {
      app?.unmount();
    });
  });
});
