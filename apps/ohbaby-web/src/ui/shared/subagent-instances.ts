import {
  createSubagentInstanceReader,
  type UiBackendClient,
  type UiSubagentInstance,
  type UiSubagentInstanceReaderState,
} from "ohbaby-sdk";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

export interface SubagentInstances {
  readonly state: UiSubagentInstanceReaderState;
  readonly refresh: () => void;
}

const EMPTY: UiSubagentInstanceReaderState = { loading: false };
const noop = (): (() => void) => () => undefined;

/**
 * The primary session's instance snapshot, read once and shared by the right
 * panel's list and the chat's delegation entries (improve-4/02 §2.7). A new
 * chat gets a new reader; a failed refresh keeps the last snapshot.
 */
export function useSubagentInstances(
  client: UiBackendClient | null,
  rootSessionId: string | undefined,
): SubagentInstances {
  // Only the root goes in the query; the client adds the current binding.
  const reader = useMemo(
    () =>
      client && rootSessionId
        ? createSubagentInstanceReader(client, { rootSessionId })
        : null,
    [client, rootSessionId],
  );
  const state = useSyncExternalStore(
    useCallback(
      (listener: () => void) => (reader ? reader.subscribe(listener) : noop()),
      [reader],
    ),
    () => (reader ? reader.getSnapshot() : EMPTY),
  );
  useEffect(() => {
    if (!reader || !client) return;
    void reader.refresh();
    // The SDK reader misses invalidations lost during a reconnect (improve-2 B4).
    const unsubscribe = client.subscribeEvents((event) => {
      if (event.type === "session.resync-required" && !event.disconnected)
        void reader.refresh();
    });
    return (): void => {
      unsubscribe();
      reader.dispose();
    };
  }, [client, reader]);
  const refresh = useCallback((): void => {
    void reader?.refresh();
  }, [reader]);
  return useMemo(() => ({ state, refresh }), [state, refresh]);
}

/**
 * Whether an instance was closed: absent from a loaded complete snapshot. An
 * unloaded or failed snapshot never implies closure (improve-4/02 §2.2).
 */
export function isClosedInstance(
  state: UiSubagentInstanceReaderState,
  subagentId: string,
): boolean {
  return (
    state.snapshot !== undefined &&
    !state.snapshot.instances.some((item) => item.subagentId === subagentId)
  );
}

export function findInstance(
  state: UiSubagentInstanceReaderState,
  subagentId: string,
): UiSubagentInstance | undefined {
  return state.snapshot?.instances.find(
    (item) => item.subagentId === subagentId,
  );
}
