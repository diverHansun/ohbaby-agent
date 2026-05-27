import type {
  UiCommandOutput,
  UiInteractionRequest,
  UiMessage,
  UiMessagePart,
  UiNotice,
  UiPermissionState,
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
const COMMAND_NOTICE_TEXT_LIMIT = 240;
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
    permission: snapshot.permission,
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

    case "permission.updated":
      return rebuildFromCollections(state, {
        permission: event.permission,
      });

    case "notice.emitted":
      return appendUiNotice(state, event.notice);

    case "command.result.delivered":
      if (!event.output) {
        return state;
      }
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
  const activeSessionChanged =
    previous.activeSessionId !== next.activeSessionId;
  const permissions = mergePermissions(
    previous.permissions,
    next.permissions,
    previous.resolvedPermissionIds,
  );
  const sessions = mergeSessions(next.sessions, previous.sessions);
  const runs = mergeRuns(next.runs, previous.runs);
  const permission = previous.permission ?? next.permission;
  const runtime = resolveRuntimeAfterSnapshot(
    previous,
    next,
    permissions,
    runs,
  );
  const snapshot: UiSnapshot = {
    ...next.snapshot,
    permissions,
    runs,
    sessions,
    status: runtime,
    ...(permission === undefined ? {} : { permission }),
  };

  return {
    ...next,
    catalog: previous.catalog,
    catalogInvalidation: previous.catalogInvalidation,
    commandNotices: activeSessionChanged ? [] : previous.commandNotices,
    commandNoticeSequence: previous.commandNoticeSequence,
    interactions: previous.interactions,
    messages:
      sessions.find((session) => session.id === next.activeSessionId)
        ?.messages ?? [],
    notices: previous.notices,
    permissions,
    permission,
    resolvedPermissionIds: previous.resolvedPermissionIds,
    runs,
    runtime,
    sessions,
    snapshot,
  };
}

