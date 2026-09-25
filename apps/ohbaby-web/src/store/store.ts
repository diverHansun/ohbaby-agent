import {
  createInitialViewState,
  reduceUiEvent,
  replaceSnapshot,
} from "../api/daemon/eventReducer.js";
import type {
  ConnectionState,
  StoreSnapshot,
  UnknownPromptRequest,
} from "../api/daemon/wire.js";
import type {
  PermissionSyncState,
  SessionSyncState,
  UiSessionControl,
  UiSessionHistory,
  UiSessionChangedEvent,
  UiMessage,
  UiSessionView,
  UiSessionIndexEntry,
  UiCurrentModelConfig,
  UiEvent,
  UiSnapshot,
} from "ohbaby-sdk";

export type StoreListener = () => void;
export type UiEventSource = "incremental" | "snapshot-barrier";

export interface OhbabyWebStore {
  setSessionSync(state: SessionSyncState): void;
  setSessionControl(control: UiSessionControl | null): void;
  installSessionHistory(page: UiSessionHistory): void;
  invalidateSessionHistory(event: UiSessionChangedEvent): void;
  setHistoryState(state: "loading" | "ready" | "error", error?: string): void;
  setUnknownPromptRequests(records: readonly UnknownPromptRequest[]): void;
  setPermissionSync(state: PermissionSyncState): void;
  setSessionIndex(sessions: readonly UiSessionIndexEntry[]): void;
  applyEvent(event: UiEvent, seqNum: number, source?: UiEventSource): boolean;
  getSnapshot(): StoreSnapshot;
  replaceSnapshot(snapshot: UiSnapshot, seqNum: number): void;
  reset(): void;
  setConnectionState(state: ConnectionState): void;
  setCurrentModel(model: UiCurrentModelConfig | null): void;
  setError(error: string | null): void;
  subscribe(listener: StoreListener): () => void;
}

