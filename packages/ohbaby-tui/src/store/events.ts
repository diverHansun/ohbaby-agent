import type {
  UiCommandOutput,
  UiInteractionRequest,
  UiMessage,
  UiMessagePart,
  UiPermissionRequest,
  UiRun,
  UiSession,
  UiSnapshot,
} from "ohbaby-sdk";
import type {
  TuiCommandCatalog,
  TuiCommandNotice,
  TuiEvent,
  TuiInteractionRequest,
  TuiRuntimeStatus,
  TuiStore,
  TuiStoreState,
} from "./snapshot.js";

const COMMAND_NOTICE_LIMIT = 20;

export function createStateFromSnapshot(snapshot: UiSnapshot): TuiStoreState {
  const activeSession = findActiveSession(snapshot);

  return {
    activeSessionId: snapshot.activeSessionId,
    catalog: null,
    catalogInvalidation: null,
    commandNotices: [],
    commandNoticeSequence: 0,
    interactions: [],
    messages: activeSession?.messages ?? [],
    permissions: snapshot.permissions,
    runs: snapshot.runs,
    runtime: snapshot.status,
    sessions: snapshot.sessions,
    snapshot,
  };
}

export function applyTuiEvent(
  state: TuiStoreState,
  event: TuiEvent,
): TuiStoreState {
  switch (event.type) {
    case "snapshot.replaced":
      return preserveLocalQueues(state, createStateFromSnapshot(event.snapshot));

    case "session.updated":
      return rebuildFromCollections(state, {
        activeSessionId: state.activeSessionId ?? event.session.id,
        sessions: upsertById(state.sessions, event.session),
      });

    case "message.appended":
      return rebuildFromCollections(state, {
        activeSessionId: state.activeSessionId ?? event.sessionId,
        sessions: updateSessionMessages(
          state.sessions,
          event.sessionId,
          (messages) => [...messages, event.message],
        ),
      });

    case "message.updated":
      return rebuildFromCollections(state, {
        sessions: updateSessionMessages(
          state.sessions,
          event.sessionId,
          (messages) => upsertById(messages, event.message),
        ),
      });

    case "message.part.delta":
      return rebuildFromCollections(state, {
        sessions: updateSessionMessages(
          state.sessions,
          event.sessionId,
          (messages) =>
            messages.map((message) =>
              event.messageId !== undefined && message.id === event.messageId
                ? applyPartDelta(
                    message,
                    "partIndex" in event ? event.partIndex : undefined,
                    event.partId,
                    event.delta,
                    event.content,
                  )
                : message,
            ),
        ),
      });

    case "run.updated":
      return rebuildFromCollections(state, {
        runs: upsertById(state.runs, event.run),
        runtime: event.run.status,
      });

    case "runtime.updated":
      return rebuildFromCollections(state, {
        runtime: event.status,
      });

    case "permission.requested":
      return rebuildFromCollections(state, {
        permissions: upsertById(state.permissions, event.request),
        runtime: {
          kind: "waiting-for-permission",
          requestId: event.request.id,
        },
      });

    case "permission.resolved":
      return rebuildFromCollections(state, {
        permissions: state.permissions.filter(
          (request) => request.id !== event.requestId,
        ),
        runtime:
          state.runtime.kind === "waiting-for-permission" &&
          state.runtime.requestId === event.requestId
            ? { kind: "idle" }
            : state.runtime,
      });

    case "command.result.delivered":
      return appendCommandNotice(state, {
        clientInvocationId: event.clientInvocationId,
        commandId: event.commandRunId,
        kind: "result",
        text: formatCommandOutput(event.output),
      });

    case "command.failed":
      return appendCommandNotice(state, {
        clientInvocationId: event.clientInvocationId,
        commandId: event.commandRunId,
        kind: "error",
        text: event.error.message,
      });

    case "command.catalog.updated":
      return {
        ...state,
        catalogInvalidation: {
          reason: event.reason,
          version: event.version,
        },
      };

    case "interaction.requested":
      return {
        ...state,
        interactions: upsertInteraction(
          state.interactions,
          toTuiInteraction(event.request),
        ),
      };

    case "interaction.resolved":
      return {
        ...state,
        interactions: state.interactions.filter(
          (interaction) => interaction.interactionId !== event.interactionId,
        ),
      };
  }

  return state;
}

export function setCommandCatalog(
  state: TuiStoreState,
  catalog: TuiCommandCatalog,
): TuiStoreState {
  return {
    ...state,
    catalog,
    catalogInvalidation: null,
  };
}

