import {
  createShellJobListReader,
  type CoreAPI,
  type UiEventHandler,
  type UiShellJobListReader,
  type UiShellJobListReaderState,
  type UiShellJobOutput,
  type UiShellJobOwnerFilter,
  type UiUnsubscribe,
} from "ohbaby-sdk";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

type Subscribe = (handler: UiEventHandler) => UiUnsubscribe;

/** A running task checkpoints about once a second; refresh at most this often. */
export const TASK_REFRESH_INTERVAL_MS = 2000;
export const TASK_PAGE_SIZE = 30;

/**
 * Calls `refresh` for this chat's `shell-jobs.invalidated` events at most once
 * per interval (with a trailing call), and for reconnects at once. A terminal
 * has no hidden-page state, so unlike the Web there is no visibility gate.
 */
export function useShellJobRefresh(
  subscribeEvents: Subscribe,
  rootSessionId: string | null,
  refresh: () => void,
): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!rootSessionId) return;
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = (): void => {
      timer = undefined;
      last = Date.now();
      refreshRef.current();
    };
    const unsubscribe = subscribeEvents((event) => {
      if (
        event.type === "shell-jobs.invalidated" &&
        event.rootSessionId === rootSessionId
      ) {
        if (timer !== undefined) return;
        const wait = TASK_REFRESH_INTERVAL_MS - (Date.now() - last);
        if (wait <= 0) run();
        else timer = setTimeout(run, wait);
      } else if (
        event.type === "session.resync-required" &&
        !event.disconnected &&
        (event.sessionId === null || event.sessionId === rootSessionId)
      ) {
        if (timer !== undefined) clearTimeout(timer);
        run();
      }
    });
    return (): void => {
      unsubscribe();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [subscribeEvents, rootSessionId]);
}

const EMPTY: UiShellJobListReaderState = { loading: false, loadingMore: false };
const noop = (): (() => void) => () => undefined;

export function useReaderState(
  reader: UiShellJobListReader | null,
): UiShellJobListReaderState {
  const subscribe = useCallback(
    (listener: () => void) => (reader ? reader.subscribe(listener) : noop()),
    [reader],
  );
  return useSyncExternalStore(subscribe, () =>
    reader ? reader.getSnapshot() : EMPTY,
  );
}

function sum(state: UiShellJobListReaderState): {
  readonly total?: number;
  readonly running?: number;
} {
  const counts = state.meta?.statusCounts;
  if (!counts) return {};
  return {
    total: Object.values(counts).reduce((total, count) => total + count, 0),
    running: counts.running,
  };
}

export interface BackgroundTaskProbe {
  /** The chat has had a background task; holds its last answer while unknown. */
  readonly hasTasks: boolean;
  /** Known only once both owner scopes answered for this chat. */
  readonly known: boolean;
  readonly main?: number;
  readonly subagents?: number;
  readonly running: number;
}

/**
 * Whether and where the open chat has background tasks, as two one-row
 * background-only lists (Web D12). Unknown or failed answers keep the last
 * decision, so reconnects never flip the hint line (04 §2.1).
 */
export function useBackgroundTaskProbe(
  client: CoreAPI,
  subscribeEvents: Subscribe,
  rootSessionId: string | null,
): BackgroundTaskProbe {
  const readers = useMemo(
    () =>
      rootSessionId && client.listShellJobs
        ? {
            main: createShellJobListReader(client, {
              rootSessionId,
              owner: { kind: "main" },
              mode: "background",
              pageSize: 1,
            }),
            subagents: createShellJobListReader(client, {
              rootSessionId,
              owner: { kind: "subagents" },
              mode: "background",
              pageSize: 1,
            }),
          }
        : null,
    [client, rootSessionId],
  );
  useEffect(() => {
    if (!readers) return;
    void readers.main.refresh();
    void readers.subagents.refresh();
    return (): void => {
      readers.main.dispose();
      readers.subagents.dispose();
    };
  }, [readers]);
  useShellJobRefresh(subscribeEvents, rootSessionId, () => {
    void readers?.main.refresh();
    void readers?.subagents.refresh();
  });
  const main = sum(useReaderState(readers?.main ?? null));
  const subagents = sum(useReaderState(readers?.subagents ?? null));
  const decided = useRef(false);
  if (!rootSessionId) decided.current = false;
  else if ((main.total ?? 0) > 0 || (subagents.total ?? 0) > 0)
    decided.current = true;
  else if (main.total === 0 && subagents.total === 0) decided.current = false;
  return {
    hasTasks: decided.current,
    known: main.total !== undefined && subagents.total !== undefined,
    ...(main.total === undefined ? {} : { main: main.total }),
    ...(subagents.total === undefined ? {} : { subagents: subagents.total }),
    running: (main.running ?? 0) + (subagents.running ?? 0),
  };
}