export function createOhbabyWebStore(): OhbabyWebStore {
  const initial = (): StoreSnapshot => ({
    sessionSync: { status: "idle", scope: null, attempts: 0 },
    sessionControl: null,
    historyState: "ready",
    historyHasMore: false,
    historyStale: false,
    unknownPromptRequests: [],
    permissionSync: {
      status: "idle",
      binding: null,
      requests: [],
      permissionRevision: 0,
      attempts: 0,
    },
    sessionIndex: [],
    connectionState: "connecting",
    currentModel: null,
    error: null,
    view: createInitialViewState(),
  });
  let snapshot = initial();
  const loaded = new Map<string, UiMessage>();
  const observed = new Map<string, { generation: string; revision: number }>();
  let historyLoaded = false;
  let invalidatedAt = -1;
  const deleted = new Set<string>();
  const listeners = new Set<StoreListener>();

  function publish(next: StoreSnapshot): void {
    snapshot = next;
    let listenerFailed = false;
    for (const listener of Array.from(listeners)) {
      try {
        listener();
      } catch {
        listenerFailed = true;
      }
    }
    if (listenerFailed) {
      try {
        globalThis.console.error(
          '{"stage":"store-listener","type":"ui.observation.failure"}',
        );
      } catch {
        // Diagnostics are fail-open and must not affect state publication.
      }
    }
  }

  function install(view: UiSessionView): StoreSnapshot["view"] {
    const messages = new Map(loaded);
    for (const message of view.session.messages)
      messages.set(message.id, message);
    const ordered = [...messages.values()].sort((a, b) =>
      a.createdAt < b.createdAt
        ? -1
        : a.createdAt > b.createdAt
          ? 1
          : a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : 0,
    );
    const active = view.runs.find(
      (run) =>
        run.status.kind === "running" ||
        run.status.kind === "waiting-for-permission",
    );
    return {
      ...snapshot.view,
      reasoningByMessageId: {},
      snapshot: {
        sessions: [{ ...view.session, messages: ordered }],
        activeSessionId: view.session.id,
        runs: view.runs,
        prompts: view.prompts,
        permissions: [],
        permission: snapshot.view.snapshot?.permission,
        status: active?.status ?? { kind: "idle" },
        goals:
          view.goal.status === "ready" && view.goal.value
            ? [{ sessionId: view.session.id, goal: view.goal.value }]
            : [],
        todos:
          view.todo.status === "ready" && view.todo.value
            ? [view.todo.value]
            : [],
        contextWindowUsages:
          view.context.status === "ready" && view.context.value
            ? [view.context.value]
            : [],
      },
    };
  }
  return {
    setSessionSync(sessionSync): void {
      const previous = snapshot.sessionSync;
      const changedScope =
        previous.scope?.sessionId !== sessionSync.scope?.sessionId ||
        previous.scope?.runtimeEpoch !== sessionSync.scope?.runtimeEpoch ||
        previous.scope?.bindingGeneration !==
          sessionSync.scope?.bindingGeneration;
      if (changedScope) {
        loaded.clear();
        observed.clear();
        deleted.clear();
        invalidatedAt = -1;
        historyLoaded = false;
      }
      const view = sessionSync.view;
      const newGeneration =
        !!view &&
        !!previous.view &&
        view.version.viewGeneration !== previous.view.version.viewGeneration;
      if (newGeneration) invalidatedAt = -1;
      if (view)
        for (const message of view.session.messages) {
          if (deleted.has(message.id)) continue;
          loaded.set(message.id, message);
          observed.set(message.id, {
            generation: view.version.viewGeneration,
            revision: view.version.sessionRevision,
          });
        }
      publish({
        ...snapshot,
        sessionSync,
        ...(changedScope
          ? {
              sessionControl: null,
              historyState: "ready",
              historyStale: false,
              historyError: undefined,
            }
          : {}),
        ...(view
          ? {
              view: install(view),
              ...(!historyLoaded
                ? {
                    historyBefore: view.history.before,
                    historyHasMore: view.history.hasMore,
                  }
                : {}),
              historyStale:
                !changedScope &&
                (snapshot.historyStale || (newGeneration && historyLoaded)),
            }
          : changedScope
            ? {
                view: createInitialViewState(),
                historyHasMore: false,
                historyBefore: undefined,
              }
            : {}),
      });
    },
    setSessionControl(sessionControl): void {
      publish({ ...snapshot, sessionControl });
    },
    setUnknownPromptRequests(unknownPromptRequests): void {
      publish({ ...snapshot, unknownPromptRequests });
    },
    setHistoryState(historyState, historyError): void {
      publish({ ...snapshot, historyState, historyError });
    },
    installSessionHistory(page): void {
      const view = snapshot.sessionSync.view;
      if (
        page.version.sessionId !== view?.version.sessionId ||
        page.version.runtimeEpoch !== view.version.runtimeEpoch ||
        page.version.viewGeneration !== view.version.viewGeneration ||
        page.bindingGeneration !== view.bindingGeneration
      )
        return;
      if (
        page.version.sessionRevision < invalidatedAt ||
        page.version.sessionRevision > view.version.sessionRevision
      )
        return;
      if (snapshot.historyStale)
        for (const id of loaded.keys()) {
          const version = observed.get(id);
          if (
            version?.generation !== page.version.viewGeneration ||
            version.revision <= page.version.sessionRevision
          ) {
            loaded.delete(id);
            observed.delete(id);
          }
        }
      const hotIds = new Set(
        view.session.messages.map((message) => message.id),
      );
      for (const message of page.messages) {
        if (deleted.has(message.id) || hotIds.has(message.id)) continue;
        const version = observed.get(message.id);
        if (
          version?.generation === page.version.viewGeneration &&
          version.revision > page.version.sessionRevision
        )
          continue;
        loaded.set(message.id, message);
        observed.set(message.id, {
          generation: page.version.viewGeneration,
          revision: page.version.sessionRevision,
        });
      }
      historyLoaded = true;
      publish({
        ...snapshot,
        historyState: "ready",
        historyError: undefined,
        historyStale: false,
        historyBefore: page.before,
        historyHasMore: page.hasMore,
        view: install(view),
      });
    },
    invalidateSessionHistory(event): void {
      const view = snapshot.sessionSync.view;
      if (
        view?.version.sessionId !== event.version.sessionId ||
        view.version.runtimeEpoch !== event.version.runtimeEpoch ||
        view.version.viewGeneration !== event.version.viewGeneration ||
        event.version.sessionRevision <= view.version.sessionRevision ||
        event.bindingGeneration !== view.bindingGeneration
      )
        return;
      for (const id of event.removedMessageIds ?? []) {
        loaded.delete(id);
        observed.delete(id);
        deleted.add(id);
      }
      if (event.historyInvalidated)
        invalidatedAt = event.version.sessionRevision;
      if (event.historyInvalidated && historyLoaded)
        publish({
          ...snapshot,
          historyStale: true,
          historyBefore: view.history.before,
          historyHasMore: view.history.hasMore,
        });
    },
    setPermissionSync(permissionSync): void {
      publish({ ...snapshot, permissionSync });
    },
    setSessionIndex(sessionIndex): void {
      publish({ ...snapshot, sessionIndex });
    },
    applyEvent(event, seqNum, _source = "incremental"): boolean {
      if (
        event.type === "permission.requested" ||
        event.type === "permission.resolved" ||
        event.type === "permission.unavailable" ||
        event.type === "permission.resync-required"
      )
        return false;
      if (
        event.type === "snapshot.replaced" ||
        event.type === "session.changed" ||
        event.type === "session.unavailable"
      )
        return false;
      const nextView = reduceUiEvent(snapshot.view, event, seqNum);
      if (nextView === snapshot.view) {
        return false;
      }
      publish({
        ...snapshot,
        view: nextView,
      });
      return true;
    },
    getSnapshot(): StoreSnapshot {
      return snapshot;
    },
    replaceSnapshot(nextSnapshot, seqNum): void {
      publish({
        ...snapshot,
        view: replaceSnapshot(nextSnapshot, seqNum),
      });
    },
    reset(): void {
      loaded.clear();
      observed.clear();
      deleted.clear();
      invalidatedAt = -1;
      historyLoaded = false;
      publish(initial());
    },
    setConnectionState(state): void {
      if (snapshot.connectionState === state) {
        return;
      }
      publish({ ...snapshot, connectionState: state });
    },
    setCurrentModel(model): void {
      if (snapshot.currentModel === model) {
        return;
      }
      publish({ ...snapshot, currentModel: model });
    },
    setError(error): void {
      if (snapshot.error === error) {
        return;
      }
      publish({ ...snapshot, error });
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
