// @vitest-environment jsdom
import type { SessionSyncState, UiSessionView } from "ohbaby-sdk";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INITIAL_LOAD_BANNER_DELAY_MS,
  isSessionRecovery,
  useSessionSyncBanner,
} from "./use-session-sync-banner.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const scope = { sessionId: "s1", runtimeEpoch: "e", bindingGeneration: 1 };
const view = {} as UiSessionView;

function state(patch: Partial<SessionSyncState>): SessionSyncState {
  return { status: "syncing", scope, attempts: 1, ...patch };
}

let root: Root | undefined;
let container: HTMLDivElement;
let current: ReturnType<typeof useSessionSyncBanner> = null;

function Probe({ value }: { readonly value: SessionSyncState }): ReactElement {
  current = useSessionSyncBanner(value);
  return <span />;
}

function render(value: SessionSyncState): void {
  act(() => {
    root ??= createRoot(container);
    root.render(<Probe value={value} />);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.useRealTimers();
});

describe("isSessionRecovery", () => {
  it("treats the first read of a new scope as loading", () => {
    expect(isSessionRecovery(state({}))).toBe(false);
  });
  it("treats an interrupted view, a failure or a retry as recovery", () => {
    expect(isSessionRecovery(state({ view }))).toBe(true);
    expect(isSessionRecovery(state({ error: "boom" }))).toBe(true);
    expect(isSessionRecovery(state({ attempts: 2 }))).toBe(true);
    expect(isSessionRecovery(state({ status: "ready", view }))).toBe(false);
  });
});

describe("useSessionSyncBanner", () => {
  it("does not flash for a fast first read after selecting a session", () => {
    render(state({}));
    expect(current).toBeNull();
    act(() => {
      vi.advanceTimersByTime(INITIAL_LOAD_BANNER_DELAY_MS - 1);
    });
    render(state({ status: "ready", view }));
    act(() => {
      vi.advanceTimersByTime(INITIAL_LOAD_BANNER_DELAY_MS);
    });
    expect(current).toBeNull();
  });
  it("reports a slow first read, and restarts the delay for a new scope", () => {
    render(state({}));
    act(() => {
      vi.advanceTimersByTime(INITIAL_LOAD_BANNER_DELAY_MS);
    });
    expect(current).toBe("recovering");
    render(state({ scope: { ...scope, bindingGeneration: 2 } }));
    expect(current).toBeNull();
  });
  it("shows recovery and error immediately", () => {
    render(state({ view }));
    expect(current).toBe("recovering");
    render(state({ status: "error", error: "down" }));
    expect(current).toBe("error");
  });
});
