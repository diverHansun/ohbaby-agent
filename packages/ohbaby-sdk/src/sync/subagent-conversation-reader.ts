import {
  applySessionChange,
  sameSessionGeneration,
} from "../contract/session-view.js";
import type { UiBackendClient } from "../contract/client.js";
import type { UiEvent } from "../contract/events.js";
import type { UiMessage } from "../contract/snapshot.js";
import type {
  UiSubagentConversationChangedEvent,
  UiSubagentConversationQuery,
  UiSubagentConversationSelection,
  UiSubagentConversationUnwatchQuery,
  UiSubagentConversationView,
  UiSubagentExecution,
} from "../contract/subagent.js";

export interface UiSubagentConversationReaderState {
  readonly selected?: UiSubagentExecution;
  readonly conversation?: UiSubagentConversationView;
  readonly loading: boolean;
  readonly locating: boolean;
  readonly reconnecting?: boolean;
  readonly error?: string;
}
export interface UiSubagentConversationReader {
  readonly getSnapshot: () => UiSubagentConversationReaderState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly select: (execution: UiSubagentExecution) => Promise<void>;
  readonly close: () => void;
  readonly refresh: () => Promise<void>;
  readonly loadEarlier: () => Promise<void>;
  readonly loadLater: () => Promise<void>;
  readonly jumpToLatest: () => Promise<void>;
  readonly dispose: () => void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mergeExecutions(
  old: readonly UiSubagentExecution[],
  incoming: readonly UiSubagentExecution[],
): readonly UiSubagentExecution[] {
  const byId = new Map(old.map((item) => [item.executionId, item]));
  for (const item of incoming) byId.set(item.executionId, item);
  return [...byId.values()].sort(
    (left, right) =>
      (left.delegationSequence ?? 0) - (right.delegationSequence ?? 0),
  );
}

/** Keep the server's delegation segments stable as queued rows become messages. */
export function compareSubagentMessages(
  messages: readonly UiMessage[],
  executions: readonly UiSubagentExecution[],
): readonly UiMessage[] {
  const byParent = new Map(
    executions.flatMap((execution) =>
      execution.childUserMessageId
        ? [[execution.childUserMessageId, execution] as const]
        : [],
    ),
  );
  const byRun = new Map(
    executions.flatMap((execution) =>
      execution.childRunId ? [[execution.childRunId, execution] as const] : [],
    ),
  );
  const startedExecutions = executions
    .filter(
      (
        execution,
      ): execution is UiSubagentExecution & { readonly startedAt: number } =>
        Boolean(execution.childRunId) &&
        execution.startedAt !== undefined &&
        Number.isFinite(execution.startedAt),
    )
    .sort(
      (left, right) =>
        (left.delegationSequence ?? 0) - (right.delegationSequence ?? 0) ||
        left.createdAt - right.createdAt ||
        left.executionId.localeCompare(right.executionId),
    );
  const byCompaction = new Map<string, UiSubagentExecution>();
  for (const message of messages) {
    if (
      message.runId !== undefined ||
      !message.parts.some(
        (part) =>
          part.type === "text" && part.metadata?.kind === "context-compaction",
      )
    )
      continue;
    const request = message.modelRequests?.find(
      (record) => record.purpose === "context-summary",
    );
    const at = request?.startedAt ?? Date.parse(message.createdAt);
    const execution = startedExecutions.find((candidate, index) => {
      const nextStartedAt = startedExecutions.at(index + 1)?.startedAt;
      return (
        at >= candidate.startedAt &&
        (candidate.completedAt === undefined || at <= candidate.completedAt) &&
        (nextStartedAt === undefined || at < nextStartedAt)
      );
    });
    if (execution) byCompaction.set(message.id, execution);
  }
  const owner = (message: UiMessage): UiSubagentExecution | undefined =>
    byParent.get(message.id) ??
    (message.runId ? byRun.get(message.runId) : undefined) ??
    byCompaction.get(message.id);
  return [...messages].sort((left, right) => {
    const leftOwner = owner(left);
    const rightOwner = owner(right);
    if (leftOwner !== rightOwner) {
      if (!leftOwner) return -1;
      if (!rightOwner) return 1;
      const sequence =
        (leftOwner.delegationSequence ?? 0) -
        (rightOwner.delegationSequence ?? 0);
      if (sequence !== 0) return sequence;
    }
    if (leftOwner && rightOwner) {
      const parentRank =
        Number(left.id !== leftOwner.childUserMessageId) -
        Number(right.id !== rightOwner.childUserMessageId);
      if (parentRank !== 0) return parentRank;
    }
    return (
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id)
    );
  });
}

