import {
  createShellJobListReader,
  type UiBackendClient,
  type UiShellJobListReader,
  type UiShellJobListReaderState,
} from "ohbaby-sdk";
import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";

/** Invalidations come about once a second per running task (06 §3.2). */
export const TASK_REFRESH_INTERVAL_MS = 2000;

/**
 * Calls `refresh` for this chat's `shell-jobs.invalidated` events at most
 * once per interval, and for reconnects at once. While the page is hidden it
 * only remembers that something changed and catches up when shown again.
 */
export function useShellJobRefresh(
  client: UiBackendClient | null,
  rootSessionId: string | undefined,
  refresh: () => void,
): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!client || !rootSessionId) return;
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let missed = false;
    const run = (): void => {
      timer = undefined;
      if (document.visibilityState !== "visible") {
        missed = true;
        return;
      }
      last = Date.now();
      refreshRef.current();
    };
    const schedule = (): void => {
      if (timer !== undefined) return;
      const wait = TASK_REFRESH_INTERVAL_MS - (Date.now() - last);
      if (wait <= 0) run();
      else timer = setTimeout(run, wait);
    };
    const unsubscribe = client.subscribeEvents((event) => {
      if (
        event.type === "shell-jobs.invalidated" &&
        event.rootSessionId === rootSessionId
      )
        schedule();
      else if (
        event.type === "session.resync-required" &&
        !event.disconnected &&
        (event.sessionId === null || event.sessionId === rootSessionId)
      ) {
        if (timer !== undefined) clearTimeout(timer);
        run();
      }
    });
    const onVisibility = (): void => {
      if (document.visibilityState === "visible" && missed) {
        missed = false;
        schedule();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return (): void => {
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, rootSessionId]);
}

const EMPTY: UiShellJobListReaderState = { loading: false, loadingMore: false };
const noop = (): (() => void) => () => undefined;

/** Subscribes React to one list reader; a null reader reads as empty. */
export function useShellJobReaderState(
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

function scopeCount(state: UiShellJobListReaderState): number | undefined {
  const counts = state.meta?.statusCounts;
  if (!counts) return undefined;
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

export interface BackgroundTaskProbe {
  /** The chat has had at least one task; holds its last answer while unknown. */
  readonly hasTasks: boolean;
  /** Task totals per owner, once known for this chat. */
  readonly main?: number;
  readonly subagents?: number;
}

/**
 * Whether the open chat has background tasks, read as two one-row lists
 * (main agent and subagents) so the page also knows which filter to start
 * with. Unknown or failed answers keep the last decision, so switching chats
 * or reconnecting never makes the tab blink (04 §2.1).
 */
export function useBackgroundTaskProbe(
  client: UiBackendClient | null,
  rootSessionId: string | undefined,
): BackgroundTaskProbe {
  const readers = useMemo(
    () =>
      client && rootSessionId
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
  useShellJobRefresh(client, rootSessionId, () => {
    void readers?.main.refresh();
    void readers?.subagents.refresh();
  });
  const main = scopeCount(useShellJobReaderState(readers?.main ?? null));
  const subagents = scopeCount(
    useShellJobReaderState(readers?.subagents ?? null),
  );
  const decided = useRef(false);
  if (!rootSessionId) decided.current = false;
  else if ((main ?? 0) > 0 || (subagents ?? 0) > 0) decided.current = true;
  else if (main === 0 && subagents === 0) decided.current = false;
  return {
    hasTasks: decided.current,
    ...(main === undefined ? {} : { main }),
    ...(subagents === undefined ? {} : { subagents }),
  };
}

/** Opens one task's detail in the right panel; absent where tasks can't open. */
export const BackgroundTaskOpener = createContext<
  ((jobId: string) => void) | undefined
>(undefined);
