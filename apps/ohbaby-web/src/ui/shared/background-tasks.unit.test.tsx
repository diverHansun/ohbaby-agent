// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type {
  UiBackendClient,
  UiEvent,
  UiEventHandler,
  UiShellJobOutput,
} from "ohbaby-sdk";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useShellJobRefresh } from "./background-tasks.js";
import { useTaskOutput } from "../side-panel/background-tasks/use-task-output.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let emit: UiEventHandler = () => undefined;
const client = {
  subscribeEvents: (handler: UiEventHandler): (() => void) => {
    emit = handler;
    return () => undefined;
  },
} as unknown as UiBackendClient;
const cleanups: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

function Harness(props: { readonly refresh: () => void }): ReactElement {
  useShellJobRefresh(client, "root", props.refresh);
  return <p />;
}

function mount(refresh: () => void): void {
  const element = document.createElement("div");
  const root = createRoot(element);
  act(() => {
    root.render(<Harness refresh={refresh} />);
  });
  cleanups.push(() => {
    act(() => {
      root.unmount();
    });
  });
}

const invalidated = (rootSessionId = "root"): UiEvent => ({
  type: "shell-jobs.invalidated",
  rootSessionId,
  runtimeEpoch: "epoch",
  revision: 1,
});

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

it("refreshes a burst of invalidations at most once per two seconds", () => {
  const refresh = vi.fn();
  mount(refresh);
  for (let second = 0; second < 5; second += 1) {
    emit(invalidated());
    vi.advanceTimersByTime(1000);
  }
  // At 0s, 2s and 4s; the others fold into those.
  expect(refresh).toHaveBeenCalledTimes(3);
  // The event at 4s still gets its trailing refresh, at 6s; another chat's
  // invalidation adds nothing.
  emit(invalidated("other"));
  vi.advanceTimersByTime(5000);
  expect(refresh).toHaveBeenCalledTimes(4);
});

it("refreshes at once after a reconnect", () => {
  const refresh = vi.fn();
  mount(refresh);
  emit(invalidated());
  emit({
    type: "session.resync-required",
    sessionId: "root",
    runtimeEpoch: "epoch",
    disconnected: false,
  });
  expect(refresh).toHaveBeenCalledTimes(2);
});

it("waits while the page is hidden and catches up once shown", () => {
  const refresh = vi.fn();
  mount(refresh);
  setVisibility("hidden");
  emit(invalidated());
  vi.advanceTimersByTime(10_000);
  expect(refresh).not.toHaveBeenCalled();
  setVisibility("visible");
  expect(refresh).toHaveBeenCalledTimes(1);
});

it("pauses an already scheduled output read while hidden and waits for terminal output to drain", async () => {
  const sample = (
    status: "running" | "completed",
    resultReadyAt: number | null,
    output: string,
  ): UiShellJobOutput =>
    ({ job: { status, resultReadyAt }, output }) as UiShellJobOutput;
  const read = vi
    .fn<NonNullable<UiBackendClient["getShellJobOutput"]>>()
    .mockResolvedValueOnce(sample("running", null, "running"))
    .mockResolvedValueOnce(sample("completed", null, "partial"))
    .mockResolvedValue(sample("completed", 123, "final"));
  const outputClient = { ...client, getShellJobOutput: read };
  function Output(): ReactElement {
    const state = useTaskOutput(outputClient, "root", "job");
    return <p>{state.output?.output}</p>;
  }
  const element = document.createElement("div");
  const root = createRoot(element);
  cleanups.push(() => {
    act(() => {
      root.unmount();
    });
  });
  setVisibility("visible");
  await act(async () => {
    root.render(<Output />);
    await Promise.resolve();
  });
  setVisibility("hidden");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4000);
  });
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => {
    setVisibility("visible");
    await Promise.resolve();
  });
  expect(element.textContent).toBe("partial");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
  });
  expect(element.textContent).toBe("final");
  expect(read).toHaveBeenCalledTimes(3);
});