function replaceMatchingMessages(
  window: readonly UiMessage[],
  live: readonly UiMessage[],
): readonly UiMessage[] {
  const byId = new Map(live.map((message) => [message.id, message]));
  return window.map((message) => byId.get(message.id) ?? message);
}

function mergePage(
  current: UiSubagentConversationView,
  page: UiSubagentConversationView,
  direction: "earlier" | "later",
): UiSubagentConversationView {
  const live = current.view.session.messages;
  const executions =
    page.view.version.sessionRevision < current.view.version.sessionRevision
      ? mergeExecutions(page.executions, current.executions)
      : mergeExecutions(current.executions, page.executions);
  const pageMessages = replaceMatchingMessages(page.messages, live);
  const byId = new Map<string, UiMessage>();
  for (const message of direction === "earlier"
    ? [...pageMessages, ...current.messages]
    : [...current.messages, ...pageMessages])
    byId.set(message.id, message);
  return {
    ...current,
    messages: compareSubagentMessages(
      replaceMatchingMessages([...byId.values()], live),
      executions,
    ),
    executions,
    history: {
      before:
        direction === "earlier" ? page.history.before : current.history.before,
      hasMore:
        direction === "earlier"
          ? page.history.hasMore
          : current.history.hasMore,
      after: direction === "later" ? page.history.after : current.history.after,
      hasLater:
        direction === "later"
          ? page.history.hasLater
          : current.history.hasLater,
    },
  };
}

function preserveReadingWindow(
  previous: UiSubagentConversationView | undefined,
  next: UiSubagentConversationView,
): UiSubagentConversationView {
  if (
    !previous?.messages.length ||
    !sameSessionGeneration(previous.view.version, next.view.version)
  )
    return next;
  const executions = mergeExecutions(previous.executions, next.executions);
  const previousIds = new Set(previous.messages.map((message) => message.id));
  // Only join windows when their overlap proves there is no unread gap.
  const joinsTail =
    !previous.history.hasLater &&
    next.messages.some((message) => previousIds.has(message.id));
  const messages = new Map(
    previous.messages.map((message) => [message.id, message]),
  );
  if (joinsTail) {
    const first = previous.messages[0];
    for (const message of next.messages)
      if (
        compareSubagentMessages([first, message], executions)[0].id === first.id
      )
        messages.set(message.id, message);
  }
  return {
    ...next,
    messages: compareSubagentMessages(
      replaceMatchingMessages(
        [...messages.values()],
        next.view.session.messages,
      ),
      executions,
    ),
    executions,
    anchorMessageId: previous.anchorMessageId,
    anchorFound: previous.anchorFound,
    history: {
      ...previous.history,
      after: joinsTail ? next.history.after : previous.history.after,
      hasLater: joinsTail ? next.history.hasLater : true,
    },
  };
}