function rebuildFromCollections(
  state: TuiStoreState,
  patch: {
    readonly activeSessionId?: string | null;
    readonly sessions?: readonly UiSession[];
    readonly runs?: readonly UiRun[];
    readonly permissions?: readonly UiPermissionRequest[];
    readonly permission?: UiPermissionState;
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
  const permission = patch.permission ?? state.permission;
  const runtime = patch.runtime ?? state.runtime;
  const snapshot: UiSnapshot = {
    activeSessionId,
    permissions,
    runs,
    sessions,
    status: runtime,
    ...(permission === undefined ? {} : { permission }),
  };

  return {
    ...state,
    activeSessionId,
    messages:
      sessions.find((session) => session.id === activeSessionId)?.messages ??
      [],
    permissions,
    permission,
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
      : (patch.runtime ?? resolveRuntimeAfterPermission(state));

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

function mergeSessions(
  next: readonly UiSession[],
  previous: readonly UiSession[],
): readonly UiSession[] {
  const merged = new Map<string, UiSession>();

  for (const session of next) {
    merged.set(session.id, session);
  }
  for (const session of previous) {
    const existing = merged.get(session.id);
    merged.set(
      session.id,
      existing ? mergeSession(existing, session) : session,
    );
  }

  return Array.from(merged.values());
}

function mergeSession(next: UiSession, previous: UiSession): UiSession {
  const newerShell =
    compareIso(previous.updatedAt, next.updatedAt) > 0 ? previous : next;

  return {
    ...newerShell,
    messages: mergeMessages(next.messages, previous.messages),
  };
}

function mergeMessages(
  next: readonly UiMessage[],
  previous: readonly UiMessage[],
): readonly UiMessage[] {
  const merged = new Map<string, UiMessage>();

  for (const message of next) {
    merged.set(message.id, message);
  }
  for (const message of previous) {
    if (!merged.has(message.id)) {
      merged.set(message.id, message);
    }
  }

  return Array.from(merged.values()).sort((left, right) =>
    compareIso(left.createdAt, right.createdAt),
  );
}

function mergeRuns(
  next: readonly UiRun[],
  previous: readonly UiRun[],
): readonly UiRun[] {
  const merged = new Map<string, UiRun>();

  for (const run of next) {
    merged.set(run.id, run);
  }
  for (const run of previous) {
    const existing = merged.get(run.id);
    if (!existing || compareIso(run.updatedAt, existing.updatedAt) > 0) {
      merged.set(run.id, run);
    }
  }

  return Array.from(merged.values());
}

function compareIso(left: string, right: string): number {
  return Date.parse(left) - Date.parse(right);
}

function resolveRuntimeAfterSnapshot(
  previous: TuiStoreState,
  next: TuiStoreState,
  permissions: readonly UiPermissionRequest[],
  runs: readonly UiRun[],
): TuiRuntimeStatus {
  if (permissions.length > 0) {
    return { kind: "waiting-for-permission", requestId: permissions[0].id };
  }

  if (previous.runtime.kind === "running") {
    const running = previous.runtime;
    const run = runs.find((candidate) => candidate.id === running.runId);
    if (run?.status.kind === "running") {
      return running;
    }
  }

  return next.runtime;
}

function resolveRuntimeAfterPermission(state: TuiStoreState): TuiRuntimeStatus {
  if (state.runtime.kind !== "waiting-for-permission") {
    return state.runtime;
  }

  const waiting = state.runtime;
  const request = state.permissions.find(
    (candidate) => candidate.id === waiting.requestId,
  );
  const run = state.runs.find((candidate) => candidate.id === request?.runId);

  if (run?.status.kind === "running") {
    return run.status;
  }
  if (run?.status.kind === "waiting-for-permission") {
    return { kind: "running", runId: run.id };
  }

  return { kind: "idle" };
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
    return truncateCommandOutput(output.text);
  }

  if (output.kind === "markdown") {
    return truncateCommandOutput(output.markdown);
  }

  return truncateCommandOutput(formatDataCommandOutput(output));
}

function formatPermissionOutput(
  permission: Record<string, unknown> | undefined,
  focus: "mode" | "level",
): string | undefined {
  const mode = permission ? getString(permission, "mode") : undefined;
  const level = permission ? getString(permission, "level") : undefined;
  if (!mode || !level) {
    return undefined;
  }

  return focus === "mode"
    ? `mode: ${mode} | level: ${level}`
    : `level: ${level} | mode: ${mode}`;
}

function formatDataCommandOutput(
  output: Extract<UiCommandOutput, { readonly kind: "data" }>,
): string {
  switch (output.subject) {
    case "permission.mode": {
      const permission = getRecord(output.data, "permission");
      return (
        formatPermissionOutput(permission, "mode") ??
        JSON.stringify(output.data)
      );
    }
    case "permission.level": {
      const permission = getRecord(output.data, "permission");
      return (
        formatPermissionOutput(permission, "level") ??
        JSON.stringify(output.data)
      );
    }
    case "status": {
      const status = getString(output.data, "status");
      return status ? `status: ${status}` : JSON.stringify(output.data);
    }
    case "tools": {
      const tools = Array.isArray(output.data.tools)
        ? output.data.tools
            .map((tool) => (isRecord(tool) ? getString(tool, "name") : null))
            .filter((name): name is string => Boolean(name))
        : [];
      return tools.length > 0
        ? `tools: ${tools.join(", ")}`
        : JSON.stringify(output.data);
    }
    case "session.current": {
      const sessionId = getString(output.data, "sessionId");
      return sessionId ? `session: ${sessionId}` : JSON.stringify(output.data);
    }
    case "session.created": {
      const session = getRecord(output.data, "session");
      const title = session ? getString(session, "title") : undefined;
      const id = session ? getString(session, "id") : undefined;
      const label = title ?? id;
      return label ? `new session: ${label}` : JSON.stringify(output.data);
    }
    case "session.compact": {
      const result = getRecord(output.data, "result");
      const status = result ? getString(result, "status") : undefined;
      const usageBefore = result ? getRecord(result, "usageBefore") : undefined;
      const usageAfter = result ? getRecord(result, "usageAfter") : undefined;
      const before = usageBefore
        ? getNumber(usageBefore, "currentTokens")
        : undefined;
      const after = usageAfter
        ? getNumber(usageAfter, "currentTokens")
        : undefined;
      return status && before !== undefined && after !== undefined
        ? `compact: ${status} (${formatTokenCount(before)} -> ${formatTokenCount(
            after,
          )} tokens)`
        : JSON.stringify(output.data);
    }
    case "session.list": {
      const sessions = Array.isArray(output.data.sessions)
        ? output.data.sessions
            .map((session) =>
              isRecord(session)
                ? (getString(session, "title") ?? getString(session, "id"))
                : null,
            )
            .filter((session): session is string => Boolean(session))
        : [];
      return sessions.length > 0
        ? `sessions: ${sessions.join(", ")}`
        : "sessions: none";
    }
    case "model.current": {
      const model = getRecord(output.data, "model");
      const label = model
        ? (getString(model, "label") ?? getString(model, "id"))
        : undefined;
      return label ? `model: ${label}` : JSON.stringify(output.data);
    }
    case "model.list": {
      const models = Array.isArray(output.data.models)
        ? output.data.models
            .map((model) =>
              isRecord(model)
                ? (getString(model, "label") ?? getString(model, "id"))
                : null,
            )
            .filter((model): model is string => Boolean(model))
        : [];
      return models.length > 0
        ? `models: ${models.join(", ")}`
        : "models: none";
    }
    default:
      return JSON.stringify(output.data);
  }
}

function truncateCommandOutput(value: string): string {
  const normalized = value.trim();

  if (normalized.length <= COMMAND_NOTICE_TEXT_LIMIT) {
    return normalized;
  }

  return `${normalized.slice(0, COMMAND_NOTICE_TEXT_LIMIT - 3)}...`;
}

function getRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function getString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function getNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function formatTokenCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
