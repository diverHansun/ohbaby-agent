import type {
  UiCommandCompletion,
  UiCommandError,
  UiCommandInvocation,
  UiPromptSubmission,
} from "ohbaby-sdk";
import {
  createInitialViewState,
  reduceUiEvent,
  replaceSnapshot,
} from "../api/daemon/eventReducer.js";
import type {
  CommandNotice,
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
  beginCommand(invocation: UiCommandInvocation, overlay?: boolean): void;
  getCommandFeedback(
    clientInvocationId: string,
  ): { readonly error?: UiCommandError } | undefined;
  completeCommand(completion: UiCommandCompletion): void;
  failCommand(clientInvocationId: string, message: string): void;
  consumeCommand(clientInvocationId: string): void;
  clearCommands(): void;
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
  const loadedPrompts = new Map<string, UiPromptSubmission>();
  const listeners = new Set<StoreListener>();
  const commands = new Map<
    string,
    {
      invocation: UiCommandInvocation;
      consumed: boolean;
      overlay: boolean;
      events: number;
      outputs: number;
      lastSeq: number;
      completion?: UiCommandCompletion;
      error?: UiCommandError;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  function releaseCommand(id: string): void {
    const command = commands.get(id);
    if (command) clearTimeout(command.timer);
    commands.delete(id);
  }
  function clearCommands(): void {
    for (const id of commands.keys()) releaseCommand(id);
    snapshot = { ...snapshot, view: { ...snapshot.view, commandNotices: [] } };
  }
  function seedNotice(invocation: UiCommandInvocation): CommandNotice {
    return {
      id: invocation.clientInvocationId,
      commandId: invocation.commandId,
      sessionId: invocation.sessionId,
      path: invocation.path,
      createdAt: new Date().toISOString(),
      kind: "running",
      text: `/${invocation.path.join(" ")} running`,
    };
  }
  function commandError(id: string, message: string): void {
    const command = commands.get(id);
    if (!command || command.consumed || command.overlay) return;
    const existing = snapshot.view.commandNotices.find(
      (notice) => notice.id === id,
    );
    const notice = {
      ...(existing ?? seedNotice(command.invocation)),
      kind: "error" as const,
      text: existing?.kind === "error" ? existing.text : message,
    };
    snapshot = {
      ...snapshot,
      view: {
        ...snapshot.view,
        commandNotices: [
          ...snapshot.view.commandNotices.filter((item) => item.id !== id),
          notice,
        ].slice(-64),
      },
    };
  }
  function settleCommand(id: string): void {
    const command = commands.get(id);
    if (!command?.completion) return;
    if (
      command.events < command.completion.eventCount ||
      command.outputs < command.completion.outputCount
    )
      return;
    if (
      command.completion.outputCount === 0 &&
      command.completion.status === "completed"
    ) {
      snapshot = {
        ...snapshot,
        view: {
          ...snapshot.view,
          commandNotices: snapshot.view.commandNotices.filter(
            (notice) => notice.id !== id,
          ),
        },
      };
    }
    releaseCommand(id);
  }

  function publish(next: StoreSnapshot): void {
    const serverNow = next.view.snapshot?.serverNow;
    const durationSample =
      serverNow === undefined
        ? undefined
        : snapshot.durationSample?.serverNow === serverNow
          ? snapshot.durationSample
          : { serverNow, receivedAt: performance.now() };
    snapshot = { ...next, durationSample };
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

  function install(
    view: UiSessionView,
    serverNow = view.serverNow,
  ): StoreSnapshot["view"] {
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
        serverNow,
        prompts: [
          ...new Map([
            ...loadedPrompts,
            ...view.prompts.map((prompt) => [prompt.promptId, prompt] as const),
          ]).values(),
        ],
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
    beginCommand(invocation, overlay = false): void {
      if (commands.has(invocation.clientInvocationId))
        throw new Error("Command is already pending");
      if (commands.size >= 128) throw new Error("Too many pending commands");
      const id = invocation.clientInvocationId;
      const timer = setTimeout(() => {
        commandError(
          id,
          "Command result is unconfirmed. Check its effects before running it again.",
        );
        releaseCommand(id);
        publish(snapshot);
      }, 60_000);
      (timer as unknown as { unref?: () => void }).unref?.();
      commands.set(id, {
        invocation,
        overlay,
        consumed: false,
        events: 0,
        outputs: 0,
        lastSeq: snapshot.view.lastAppliedSeqNum,
        timer,
      });
      if (
        !overlay &&
        ["help", "status", "skills", "mcps"].includes(invocation.commandId)
      )
        snapshot = {
          ...snapshot,
          view: {
            ...snapshot.view,
            commandNotices: [
              ...snapshot.view.commandNotices,
              seedNotice(invocation),
            ].slice(-64),
          },
        };
      publish(snapshot);
    },
    getCommandFeedback(id): ReturnType<OhbabyWebStore["getCommandFeedback"]> {
      return commands.get(id);
    },
    completeCommand(completion): void {
      const command = commands.get(completion.clientInvocationId);
      if (!command) return;
      command.completion = completion;
      if (completion.status === "failed") {
        command.error ??= completion.error;
        commandError(completion.clientInvocationId, completion.error.message);
      }
      settleCommand(completion.clientInvocationId);
      publish(snapshot);
    },
    failCommand(id, message): void {
      commandError(id, message);
      releaseCommand(id);
      publish(snapshot);
    },
    consumeCommand(id): void {
      const command = commands.get(id);
      if (command) command.consumed = true;
      publish({
        ...snapshot,
        view: {
          ...snapshot.view,
          commandNotices: snapshot.view.commandNotices.filter(
            (notice) => notice.id !== id,
          ),
        },
      });
    },
    clearCommands(): void {
      clearCommands();
      publish(snapshot);
    },
    setSessionSync(sessionSync): void {
      const previous = snapshot.sessionSync;
      const changedScope =
        previous.scope?.sessionId !== sessionSync.scope?.sessionId ||
        previous.scope?.runtimeEpoch !== sessionSync.scope?.runtimeEpoch ||
        previous.scope?.bindingGeneration !==
          sessionSync.scope?.bindingGeneration;
      if (changedScope) {
        clearCommands();
        loaded.clear();
        loadedPrompts.clear();
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
              view: install(
                view,
                view === previous.view
                  ? snapshot.view.snapshot?.serverNow
                  : view.serverNow,
              ),
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
      for (const prompt of page.prompts) {
        if (prompt.sessionId !== view.session.id) continue;
        const previous = loadedPrompts.get(prompt.promptId);
        if (!previous || previous.updatedAt <= prompt.updatedAt)
          loadedPrompts.set(prompt.promptId, prompt);
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
        view: install(
          view,
          page.serverNow ?? snapshot.view.snapshot?.serverNow,
        ),
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
      let commandId: string | undefined;
      let hideCommand = false;
      if (
        event.type === "command.started" ||
        event.type === "command.result.delivered" ||
        event.type === "command.failed"
      ) {
        commandId =
          event.type === "command.started"
            ? event.command.clientInvocationId
            : event.clientInvocationId;
        const command = commands.get(commandId);
        if (
          !command ||
          seqNum <= command.lastSeq ||
          seqNum <= snapshot.view.lastAppliedSeqNum
        )
          return false;
        command.lastSeq = seqNum;
        hideCommand = command.consumed || command.overlay;
        if (event.type !== "command.started") {
          command.events += 1;
          if (event.type === "command.failed") command.error ??= event.error;
          if (event.type === "command.result.delivered" && event.output)
            command.outputs += 1;
          if (
            !hideCommand &&
            (event.type === "command.failed" || event.output) &&
            !snapshot.view.commandNotices.some(
              (notice) => notice.id === commandId,
            )
          )
            snapshot = {
              ...snapshot,
              view: {
                ...snapshot.view,
                commandNotices: [
                  ...snapshot.view.commandNotices,
                  seedNotice(command.invocation),
                ],
              },
            };
          event = { ...event, commandRunId: commandId };
        } else {
          // Registration owns origin and loading state; started can be missing or replayed.
          return false;
        }
      }
      let nextView = reduceUiEvent(snapshot.view, event, seqNum);
      if (hideCommand)
        nextView = {
          ...nextView,
          commandNotices: snapshot.view.commandNotices,
        };
      if (nextView === snapshot.view) {
        return false;
      }
      publish({
        ...snapshot,
        view:
          "timestamp" in event &&
          event.timestamp !== undefined &&
          nextView.snapshot
            ? {
                ...nextView,
                snapshot: { ...nextView.snapshot, serverNow: event.timestamp },
              }
            : nextView,
      });
      if (commandId) {
        settleCommand(commandId);
        publish(snapshot);
      }
      return true;
    },
    getSnapshot(): StoreSnapshot {
      return snapshot;
    },
    replaceSnapshot(nextSnapshot, seqNum): void {
      publish({
        ...snapshot,
        view: {
          ...replaceSnapshot(nextSnapshot, seqNum),
          commandNotices: snapshot.view.commandNotices,
        },
      });
    },
    reset(): void {
      clearCommands();
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
