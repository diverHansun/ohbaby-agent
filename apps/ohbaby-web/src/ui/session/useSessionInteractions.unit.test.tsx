// @vitest-environment jsdom
import type {
  UiBackendClient,
  UiEvent,
  UiEventHandler,
  UiSubagentExecutionList,
} from "ohbaby-sdk";
import { act, useRef, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import type { ViewModel } from "./selectors.js";
import { useSessionInteractions } from "./useSessionInteractions.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const executions: UiSubagentExecutionList = {
  executions: [],
  hasMore: false,
  waiting: false,
  approvalBlocked: false,
  activeCount: 0,
  completedCount: 0,
};

const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

function update(action: () => void): Promise<void> {
  return act(() => {
    action();
    return Promise.resolve();
  });
}

type ListExecutions = NonNullable<UiBackendClient["listSubagentExecutions"]>;

function mount(list = vi.fn<ListExecutions>().mockResolvedValue(executions)): {
  list: Mock<ListExecutions>;
  select: (id: string) => Promise<void>;
  emit: (event: UiEvent) => void;
} {
  const listeners = new Set<UiEventHandler>();
  const client = {
    listSubagentExecutions: list,
    getSubagentExecutionView: vi.fn(),
    subscribeEvents(handler: UiEventHandler): () => void {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
  } as unknown as UiBackendClient;
  function Harness({ id }: { id: string }): ReactElement | null {
    useSessionInteractions({
      client,
      view: {
        activeSession: { id },
        pendingPermissions: [],
      } as unknown as ViewModel,
      contentRef: useRef<HTMLDivElement>(null),
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  cleanups.push(() => {
    act(() => {
      root.unmount();
    });
  });
  return {
    list,
    select(id): Promise<void> {
      return update(() => {
        root.render(<Harness id={id} />);
      });
    },
    emit(event: UiEvent): void {
      for (const listener of listeners) listener(event);
    },
  };
}

const invalidated = (rootSessionId = "root"): UiEvent => ({
  type: "subagent.instances.invalidated",
  rootSessionId,
  runtimeEpoch: "epoch",
  revision: 2,
});

const resync = (sessionId: string, disconnected: boolean): UiEvent => ({
  type: "session.resync-required",
  sessionId,
  runtimeEpoch: "epoch",
  disconnected,
});

it("reads the selected session on entry, a matching change and reconnect", async () => {
  const { list, select, emit } = mount();
  await select("root");
  expect(list).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
    emit(invalidated("other"));
    emit(resync("root", true));
    emit(resync("other", false));
  });
  expect(list).toHaveBeenCalledTimes(1);

  list.mockRejectedValueOnce(new Error("Connection interrupted"));
  await update(() => {
    emit(invalidated());
  });
  expect(list).toHaveBeenCalledTimes(2);
  await update(() => {
    emit(resync("root", false));
  });
  expect(list).toHaveBeenCalledTimes(3);
});

it("coalesces changes during a read into one follow-up and drops it on a session switch", async () => {
  let finishRead!: (value: UiSubagentExecutionList) => void;
  const pending = (): Promise<UiSubagentExecutionList> =>
    new Promise((resolve) => {
      finishRead = resolve;
    });
  const list = vi
    .fn<ListExecutions>()
    .mockImplementationOnce(pending)
    .mockImplementationOnce(pending)
    .mockResolvedValue(executions);
  const { select, emit } = mount(list);
  await select("root");
  await update(() => {
    emit(invalidated());
    emit(resync("root", false));
  });
  expect(list).toHaveBeenCalledTimes(1);
  await update(() => {
    finishRead(executions);
  });
  expect(list).toHaveBeenCalledTimes(2);

  await update(() => {
    emit(invalidated());
  });
  const staleSignal = list.mock.calls[1][0].signal;
  await select("other");
  expect(staleSignal?.aborted).toBe(true);
  await update(() => {
    finishRead(executions);
  });
  expect(list.mock.calls.map(([query]) => query.rootSessionId)).toEqual([
    "root",
    "root",
    "other",
  ]);
});
