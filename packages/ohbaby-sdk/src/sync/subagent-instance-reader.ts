import type { UiBackendClient } from "../contract/client.js";
import type {
  UiSubagentInstanceQuery,
  UiSubagentInstanceSnapshot,
} from "../contract/subagent-instance.js";

export interface UiSubagentInstanceReaderState {
  readonly snapshot?: UiSubagentInstanceSnapshot;
  readonly loading: boolean;
  readonly error?: string;
}

/** A complete snapshot replaces the list; failures and stale responses preserve it. */
export function createSubagentInstanceReader(
  client: Partial<UiBackendClient>,
  initialQuery: UiSubagentInstanceQuery,
): {
  getSnapshot(): UiSubagentInstanceReaderState;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  select(query: UiSubagentInstanceQuery): Promise<void>;
  dispose(): void;
} {
  let query = initialQuery;
  let state: UiSubagentInstanceReaderState = { loading: false };
  let generation = 0;
  let disposed = false;
  let pending: AbortController | undefined;
  let refreshQueued = false;
  const listeners = new Set<() => void>();
  const isCurrent = (ticket: number, signal: AbortSignal): boolean =>
    !disposed && ticket === generation && !signal.aborted;
  const publish = (patch: Partial<UiSubagentInstanceReaderState>): void => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  async function refresh(): Promise<void> {
    if (disposed) return;
    const ticket = ++generation;
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    const selected = query;
    publish({ loading: true, error: undefined });
    try {
      if (!client.listSubagentInstances)
        throw new Error("Subagent instance snapshots are unavailable");
      const snapshot = await client.listSubagentInstances({
        ...selected,
        signal: controller.signal,
      });
      if (!isCurrent(ticket, controller.signal)) return;
      if (
        (snapshot.complete as unknown) !== true ||
        snapshot.rootSessionId !== selected.rootSessionId ||
        !Number.isSafeInteger(snapshot.revision) ||
        snapshot.revision < 1 ||
        !snapshot.runtimeEpoch ||
        (selected.runtimeEpoch !== undefined &&
          snapshot.runtimeEpoch !== selected.runtimeEpoch) ||
        (selected.bindingGeneration !== undefined &&
          snapshot.bindingGeneration !== selected.bindingGeneration) ||
        snapshot.instances.some(
          (item) => item.rootSessionId !== selected.rootSessionId,
        )
      )
        throw new Error("Invalid subagent instance snapshot scope or version");
      const current = state.snapshot;
      const sameBinding =
        current?.runtimeEpoch === snapshot.runtimeEpoch &&
        current.bindingGeneration === snapshot.bindingGeneration;
      publish({
        loading: false,
        ...(!current || !sameBinding || snapshot.revision > current.revision
          ? { snapshot }
          : {}),
      });
    } catch (error) {
      if (isCurrent(ticket, controller.signal))
        publish({
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
    } finally {
      if (pending === controller) pending = undefined;
    }
  }
  const requestRefresh = (): void => {
    if (disposed || refreshQueued) return;
    refreshQueued = true;
    const selected = query;
    const scheduledGeneration = generation;
    queueMicrotask(() => {
      refreshQueued = false;
      if (!disposed && query === selected && generation === scheduledGeneration)
        void refresh();
    });
  };
  const unsubscribe = client.subscribeEvents?.((event) => {
    if (disposed) return;
    if (event.type === "session.resync-required") {
      if (
        !event.disconnected &&
        (event.sessionId === null || event.sessionId === query.rootSessionId)
      )
        requestRefresh();
      return;
    }
    if (
      event.type !== "subagent.instances.invalidated" ||
      event.rootSessionId !== query.rootSessionId ||
      (query.runtimeEpoch !== undefined &&
        event.runtimeEpoch !== query.runtimeEpoch)
    )
      return;
    const current = state.snapshot;
    if (
      current?.runtimeEpoch === event.runtimeEpoch &&
      current.revision >= event.revision
    )
      return;
    requestRefresh();
  });
  return {
    getSnapshot: (): UiSubagentInstanceReaderState => state,
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    select(next): Promise<void> {
      if (disposed) return Promise.resolve();
      query = next;
      publish({ snapshot: undefined, error: undefined });
      return refresh();
    },
    dispose(): void {
      disposed = true;
      generation++;
      pending?.abort();
      unsubscribe?.();
      listeners.clear();
    },
  };
}
