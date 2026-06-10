import type {
  UiCommandOutput,
  UiContextWindowUsage,
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
import { renderStatusPanel } from "../render/status-panel.js";
import {
  advanceTranscriptCommit,
  type TranscriptCommitState,
} from "./transcript.js";

const COMMAND_NOTICE_LIMIT = 20;
const COMMAND_SESSION_LIMIT = 100;
const COMMAND_NOTICE_TEXT_LIMIT = 240;
const UI_NOTICE_LIMIT = 10;

export function createStateFromSnapshot(snapshot: UiSnapshot): TuiStoreState {
  const activeSession = findActiveSession(snapshot);
  const messages = activeSession?.messages ?? [];
  const transcript = advanceTranscriptCommit(
    undefined,
    messages,
    snapshot.status,
  );

  return {
    activeSessionId: snapshot.activeSessionId,
    catalog: null,
    catalogInvalidation: null,
    commandNotices: [],
    commandNoticeSequence: 0,
    commandSessionIds: {},
    contextWindowUsages: snapshot.contextWindowUsages ?? [],
    resolvedPermissionIds: [],
    interactions: [],
    committedItems: transcript.committedItems,
    committedPartCounts: transcript.committedPartCounts,
    liveMessage: transcript.liveMessage,
    messages,
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

    case "message.appended": {
      const next = rebuildFromCollections(state, {
        activeSessionId: state.activeSessionId ?? event.sessionId,
        sessions: updateSessionMessages(
          state.sessions,
          event.sessionId,
          (messages) => [...messages, event.message],
        ),
      });
      return event.message.role === "user" &&
        next.activeSessionId === event.sessionId
        ? clearEphemeralNotices(clearCommandNotices(next))
        : next;
    }

    case "message.updated":
      return rebuildFromCollections(state, {
        sessions: updateSessionMessages(
          state.sessions,
          event.sessionId,
          (messages) => upsertById(messages, event.message),
        ),
      });

    case "message.part.delta":
      if (
        event.messageId &&
        event.sessionId === state.activeSessionId &&
        !state.messages.some((message) => message.id === event.messageId)
      ) {
        return appendUiNotice(state, {
          createdAt: new Date(event.timestamp ?? Date.now()).toISOString(),
          id: `message_delta_${event.sessionId}_${event.messageId}`,
          key: `message-delta:${event.sessionId}:${event.messageId}`,
          level: "warning",
          message: `Dropped streaming delta for missing message ${event.messageId}.`,
          source: "transcript",
          title: "Message unavailable",
        });
      }

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

    case "run.updated": {
      const next = rebuildFromCollections(state, {
        runs: upsertById(state.runs, event.run),
        runtime: event.run.status,
      });
      return event.run.status.kind === "running" &&
        event.run.sessionId === next.activeSessionId
        ? clearEphemeralNotices(clearCommandNotices(next))
        : next;
    }

    case "runtime.updated": {
      const next = rebuildFromCollections(state, {
        runtime: event.status,
      });
      return event.status.kind === "running"
        ? clearEphemeralNotices(clearCommandNotices(next))
        : next;
    }

    case "context.window.updated":
      return rebuildFromCollections(state, {
        contextWindowUsages: upsertContextWindowUsage(
          state.contextWindowUsages,
          event.usage,
        ),
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

    case "command.started": {
      const next = {
        ...state,
        commandSessionIds: rememberCommandSessionId(
          state.commandSessionIds,
          event.command.commandRunId,
          event.command.sessionId,
        ),
      };
      if (event.command.commandId !== "compact") {
        return next;
      }
      return clearEphemeralNotices(
        rebuildFromCollections(next, {
          runtime: {
            kind: "running",
            runId: event.command.commandRunId,
            title: "Compacting...",
          },
        }),
      );
    }

    case "command.result.delivered": {
      const next = clearCommandRuntime(state, event.commandRunId);
      if (!event.output || !shouldDisplayCommandOutput(event.output)) {
        return next;
      }
      if (!shouldDisplayCommandNotice(next, event.commandRunId)) {
        return next;
      }
      return appendCommandNotice(next, {
        clientInvocationId: event.clientInvocationId,
        commandId: event.commandRunId,
        kind: "result",
        sessionId: commandSessionId(next, event.commandRunId) ?? undefined,
        text: formatCommandOutput(event.output),
      });
    }

    case "command.failed": {
      const next = clearCommandRuntime(state, event.commandRunId);
      if (!shouldDisplayCommandNotice(next, event.commandRunId)) {
        return next;
      }
      return appendCommandNotice(next, {
        clientInvocationId: event.clientInvocationId,
        commandId: event.commandRunId,
        kind: "error",
        sessionId: commandSessionId(next, event.commandRunId) ?? undefined,
        text: event.error.message,
      });
    }

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
      const nextState = applyTuiEvent(state, event);
      if (nextState !== state) {
        state = nextState;
        notify();
      }
    },
    dispatchMany(events): void {
      let nextState = state;
      for (const event of events) {
        nextState = applyTuiEvent(nextState, event);
      }
      if (nextState !== state) {
        state = nextState;
        notify();
      }
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
  const contextWindowUsages = mergeContextWindowUsages(
    next.contextWindowUsages,
    previous.contextWindowUsages,
  );
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
    ...(contextWindowUsages.length > 0 ? { contextWindowUsages } : {}),
    ...(permission === undefined ? {} : { permission }),
  };
  const messages =
    sessions.find((session) => session.id === next.activeSessionId)?.messages ??
    [];
  const transcript = resolveTranscriptState(
    activeSessionChanged ? undefined : previous,
    next.activeSessionId,
    messages,
    runtime,
  );

  return {
    ...next,
    catalog: previous.catalog,
    catalogInvalidation: previous.catalogInvalidation,
    commandNotices: activeSessionChanged ? [] : previous.commandNotices,
    commandNoticeSequence: previous.commandNoticeSequence,
    commandSessionIds: previous.commandSessionIds,
    contextWindowUsages,
    interactions: previous.interactions,
    committedItems: transcript.committedItems,
    committedPartCounts: transcript.committedPartCounts,
    liveMessage: transcript.liveMessage,
    messages,
    notices: activeSessionChanged
      ? previous.notices.filter((notice) =>
          noticeBelongsToActiveSession(notice, next.activeSessionId),
        )
      : previous.notices,
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
    readonly contextWindowUsages?: readonly UiContextWindowUsage[];
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
  const contextWindowUsages =
    patch.contextWindowUsages ?? state.contextWindowUsages;
  const snapshot: UiSnapshot = {
    activeSessionId,
    permissions,
    runs,
    sessions,
    status: runtime,
    ...(contextWindowUsages.length > 0 ? { contextWindowUsages } : {}),
    ...(permission === undefined ? {} : { permission }),
  };
  const messages =
    sessions.find((session) => session.id === activeSessionId)?.messages ?? [];
  const transcript = resolveTranscriptState(
    state,
    activeSessionId,
    messages,
    runtime,
  );

  return {
    ...state,
    activeSessionId,
    committedItems: transcript.committedItems,
    committedPartCounts: transcript.committedPartCounts,
    contextWindowUsages,
    liveMessage: transcript.liveMessage,
    messages,
    permissions,
    permission,
    runs,
    runtime,
    sessions,
    snapshot,
  };
}

function resolveTranscriptState(
  previous: TuiStoreState | undefined,
  activeSessionId: string | null,
  messages: readonly UiMessage[],
  runtime: TuiRuntimeStatus,
): TranscriptCommitState {
  // A session switch starts a fresh transcript: committed items are rebuilt
  // wholesale because the viewport remounts its <Static> region.
  const previousCommit =
    previous?.activeSessionId === activeSessionId
      ? {
          committedItems: previous.committedItems,
          committedPartCounts: previous.committedPartCounts,
          liveMessage: previous.liveMessage,
        }
      : undefined;

  return advanceTranscriptCommit(previousCommit, messages, runtime);
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

function mergeContextWindowUsages(
  next: readonly UiContextWindowUsage[],
  previous: readonly UiContextWindowUsage[],
): readonly UiContextWindowUsage[] {
  const merged = new Map<string, UiContextWindowUsage>();

  for (const usage of previous) {
    merged.set(usage.sessionId, usage);
  }
  for (const usage of next) {
    merged.set(usage.sessionId, usage);
  }

  return Array.from(merged.values());
}

function upsertContextWindowUsage(
  usages: readonly UiContextWindowUsage[],
  usage: UiContextWindowUsage,
): readonly UiContextWindowUsage[] {
  const index = usages.findIndex(
    (candidate) => candidate.sessionId === usage.sessionId,
  );

  if (index === -1) {
    return [...usages, usage];
  }

  return usages.map((candidate) =>
    candidate.sessionId === usage.sessionId ? usage : candidate,
  );
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
  const textIndex = findTailTextPartIndex(message);

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
  const textIndex = findTailTextPartIndex(message);

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

function findTailTextPartIndex(message: UiMessage): number {
  const lastIndex = message.parts.length - 1;
  const lastPart = message.parts.at(lastIndex);

  return lastPart?.type === "text" || lastPart?.type === "reasoning"
    ? lastIndex
    : -1;
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

function shouldDisplayCommandOutput(output: UiCommandOutput): boolean {
  if (output.kind !== "data") {
    return true;
  }

  return ![
    "permission.level",
    "permission.mode",
    "session.created",
    "session.current",
  ].includes(output.subject);
}

function formatPermissionOutput(
  permission: Record<string, unknown> | undefined,
): string | undefined {
  const mode = permission ? getString(permission, "mode") : undefined;
  const level = permission ? getString(permission, "level") : undefined;
  if (!mode || !level) {
    return undefined;
  }

  return `${mode} · ${level}`;
}

function formatDataCommandOutput(
  output: Extract<UiCommandOutput, { readonly kind: "data" }>,
): string {
  switch (output.subject) {
    case "help": {
      const categories = Array.isArray(output.data.categories)
        ? output.data.categories
        : [];
      if (categories.length > 0) {
        return categories
          .map((category) =>
            isRecord(category) ? formatHelpCategory(category) : "",
          )
          .filter(Boolean)
          .join("\n\n");
      }
      const commands = Array.isArray(output.data.commands)
        ? output.data.commands
        : [];
      return commands.length > 0
        ? formatHelpCategory({ commands, title: "Commands" })
        : JSON.stringify(output.data);
    }
    case "permission.mode": {
      const permission = getRecord(output.data, "permission");
      return formatPermissionOutput(permission) ?? JSON.stringify(output.data);
    }
    case "permission.level": {
      const permission = getRecord(output.data, "permission");
      return formatPermissionOutput(permission) ?? JSON.stringify(output.data);
    }
    case "status": {
      return renderStatusPanel(output.data);
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
      switch (status) {
        case "compacted":
        case "pruned":
          return "Compacted";
        case "failed":
          return "Compact failed";
        case "inflated":
        case "not-needed":
          return "Compact skipped";
        default:
          return JSON.stringify(output.data);
      }
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
    case "models.current": {
      const model = getRecord(output.data, "current");
      const label = formatModelLabel(model);
      if (label) {
        return `model: ${label}`;
      }
      const models = formatModelList(output.data);
      return models.length > 0
        ? `models: ${models.join(", ")}`
        : JSON.stringify(output.data);
    }
    case "model.connected": {
      return formatModelConnectedOutput(output.data);
    }
    case "mcps": {
      const servers = Array.isArray(output.data.servers)
        ? output.data.servers
        : [];
      const labels = servers
        .map((server) => (isRecord(server) ? formatMcpServer(server) : null))
        .filter((server): server is string => Boolean(server));
      return labels.length > 0 ? `mcps: ${labels.join(", ")}` : "mcps: none";
    }
    case "skills": {
      const skills = Array.isArray(output.data.skills)
        ? output.data.skills
        : [];
      const labels = skills
        .map((skill) => (isRecord(skill) ? formatSkillSummary(skill) : null))
        .filter((skill): skill is string => Boolean(skill));
      return labels.length > 0
        ? `skills: ${labels.join(", ")}`
        : "skills: none";
    }
    default:
      return JSON.stringify(output.data);
  }
}

function formatModelConnectedOutput(data: Record<string, unknown>): string {
  const result = getRecord(data, "result");
  const model = result ? getString(result, "model") : undefined;
  const provider = result ? getString(result, "provider") : undefined;
  const contextWindowTokens = result
    ? getNumber(result, "contextWindowTokens")
    : undefined;
  const label = [provider, model].filter(Boolean).join("/");
  const context =
    contextWindowTokens === undefined
      ? ""
      : ` (${formatTokenCount(contextWindowTokens)} context tokens)`;
  const connected =
    label === "" ? "model connected" : `model connected: ${label}${context}`;
  const warning = result ? getString(result, "warning") : undefined;
  return warning === undefined
    ? connected
    : `${connected}\nwarning: ${warning}`;
}

function formatHelpCategory(category: Record<string, unknown>): string {
  const title =
    getString(category, "title") ?? getString(category, "name") ?? "Commands";
  const commands = Array.isArray(category.commands) ? category.commands : [];
  const lines = commands
    .map((command) => (isRecord(command) ? formatHelpCommand(command) : ""))
    .filter(Boolean);
  return lines.length > 0 ? `${title}:\n${lines.join("\n")}` : `${title}: none`;
}

function formatHelpCommand(command: Record<string, unknown>): string {
  const path = getStringArray(command, "path");
  const description = getString(command, "description") ?? "";
  const label = path.length > 0 ? `/${path.join(" ")}` : "/";
  return `  ${label}${description ? ` ${description}` : ""}`;
}

function formatMcpServer(server: Record<string, unknown>): string | null {
  const name = getString(server, "name");
  const status = getString(server, "status");
  if (!name || !status) {
    return null;
  }
  return `${name} ${status}`;
}

function formatSkillSummary(skill: Record<string, unknown>): string | null {
  const name = getString(skill, "name");
  const scope = getString(skill, "scope");
  if (!name || !scope) {
    return null;
  }
  const source = getString(skill, "source");
  const description = getString(skill, "description");
  const metadata = [scope, source].filter((value): value is string =>
    Boolean(value),
  );
  return `${name} [${metadata.join(", ")}]${
    description ? ` - ${description}` : ""
  }`;
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

function getStringArray(
  record: Record<string, unknown>,
  key: string,
): string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function formatModelLabel(
  model: Record<string, unknown> | undefined,
): string | undefined {
  if (!model) {
    return undefined;
  }
  return getString(model, "label") ?? getString(model, "id");
}

function formatModelList(data: Record<string, unknown>): string[] {
  return Array.isArray(data.models)
    ? data.models
        .map((model) => (isRecord(model) ? formatModelLabel(model) : null))
        .filter((model): model is string => Boolean(model))
    : [];
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

function clearCommandNotices(state: TuiStoreState): TuiStoreState {
  if (state.commandNotices.length === 0) {
    return state;
  }

  return {
    ...state,
    commandNotices: [],
  };
}

function clearCommandRuntime(
  state: TuiStoreState,
  commandRunId: string,
): TuiStoreState {
  return state.runtime.kind === "running" &&
    state.runtime.runId === commandRunId
    ? rebuildFromCollections(state, { runtime: { kind: "idle" } })
    : state;
}

function clearEphemeralNotices(state: TuiStoreState): TuiStoreState {
  const notices = state.notices.filter(isPersistentNotice);
  return notices.length === state.notices.length
    ? state
    : { ...state, notices };
}

function isPersistentNotice(notice: UiNotice): boolean {
  return (notice.key ?? notice.id).startsWith("prompt-security:");
}

function appendUiNotice(state: TuiStoreState, notice: UiNotice): TuiStoreState {
  if (!noticeBelongsToActiveSession(notice, state.activeSessionId)) {
    return state;
  }

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

function rememberCommandSessionId(
  commandSessionIds: Readonly<Record<string, string | null>>,
  commandRunId: string,
  sessionId: string | undefined,
): Readonly<Record<string, string | null>> {
  const entries = Object.entries(commandSessionIds).filter(
    ([existingCommandRunId]) => existingCommandRunId !== commandRunId,
  );
  entries.push([commandRunId, sessionId ?? null]);

  return Object.fromEntries(entries.slice(-COMMAND_SESSION_LIMIT));
}

function commandSessionId(
  state: TuiStoreState,
  commandRunId: string,
): string | null | undefined {
  return Object.hasOwn(state.commandSessionIds, commandRunId)
    ? state.commandSessionIds[commandRunId]
    : undefined;
}

function shouldDisplayCommandNotice(
  state: TuiStoreState,
  commandRunId: string,
): boolean {
  const sessionId = commandSessionId(state, commandRunId);

  return (
    sessionId === undefined ||
    sessionId === null ||
    sessionId === state.activeSessionId
  );
}

function noticeBelongsToActiveSession(
  notice: UiNotice,
  activeSessionId: string | null,
): boolean {
  const sessionId = noticeSessionId(notice);

  return sessionId === undefined || sessionId === activeSessionId;
}

function noticeSessionId(notice: UiNotice): string | undefined {
  const key = notice.key ?? "";
  if (key.startsWith("context-window:")) {
    return key.slice("context-window:".length);
  }
  if (key.startsWith("message-delta:")) {
    return key.slice("message-delta:".length).split(":").at(0);
  }

  return undefined;
}