export function ownerQuery(
  filter: "main" | "subagents" | "all",
): UiShellJobOwnerFilter | undefined {
  return filter === "all" ? undefined : { kind: filter };
}

/** The panel's list reader; the filter switches through `select`. */
export function useTaskList(
  client: CoreAPI,
  subscribeEvents: Subscribe,
  rootSessionId: string,
  initialOwner: UiShellJobOwnerFilter | undefined,
): {
  readonly reader: UiShellJobListReader;
  readonly state: UiShellJobListReaderState;
} {
  const ownerRef = useRef(initialOwner);
  const reader = useMemo(
    () =>
      createShellJobListReader(client, {
        rootSessionId,
        owner: ownerRef.current,
        mode: "background",
        pageSize: TASK_PAGE_SIZE,
      }),
    [client, rootSessionId],
  );
  useEffect(() => {
    void reader.refresh();
    return (): void => {
      reader.dispose();
    };
  }, [reader]);
  useShellJobRefresh(subscribeEvents, rootSessionId, () => {
    void reader.refresh();
  });
  return { reader, state: useReaderState(reader) };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
export { errorCode };

export interface TaskOutputState {
  readonly output?: UiShellJobOutput;
  readonly error?: string;
  readonly notFound: boolean;
}

/**
 * One task's output tail, read every two seconds while it runs, each read
 * starting after the last answered, until its final output is ready (06 §3.2).
 */
export function useTaskOutput(
  client: CoreAPI,
  subscribeEvents: Subscribe,
  rootSessionId: string,
  jobId: string | undefined,
): TaskOutputState & { readonly retry: () => void } {
  const [state, setState] = useState<TaskOutputState>({ notFound: false });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setState({ notFound: false });
    if (!jobId) return;
    let disposed = false;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (): void => {
      if (!disposed)
        timer = setTimeout(() => {
          void read();
        }, TASK_REFRESH_INTERVAL_MS);
    };
    const read = async (): Promise<void> => {
      timer = undefined;
      if (!client.getShellJobOutput) {
        setState({
          notFound: false,
          error: "Background tasks are unavailable",
        });
        return;
      }
      controller = new AbortController();
      try {
        const output = await client.getShellJobOutput({
          rootSessionId,
          jobId,
          signal: controller.signal,
        });
        if (disposed) return;
        setState({ output, notFound: false });
        if (
          output.job.status === "running" ||
          output.job.resultReadyAt === null
        )
          schedule();
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        const code = errorCode(error);
        if (code === "SHELL_JOB_NOT_FOUND") setState({ notFound: true });
        else if (
          code === "SHELL_JOB_NOT_READY" ||
          code === "SESSION_SCOPE_CHANGED"
        )
          schedule();
        else
          setState((current) => ({
            ...current,
            error: error instanceof Error ? error.message : String(error),
          }));
      }
    };
    const unsubscribe = subscribeEvents((event) => {
      if (
        event.type === "session.resync-required" &&
        !event.disconnected &&
        (event.sessionId === null || event.sessionId === rootSessionId) &&
        timer !== undefined
      ) {
        clearTimeout(timer);
        void read();
      }
    });
    void read();
    return (): void => {
      disposed = true;
      controller?.abort();
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe();
    };
  }, [client, subscribeEvents, rootSessionId, jobId, attempt]);
  const retry = useCallback((): void => {
    setAttempt((value) => value + 1);
  }, []);
  return { ...state, retry };
}
