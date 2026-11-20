// @vitest-environment jsdom
import type { SessionSyncState, UiSessionView } from "ohbaby-sdk";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionSyncNotice } from "./SessionBanners.js";
import {
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
  return (
    <SessionSyncNotice
      state={current}
      error={value.error}
      onRetry={() => undefined}
    />
  );
}

function render(value: SessionSyncState): void {
  act(() => {
    root ??= createRoot(container);
    root.render(<Probe value={value} />);
  });
}

beforeEach(() => {
  container = document.createElement("div");
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
});

describe("isSessionRecovery", () => {
  it("treats the first read of a new scope as loading", () => {
    expect(isSessionRecovery(state({}))).toBe(false);
  });
  it("treats a failure or retry as recovery, but keeps ordinary reconnection quiet", () => {
    expect(isSessionRecovery(state({ view }))).toBe(false);
    expect(isSessionRecovery(state({ error: "boom" }))).toBe(true);
    expect(isSessionRecovery(state({ attempts: 2 }))).toBe(true);
    expect(isSessionRecovery(state({ status: "ready", view }))).toBe(false);
  });
});

describe("useSessionSyncBanner", () => {
  it("reports the first read at once and leaves the text to the placeholder", () => {
    render(state({}));
    expect(current).toBe("loading");
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector(".ohb-banner")).toBeNull();
    render(state({ status: "ready", view }));
    expect(current).toBeNull();
  });
  it("shows recovery and error immediately", () => {
    render(state({ view }));
    expect(current).toBeNull();
    render(state({ view, error: "retrying" }));
    expect(current).toBe("recovering");
    render(state({ status: "error", error: "down" }));
    expect(current).toBe("error");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "down",
    );
    expect(container.querySelector("button")?.textContent).toBe(
      "Retry conversation",
    );
  });
});