/** One selected logical child, using the client's existing event subscription. */
export function createSubagentConversationReader(
  client: Partial<UiBackendClient>,
  rootSessionId: string,
): UiSubagentConversationReader {
  let state: UiSubagentConversationReaderState = {
    loading: false,
    locating: false,
  };
  let disposed = false;
  let closedSubagentId: string | undefined;
  let ticket = 0;
  let controller: AbortController | undefined;
  let watch: UiSubagentConversationSelection | undefined;
  let pendingWatch: UiSubagentConversationUnwatchQuery | undefined;
  let readingBaseline = false;
  let buffer: UiSubagentConversationChangedEvent[] = [];
  let bufferedBytes = 0;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<UiSubagentConversationReaderState>): void => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const release = (
    selection: UiSubagentConversationUnwatchQuery | undefined,
  ): void => {
    if (!selection) return;
    void client
      .unwatchSubagentConversation?.({
        ...selection,
        watchId: selection.watchId,
      })
      .catch(() => undefined);
  };
  const cancel = (): number => {
    ++ticket;
    release(pendingWatch);
    pendingWatch = undefined;
    controller?.abort();
    controller = undefined;
    buffer = [];
    bufferedBytes = 0;
    readingBaseline = false;
    return ticket;
  };
  const markClosed = (reason: string): void => {
    closedSubagentId = state.selected?.subagentId;
    cancel();
    release(watch);
    watch = undefined;
    publish({
      conversation: undefined,
      loading: false,
      locating: false,
      reconnecting: false,
      error: reason,
    });
  };
  const handleClosedError = (error: unknown): boolean => {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "SUBAGENT_CLOSED"
    )
      return false;
    markClosed(errorText(error));
    return true;
  };
  const isCurrent = (current: number, signal: AbortSignal): boolean =>
    current === ticket && !disposed && !signal.aborted;
  const query = (
    selected: UiSubagentExecution,
    signal: AbortSignal,
    extra: Partial<UiSubagentConversationQuery> = {},
  ): Promise<UiSubagentConversationView> => {
    if (!client.getSubagentConversationView)
      throw new Error("Subagent conversations are unavailable");
    return client.getSubagentConversationView({
      rootSessionId,
      subagentId: selected.subagentId,
      signal,
      ...extra,
    });
  };
  const validBaseline = (
    result: UiSubagentConversationView,
    selection: UiSubagentConversationSelection,
  ): boolean =>
    result.rootSessionId === rootSessionId &&
    result.subagentId === selection.subagentId &&
    result.view.version.runtimeEpoch === selection.runtimeEpoch &&
    Number.isSafeInteger(result.view.version.sessionRevision) &&
    result.view.version.sessionRevision >= 0 &&
    (result.view.bindingGeneration === undefined ||
      result.view.bindingGeneration === selection.bindingGeneration) &&
    result.view.session.id === result.view.version.sessionId;
  const applyChange = (
    conversation: UiSubagentConversationView,
    event: UiSubagentConversationChangedEvent,
  ): UiSubagentConversationView | undefined => {
    const nextView = applySessionChange(conversation.view, event.change);
    if (!nextView) return undefined;
    // Duplicate revisions cannot replace newer execution state with old Queued metadata.
    if (nextView === conversation.view) return conversation;
    const live = nextView.session.messages;
    const executions = event.executions
      ? mergeExecutions(conversation.executions, event.executions)
      : conversation.executions;
    const knownIds = new Set(conversation.messages.map((item) => item.id));
    const removed = new Set(event.change.removedMessageIds ?? []);
    const messages = replaceMatchingMessages(
      conversation.messages,
      live,
    ).filter((message) => !removed.has(message.id));
    if (!conversation.history.hasLater) {
      for (const message of event.change.messages ?? []) {
        if (!knownIds.has(message.id)) {
          const current = live.find((item) => item.id === message.id);
          const incoming = current ?? message;
          const first = conversation.messages.at(0);
          // An update outside an anchored window belongs in the live baseline,
          // not before the reader's selected delegation.
          if (
            conversation.history.hasMore &&
            first &&
            compareSubagentMessages([first, incoming], executions)[0].id !==
              first.id
          )
            continue;
          messages.push(incoming);
          knownIds.add(message.id);
        }
      }
    }
    return {
      ...conversation,
      view: nextView,
      messages: compareSubagentMessages(messages, executions),
      executions,
      ...(event.change.history === undefined
        ? {}
        : {
            history: {
              ...conversation.history,
              ...(conversation.history.hasLater ? {} : event.change.history),
            },
          }),
    };
  };
  const install = (
    result: UiSubagentConversationView,
    selection: UiSubagentConversationSelection,
  ): UiSubagentConversationView => {
    if (!validBaseline(result, selection))
      throw new Error("Invalid subagent conversation baseline");
    let next = {
      ...result,
      messages: compareSubagentMessages(result.messages, result.executions),
    };
    for (const event of buffer) {
      if (
        event.watchId !== selection.watchId ||
        event.rootSessionId !== rootSessionId ||
        event.subagentId !== selection.subagentId ||
        event.change.bindingGeneration !== selection.bindingGeneration
      )
        continue;
      if (!sameSessionGeneration(next.view.version, event.change.version))
        throw new Error("Subagent conversation generation changed");
      const applied = applyChange(next, event);
      if (!applied) throw new Error("Subagent conversation revision gap");
      next = applied;
    }
    buffer = [];
    bufferedBytes = 0;
    return next;
  };
  const startRead = async (
    selected: UiSubagentExecution,
    locate: boolean,
    preserveWindow = false,
  ): Promise<void> => {
    if (closedSubagentId === selected.subagentId) return;
    closedSubagentId = undefined;
    if (!client.watchSubagentConversation) {
      publish({
        loading: false,
        locating: false,
        error: "Subagent conversations are unavailable",
      });
      return;
    }
    const current = cancel();
    const oldWatch = watch;
    watch = undefined;
    release(oldWatch);
    const active = new AbortController();
    controller = active;
    readingBaseline = true;
    const requestedWatch = {
      rootSessionId,
      subagentId: selected.subagentId,
      watchId: globalThis.crypto.randomUUID(),
    };
    pendingWatch = requestedWatch;
    publish({
      selected,
      loading: true,
      locating: locate,
      reconnecting: false,
      error: undefined,
      ...(state.conversation?.subagentId === selected.subagentId
        ? {}
        : { conversation: undefined }),
    });
    let acquired: UiSubagentConversationSelection | undefined;
    try {
      acquired = await client.watchSubagentConversation({
        ...requestedWatch,
        signal: active.signal,
      });
      if (!isCurrent(current, active.signal)) {
        release(acquired);
        return;
      }
      if (
        acquired.rootSessionId !== rootSessionId ||
        acquired.subagentId !== selected.subagentId
      )
        throw new Error("Invalid subagent watch identity");
      watch = acquired;
      if (pendingWatch === requestedWatch) pendingWatch = undefined;
      const result = await query(selected, active.signal, {
        ...(locate ? { anchorExecutionId: selected.executionId } : {}),
      });
      if (!isCurrent(current, active.signal)) return;
      let next = install(result, acquired);
      if (preserveWindow)
        next = preserveReadingWindow(state.conversation, next);
      publish({
        conversation: next,
        loading: false,
        locating: false,
        reconnecting: false,
      });
    } catch (error) {
      // The server may have installed the watch even when its response was lost.
      if (pendingWatch === requestedWatch) {
        release(pendingWatch);
        pendingWatch = undefined;
      }
      if (acquired && watch !== acquired) release(acquired);
      if (current === ticket && !disposed && !active.signal.aborted) {
        if (!handleClosedError(error))
          publish({ loading: false, locating: false, error: errorText(error) });
      }
    } finally {
      if (current === ticket) readingBaseline = false;
      if (controller === active) controller = undefined;
    }
  };
  const refresh = async (): Promise<void> => {
    const selected = state.selected;
    if (!selected || closedSubagentId === selected.subagentId) return;
    if (!watch) return startRead(selected, false);
    const current = cancel();
    const selection = watch;
    const active = new AbortController();
    controller = active;
    readingBaseline = true;
    publish({ loading: true, reconnecting: true, error: undefined });
    try {
      const result = await query(selected, active.signal);
      if (current !== ticket || disposed || active.signal.aborted) return;
      const next = preserveReadingWindow(
        state.conversation,
        install(result, selection),
      );
      publish({ conversation: next, loading: false, reconnecting: false });
    } catch (error) {
      if (
        current === ticket &&
        !disposed &&
        !active.signal.aborted &&
        !handleClosedError(error)
      )
        publish({
          loading: false,
          reconnecting: false,
          error: errorText(error),
        });
    } finally {
      if (current === ticket) readingBaseline = false;
      if (controller === active) controller = undefined;
    }
  };
  const onEvent = (event: UiEvent): void => {
    if (
      disposed ||
      !state.selected ||
      closedSubagentId === state.selected.subagentId
    )
      return;
    if (event.type === "session.resync-required") {
      if (event.sessionId !== null && event.sessionId !== rootSessionId) return;
      publish({ reconnecting: true });
      if (!event.disconnected) void startRead(state.selected, false, true);
      return;
    }
    if (
      event.type !== "subagent.conversation.changed" &&
      event.type !== "subagent.conversation.unavailable"
    )
      return;
    if (
      event.rootSessionId !== rootSessionId ||
      event.subagentId !== state.selected.subagentId
    )
      return;
    if (watch && event.watchId !== watch.watchId) return;
    if (!watch && pendingWatch && event.watchId !== pendingWatch.watchId)
      return;
    if (event.type === "subagent.conversation.unavailable") {
      if (
        watch &&
        event.unavailable.bindingGeneration !== watch.bindingGeneration
      )
        return;
      if (event.code === "SUBAGENT_CLOSED") {
        markClosed(event.unavailable.reason);
        return;
      }
      publish({ reconnecting: true });
      void refresh();
      return;
    }
    if (readingBaseline || !state.conversation || !watch) {
      const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
      if (buffer.length >= 1024 || bufferedBytes + bytes > 4 * 1024 * 1024) {
        buffer = [];
        bufferedBytes = 0;
        publish({
          error: "Subagent event buffer exceeded",
          reconnecting: true,
        });
        void refresh();
        return;
      }
      buffer.push(event);
      bufferedBytes += bytes;
      return;
    }
    if (event.change.bindingGeneration !== watch.bindingGeneration) return;
    const applied = applyChange(state.conversation, event);
    if (applied) publish({ conversation: applied });
    else {
      publish({ reconnecting: true });
      void refresh();
    }
  };
  const unsubEvents = client.subscribeEvents?.(onEvent);
  const loadPage = async (direction: "earlier" | "later"): Promise<void> => {
    const selected = state.selected;
    const base = state.conversation;
    if (!selected || !base || !watch || state.loading) return;
    const cursor =
      direction === "earlier" ? base.history.before : base.history.after;
    const needed =
      direction === "earlier" ? base.history.hasMore : base.history.hasLater;
    if (!needed || !cursor) return;
    const current = ticket;
    const selection = watch;
    const active = new AbortController();
    controller = active;
    publish({ loading: true, error: undefined });
    try {
      const page = await query(selected, active.signal, {
        [direction === "earlier" ? "before" : "after"]: cursor,
      });
      if (current !== ticket || disposed || watch !== selection) return;
      const latest = state.conversation;
      if (
        !latest ||
        !sameSessionGeneration(latest.view.version, page.view.version)
      ) {
        void refresh();
        return;
      }
      publish({
        conversation: mergePage(latest, page, direction),
        loading: false,
      });
    } catch (error) {
      if (current === ticket && !disposed && !handleClosedError(error))
        publish({ loading: false, error: errorText(error) });
    } finally {
      if (controller === active) controller = undefined;
    }
  };
  return {
    getSnapshot: (): UiSubagentConversationReaderState => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    select: (execution: UiSubagentExecution): Promise<void> =>
      startRead(execution, true),
    close(): void {
      closedSubagentId = undefined;
      cancel();
      release(watch);
      watch = undefined;
      publish({
        selected: undefined,
        conversation: undefined,
        loading: false,
        locating: false,
        reconnecting: false,
        error: undefined,
      });
    },
    refresh,
    loadEarlier: (): Promise<void> => loadPage("earlier"),
    loadLater: (): Promise<void> => loadPage("later"),
    async jumpToLatest(): Promise<void> {
      const selected = state.selected;
      if (!selected || !watch) return;
      const current = cancel();
      const selection = watch;
      const active = new AbortController();
      controller = active;
      readingBaseline = true;
      publish({ loading: true, error: undefined });
      try {
        const result = await query(selected, active.signal);
        if (current !== ticket || disposed || watch !== selection) return;
        publish({
          conversation: install(result, selection),
          loading: false,
          locating: false,
        });
      } catch (error) {
        if (current === ticket && !disposed && !handleClosedError(error))
          publish({ loading: false, error: errorText(error) });
      } finally {
        if (current === ticket) readingBaseline = false;
        if (controller === active) controller = undefined;
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancel();
      release(watch);
      watch = undefined;
      unsubEvents?.();
      listeners.clear();
    },
  };
}
