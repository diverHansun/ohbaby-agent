import type {
  UiCommandOutput,
  UiInteractionRequest,
  UiMessage,
  UiMessagePart,
  UiNotice,
  UiPolicyState,
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
const UI_NOTICE_LIMIT = 10;

export function createStateFromSnapshot(snapshot: UiSnapshot): TuiStoreState {
  const activeSession = findActiveSession(snapshot);

  return {
    activeSessionId: snapshot.activeSessionId,
    catalog: null,
    catalogInvalidation: null,
    commandNotices: [],
    commandNoticeSequence: 0,
    resolvedPermissionIds: [],
    interactions: [],
    messages: activeSession?.messages ?? [],
    notices: [],
    permissions: snapshot.permissions,
    policy: snapshot.policy,
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
      return preserveLocalQueues(
        state,
        createStateFromSnapshot(event.snapshot),
      );

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
      if (state.resolvedPermissionIds.includes(event.request.id)) {
        return state;
      }
      return rebuildWithPermissions(state, {
        permissions: upsertById(state.permissions, event.request),
        runtime: {
          kind: "waiting-for-permission",
          requestId: event.request.id,
        },
      });

    case "permission.resolved":
      return rebuildWithPermissions(
        {
          ...state,
          resolvedPermissionIds: rememberResolvedPermission(
            state.resolvedPermissionIds,
            event.requestId,
          ),
        },
        {
          permissions: state.permissions.filter(
            (request) => request.id !== event.requestId,
          ),
        },
      );

    case "policy.updated":
      return rebuildFromCollections(state, {
        policy: event.policy,
      });

    case "notice.emitted":
      return appendUiNotice(state, event.notice);

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
  const permissions = mergePermissions(
    previous.permissions,
    next.permissions,
    previous.resolvedPermissionIds,
  );
  return {
    ...next,
    catalog: previous.catalog,
    catalogInvalidation: previous.catalogInvalidation,
    commandNotices: previous.commandNotices,
    commandNoticeSequence: previous.commandNoticeSequence,
    interactions: previous.interactions,
    notices: previous.notices,
    permissions,
    resolvedPermissionIds: previous.resolvedPermissionIds,
    runtime:
      permissions.length > 0
        ? { kind: "waiting-for-permission", requestId: permissions[0].id }
        : next.runtime,
  };
}

function rebuildFromCollections(
  state: TuiStoreState,
  patch: {
    readonly activeSessionId?: string | null;
    readonly sessions?: readonly UiSession[];
    readonly runs?: readonly UiRun[];
    readonly permissions?: readonly UiPermissionRequest[];
    readonly policy?: UiPolicyState;
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
  const policy = patch.policy ?? state.policy;
  const runtime = patch.runtime ?? state.runtime;
  const snapshot: UiSnapshot = {
    activeSessionId,
    permissions,
    runs,
    sessions,
    status: runtime,
    ...(policy === undefined ? {} : { policy }),
  };

  return {
    ...state,
    activeSessionId,
    messages:
      sessions.find((session) => session.id === activeSessionId)?.messages ??
      [],
    permissions,
    policy,
    runs,
    runtime,
    sessions,
    snapshot,
  };
}

function rebuildWithPermissions(
  state: TuiStoreState,
  patch: {
    readonly permissions: readonly UiPermissionRequest[];
    readonly runtime?: TuiRuntimeStatus;
  },
): TuiStoreState {
  const runtime =
    patch.permissions.length > 0
      ? {
          kind: "waiting-for-permission" as const,
          requestId: patch.permissions[0].id,
        }
      : (patch.runtime ??
        (state.runtime.kind === "waiting-for-permission"
          ? { kind: "idle" as const }
          : state.runtime));

  return rebuildFromCollections(state, {
    permissions: patch.permissions,
    runtime,
  });
}

function mergePermissions(
  previous: readonly UiPermissionRequest[],
  next: readonly UiPermissionRequest[],
  resolvedPermissionIds: readonly string[],
): readonly UiPermissionRequest[] {
  const resolved = new Set(resolvedPermissionIds);
  const merged = new Map<string, UiPermissionRequest>();

  for (const request of next) {
    if (!resolved.has(request.id)) {
      merged.set(request.id, request);
    }
  }
  for (const request of previous) {
    if (!resolved.has(request.id) && !merged.has(request.id)) {
      merged.set(request.id, request);
    }
  }

  return Array.from(merged.values());
}

function rememberResolvedPermission(
  resolvedPermissionIds: readonly string[],
  requestId: string,
): readonly string[] {
  return [
    ...resolvedPermissionIds.filter((id) => id !== requestId),
    requestId,
  ].slice(-100);
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
  partId: string | undefined,
  delta: string,
  content: string | undefined,
): UiMessage {
  const resolvedIndex = resolvePartIndex(message, partId);

  if (resolvedIndex === null) {
    return content === undefined
      ? appendDeltaToLastTextPart(message, delta)
      : upsertLastTextPart(message, content);
  }

  return {
    ...message,
    parts: message.parts.map((part, index) =>
      index === resolvedIndex
        ? appendTextToPart(part, content ?? delta, content !== undefined)
        : part,
    ),
  };
}

function resolvePartIndex(
  message: UiMessage,
  partId: string | undefined,
): number | null {
  if (partId === undefined) {
    return null;
  }

  const resolvedIndex = message.parts.findIndex((part) => {
    const candidate = part as { readonly id?: string };

    return candidate.id === partId;
  });

  return resolvedIndex >= 0 ? resolvedIndex : null;
}

function appendTextToPart(
  part: UiMessagePart,
  text: string,
  replace = false,
): UiMessagePart {
  if (part.type === "text" || part.type === "reasoning") {
    return {
      ...part,
      text: replace ? text : `${part.text}${text}`,
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
    parts: message.parts.map(
      (part, index): UiMessagePart =>
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

function appendUiNotice(state: TuiStoreState, notice: UiNotice): TuiStoreState {
  const dedupeId = notice.key ?? notice.id;
  const notices = [
    ...state.notices.filter(
      (candidate) => (candidate.key ?? candidate.id) !== dedupeId,
    ),
    notice,
  ].slice(-UI_NOTICE_LIMIT);

  return {
    ...state,
    notices,
  };
}