export function createTuiStore(snapshot: UiSnapshot): TuiStore {
  let state = createStateFromSnapshot(snapshot);
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    dispatch(event): void {
      state = applyTuiEvent(state, event);
      notify();
    },
    getState(): TuiStoreState {
      return state;
    },
    replaceSnapshot(nextSnapshot): void {
      state = applyTuiEvent(state, {
        snapshot: nextSnapshot,
        type: "snapshot.replaced",
      });
      notify();
    },
    setCatalog(catalog): void {
      state = setCommandCatalog(state, catalog);
      notify();
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function findActiveSession(snapshot: UiSnapshot): UiSession | undefined {
  return snapshot.sessions.find(
    (session) => session.id === snapshot.activeSessionId,
  );
}

function preserveLocalQueues(
  previous: TuiStoreState,
  next: TuiStoreState,
): TuiStoreState {
  return {
    ...next,
    catalog: previous.catalog,
    catalogInvalidation: null,
    commandNotices: [],
    commandNoticeSequence: previous.commandNoticeSequence,
    interactions: [],
  };
}

function rebuildFromCollections(
  state: TuiStoreState,
  patch: {
    readonly activeSessionId?: string | null;
    readonly sessions?: readonly UiSession[];
    readonly runs?: readonly UiRun[];
    readonly permissions?: readonly UiPermissionRequest[];
    readonly runtime?: TuiRuntimeStatus;
  },
): TuiStoreState {
  const activeSessionId =
    patch.activeSessionId === undefined
      ? state.activeSessionId
      : patch.activeSessionId;
  const sessions = patch.sessions ?? state.sessions;
  const runs = patch.runs ?? state.runs;
  const permissions = patch.permissions ?? state.permissions;
  const runtime = patch.runtime ?? state.runtime;
  const snapshot: UiSnapshot = {
    activeSessionId,
    permissions,
    runs,
    sessions,
    status: runtime,
  };

  return {
    ...state,
    activeSessionId,
    messages:
      sessions.find((session) => session.id === activeSessionId)?.messages ??
      [],
    permissions,
    runs,
    runtime,
    sessions,
    snapshot,
  };
}

function updateSessionMessages(
  sessions: readonly UiSession[],
  sessionId: string,
  update: (messages: readonly UiMessage[]) => readonly UiMessage[],
): readonly UiSession[] {
  return sessions.map((session) =>
    session.id === sessionId
      ? {
          ...session,
          messages: update(session.messages),
        }
      : session,
  );
}

function applyPartDelta(
  message: UiMessage,
  partIndex: number | undefined,
  partId: string | undefined,
  delta: string,
  content: string | undefined,
): UiMessage {
  const resolvedIndex = resolvePartIndex(message, partIndex, partId);

  if (resolvedIndex === null) {
    return content === undefined
      ? appendDeltaToLastTextPart(message, delta)
      : upsertLastTextPart(message, content);
  }

  return {
    ...message,
    parts: message.parts.map((part, index) =>
      index === resolvedIndex ? appendTextToPart(part, delta) : part,
    ),
  };
}

function resolvePartIndex(
  message: UiMessage,
  partIndex: number | undefined,
  partId: string | undefined,
): number | null {
  if (partIndex !== undefined) {
    return partIndex >= 0 && partIndex < message.parts.length
      ? partIndex
      : null;
  }

  if (partId === undefined) {
    return null;
  }

  const resolvedIndex = message.parts.findIndex((part) => {
    const candidate = part as { readonly id?: string };

    return candidate.id === partId;
  });

  return resolvedIndex >= 0 ? resolvedIndex : null;
}

function appendTextToPart(part: UiMessagePart, delta: string): UiMessagePart {
  if (part.type === "text" || part.type === "reasoning") {
    return {
      ...part,
      text: `${part.text}${delta}`,
    };
  }

  return part;
}

function appendDeltaToLastTextPart(
  message: UiMessage,
  delta: string,
): UiMessage {
  const textIndex = findLastTextPartIndex(message);

  if (textIndex === -1) {
    return {
      ...message,
      parts: [...message.parts, { text: delta, type: "text" }],
    };
  }

  return {
    ...message,
    parts: message.parts.map((part, index) =>
      index === textIndex ? appendTextToPart(part, delta) : part,
    ),
  };
}

function upsertLastTextPart(message: UiMessage, content: string): UiMessage {
  const textIndex = findLastTextPartIndex(message);

  if (textIndex === -1) {
    return {
      ...message,
      parts: [...message.parts, { text: content, type: "text" }],
    };
  }

  return {
    ...message,
    parts: message.parts.map((part, index): UiMessagePart =>
      index === textIndex &&
      (part.type === "text" || part.type === "reasoning")
        ? { ...part, text: content }
        : part,
    ),
  };
}

function findLastTextPartIndex(message: UiMessage): number {
  return message.parts.findLastIndex(
    (part) => part.type === "text" || part.type === "reasoning",
  );
}

function formatCommandOutput(output: UiCommandOutput | undefined): string {
  if (!output) {
    return "";
  }

  if (output.kind === "text") {
    return output.text;
  }

  if (output.kind === "markdown") {
    return output.markdown;
  }

  return JSON.stringify(output.data);
}

function toTuiInteraction(
  interaction: UiInteractionRequest,
): TuiInteractionRequest {
  return {
    interactionId: interaction.interactionId,
    kind: interaction.kind,
    message: interaction.prompt,
    options: interaction.options,
    subject: interaction.subject,
    title: interaction.prompt,
  };
}

function upsertById<TItem extends { readonly id: string }>(
  items: readonly TItem[],
  item: TItem,
): readonly TItem[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);

  if (index === -1) {
    return [...items, item];
  }

  return items.map((candidate) =>
    candidate.id === item.id ? item : candidate,
  );
}

function upsertInteraction(
  interactions: readonly TuiInteractionRequest[],
  interaction: TuiInteractionRequest,
): readonly TuiInteractionRequest[] {
  const index = interactions.findIndex(
    (candidate) => candidate.interactionId === interaction.interactionId,
  );

  if (index === -1) {
    return [...interactions, interaction];
  }

  return interactions.map((candidate) =>
    candidate.interactionId === interaction.interactionId
      ? interaction
      : candidate,
  );
}

function appendCommandNotice(
  state: TuiStoreState,
  notice: Omit<TuiCommandNotice, "id">,
): TuiStoreState {
  const commandNoticeSequence = state.commandNoticeSequence + 1;

  return {
    ...state,
    commandNotices: [
      ...state.commandNotices,
      {
        ...notice,
        id: `notice_${String(commandNoticeSequence)}`,
      },
    ].slice(-COMMAND_NOTICE_LIMIT),
    commandNoticeSequence,
  };
}
