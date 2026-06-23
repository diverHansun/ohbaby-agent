import type {
  SubmitPromptOptions,
  UiBackendClient,
  UiEvent,
  UiSnapshot,
} from "ohbaby-sdk";
import type { DaemonStartupIntent } from "../protocols/jsonrpc/protocol.js";
import type { DaemonPromptQueueItem } from "./prompt-queue.js";

interface ClientView {
  activeSessionId?: string | null;
  readonly initialPermission?: DaemonStartupIntent["initialPermission"];
  pendingSessionId?: string;
}

export interface PreparedPromptSubmit {
  readonly options?: SubmitPromptOptions;
  readonly sessionId?: string;
}

type ExecuteCommandInvocation = Parameters<
  UiBackendClient["executeCommand"]
>[0];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseDaemonStartupIntent(value: unknown): DaemonStartupIntent {
  if (!isRecord(value)) {
    return {};
  }
  let startupSessionMode: DaemonStartupIntent["startupSessionMode"];
  if (isRecord(value.startupSessionMode)) {
    const type = value.startupSessionMode.type;
    if (type === "continue" || type === "fresh") {
      startupSessionMode = { type };
    }
  }
  const resumeSessionId =
    typeof value.resumeSessionId === "string"
      ? value.resumeSessionId
      : undefined;
  const rawInitialPermission = value.initialPermission;
  let initialPermission: DaemonStartupIntent["initialPermission"];
  if (isRecord(rawInitialPermission)) {
    const level = rawInitialPermission.level;
    const mode = rawInitialPermission.mode;
    if (
      (level === "default" || level === "full-access") &&
      (mode === "plan" || mode === "auto")
    ) {
      initialPermission = { level, mode };
    }
  }

  return {
    ...(startupSessionMode === undefined ? {} : { startupSessionMode }),
    ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
    ...(initialPermission === undefined ? {} : { initialPermission }),
  };
}

function resolveStartupActiveSessionId(
  snapshot: UiSnapshot,
  intent: DaemonStartupIntent,
): string | null {
  if (intent.resumeSessionId !== undefined) {
    if (
      !snapshot.sessions.some(
        (session) => session.id === intent.resumeSessionId,
      )
    ) {
      throw new Error(`Session not found: ${intent.resumeSessionId}`);
    }
    return intent.resumeSessionId;
  }
  if (intent.startupSessionMode?.type === "continue") {
    if (snapshot.sessions.length === 0) {
      return null;
    }
    const latest = [...snapshot.sessions].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    )[0];
    return latest.id;
  }
  return null;
}

function permissionsForClientSnapshot(
  snapshot: UiSnapshot,
  activeSessionId: string | null,
): UiSnapshot["permissions"] {
  if (activeSessionId === null) {
    return [];
  }
  return snapshot.permissions.filter((permission) => {
    const run = snapshot.runs.find(
      (candidate) => candidate.id === permission.runId,
    );
    return run?.sessionId === activeSessionId;
  });
}

function statusForClientSnapshot(
  snapshot: UiSnapshot,
  activeSessionId: string | null,
): UiSnapshot["status"] {
  const status = snapshot.status;
  if (activeSessionId === null) {
    return { kind: "idle" };
  }
  if (status.kind === "running") {
    const run = snapshot.runs.find(
      (candidate) => candidate.id === status.runId,
    );
    return run?.sessionId === activeSessionId ? status : { kind: "idle" };
  }
  if (status.kind === "waiting-for-permission") {
    const permission = snapshot.permissions.find(
      (candidate) => candidate.id === status.requestId,
    );
    const run =
      permission === undefined
        ? undefined
        : snapshot.runs.find((candidate) => candidate.id === permission.runId);
    return run?.sessionId === activeSessionId ? status : { kind: "idle" };
  }
  return status;
}

function projectSnapshotForClient(
  snapshot: UiSnapshot,
  view: ClientView | undefined,
): UiSnapshot {
  if (!view) {
    return snapshot;
  }
  const activeSessionId =
    view.activeSessionId !== undefined &&
    (view.activeSessionId === null ||
      view.activeSessionId === view.pendingSessionId ||
      snapshot.sessions.some((session) => session.id === view.activeSessionId))
      ? view.activeSessionId
      : snapshot.activeSessionId;
  return {
    ...snapshot,
    activeSessionId,
    ...(snapshot.contextWindowUsages === undefined
      ? {}
      : {
          contextWindowUsages: snapshot.contextWindowUsages.filter(
            (usage) => usage.sessionId === activeSessionId,
          ),
        }),
    permissions: permissionsForClientSnapshot(snapshot, activeSessionId),
    runs: snapshot.runs.filter((run) => run.sessionId === activeSessionId),
    sessions: snapshot.sessions.map((session) =>
      session.id === activeSessionId
        ? session
        : { ...session, messages: [] },
    ),
    status: statusForClientSnapshot(snapshot, activeSessionId),
    ...(view.initialPermission === undefined
      ? {}
      : {
          permission: {
            level: view.initialPermission.level,
            mode: view.initialPermission.mode,
            sessionRules: snapshot.permission?.sessionRules ?? [],
          },
        }),
  };
}

function optionsForClientSubmit(
  options: SubmitPromptOptions | undefined,
  view: ClientView | undefined,
): SubmitPromptOptions | undefined {
  if (options?.sessionId !== undefined) {
    return options;
  }
  if (view?.activeSessionId) {
    return { ...options, sessionId: view.activeSessionId };
  }
  return options;
}

function commandInvocationForClient(
  invocation: ExecuteCommandInvocation,
  view: ClientView | undefined,
): ExecuteCommandInvocation {
  if (invocation.commandId !== "new" || view?.activeSessionId !== null) {
    return invocation;
  }
  const internalArg = "--no-reuse-empty-session";
  if (invocation.argv.includes(internalArg)) {
    return invocation;
  }
  const argv = [...invocation.argv, internalArg];
  return {
    ...invocation,
    argv,
    raw: `${invocation.raw}${invocation.raw.length > 0 ? " " : ""}${internalArg}`,
    rawArgs: argv.join(" "),
  };
}

function selectedSessionIdFromCommandAction(
  action: Extract<UiEvent, { type: "command.result.delivered" }>["action"],
): string | undefined {
  if (action?.kind !== "session.selected" || !isRecord(action.data)) {
    return undefined;
  }
  const choiceId = action.data.choiceId;
  return typeof choiceId === "string" && choiceId.length > 0
    ? choiceId
    : undefined;
}

function sessionIdForEvent(event: UiEvent): string | undefined {
  switch (event.type) {
    case "session.updated":
      return event.session.id;
    case "message.appended":
    case "message.updated":
    case "message.part.delta":
    case "run.interrupted":
      return event.sessionId;
    case "run.updated":
      return event.run.sessionId;
    case "context.window.updated":
      return event.usage.sessionId;
    default:
      return undefined;
  }
}

export class DaemonClientViewCoordinator {
  private readonly clientViews = new Map<string, ClientView>();
  private readonly commandOwnersByInvocationId = new Map<string, string>();
  private readonly commandOwnersByRunId = new Map<string, string>();
  private readonly runOwnersByRunId = new Map<string, string>();
  private readonly runSessionIdsByRunId = new Map<string, string>();
  private activePrompt: DaemonPromptQueueItem | undefined;

  initializeClient(
    clientId: string,
    snapshot: UiSnapshot,
    intent: DaemonStartupIntent,
  ): void {
    this.clientViews.set(clientId, {
      activeSessionId: resolveStartupActiveSessionId(snapshot, intent),
      ...(intent.initialPermission === undefined
        ? {}
        : { initialPermission: intent.initialPermission }),
    });
  }

  projectSnapshot(clientId: string, snapshot: UiSnapshot): UiSnapshot {
    return projectSnapshotForClient(snapshot, this.clientViews.get(clientId));
  }

  preparePromptSubmit(
    clientId: string,
    options: SubmitPromptOptions | undefined,
    createSessionId: () => string,
  ): PreparedPromptSubmit {
    const view = this.clientViews.get(clientId);
    let submitOptions = optionsForClientSubmit(options, view);
    if (submitOptions?.sessionId !== undefined && view !== undefined) {
      view.activeSessionId = submitOptions.sessionId;
    } else if (view?.activeSessionId === null) {
      const sessionId = createSessionId();
      submitOptions = { ...options, sessionId };
      view.activeSessionId = sessionId;
      view.pendingSessionId = sessionId;
    }
    return {
      ...(submitOptions === undefined ? {} : { options: submitOptions }),
      ...(submitOptions?.sessionId === undefined
        ? {}
        : { sessionId: submitOptions.sessionId }),
    };
  }

  prepareCommandInvocation(
    clientId: string,
    invocation: ExecuteCommandInvocation,
  ): ExecuteCommandInvocation {
    const prepared = commandInvocationForClient(
      invocation,
      this.clientViews.get(clientId),
    );
    if (typeof prepared.clientInvocationId === "string") {
      this.commandOwnersByInvocationId.set(
        prepared.clientInvocationId,
        clientId,
      );
    }
    return prepared;
  }

  promptStarted(item: DaemonPromptQueueItem): void {
    this.activePrompt = item;
  }

  promptSettled(item: DaemonPromptQueueItem): void {
    if (this.activePrompt === item) {
      this.activePrompt = undefined;
    }
  }

  observeEvent(event: UiEvent): void {
    switch (event.type) {
      case "session.updated":
        for (const view of this.clientViews.values()) {
          if (view.pendingSessionId === event.session.id) {
            view.pendingSessionId = undefined;
          }
        }
        return;
      case "command.started": {
        const owner = this.commandOwnersByInvocationId.get(
          event.command.clientInvocationId,
        );
        if (owner !== undefined) {
          this.commandOwnersByRunId.set(event.command.commandRunId, owner);
        }
        return;
      }
      case "command.result.delivered": {
        const owner = this.commandOwnerForEvent(event);
        const selectedSessionId = selectedSessionIdFromCommandAction(
          event.action,
        );
        if (owner !== undefined && selectedSessionId !== undefined) {
          this.setClientActiveSession(owner, selectedSessionId);
        }
        return;
      }
      case "command.failed":
        return;
      case "runtime.updated": {
        const runId =
          event.status.kind === "running" ? event.status.runId : undefined;
        if (runId !== undefined && this.activePrompt !== undefined) {
          this.runOwnersByRunId.set(runId, this.activePrompt.clientId);
          if (this.activePrompt.sessionId !== undefined) {
            this.runSessionIdsByRunId.set(runId, this.activePrompt.sessionId);
          }
        }
        return;
      }
      case "run.updated": {
        this.runSessionIdsByRunId.set(event.run.id, event.run.sessionId);
        if (
          this.activePrompt?.sessionId === event.run.sessionId ||
          (this.activePrompt?.sessionId === undefined &&
            this.activePrompt !== undefined)
        ) {
          this.runOwnersByRunId.set(event.run.id, this.activePrompt.clientId);
        }
        if (
          event.run.status.kind !== "running" &&
          event.run.status.kind !== "waiting-for-permission"
        ) {
          this.runOwnersByRunId.delete(event.run.id);
        }
        return;
      }
      default:
        return;
    }
  }

  routeEventForClient(event: UiEvent, clientId: string): UiEvent | undefined {
    const view = this.clientViews.get(clientId);

    if (event.type === "snapshot.replaced") {
      return {
        ...event,
        snapshot: projectSnapshotForClient(event.snapshot, view),
      };
    }

    if (event.type === "runtime.updated") {
      return this.runtimeEventBelongsToClient(event, clientId)
        ? event
        : undefined;
    }

    if (
      event.type === "command.started" ||
      event.type === "command.result.delivered" ||
      event.type === "command.failed"
    ) {
      return this.commandEventBelongsToClient(event, clientId)
        ? event
        : undefined;
    }

    if (
      event.type === "interaction.requested" ||
      event.type === "interaction.resolved"
    ) {
      return this.interactionEventBelongsToClient(event, clientId)
        ? event
        : undefined;
    }

    const sessionId = sessionIdForEvent(event);
    if (sessionId === undefined || view === undefined) {
      return event;
    }
    return view.activeSessionId === sessionId ? event : undefined;
  }

  afterEventBroadcast(event: UiEvent): void {
    if (event.type === "command.failed") {
      this.forgetCommandOwner(event);
    }
  }

  disconnectClient(clientId: string): void {
    for (const [invocationId, owner] of this.commandOwnersByInvocationId) {
      if (owner === clientId) {
        this.commandOwnersByInvocationId.delete(invocationId);
      }
    }
    for (const [runId, owner] of this.commandOwnersByRunId) {
      if (owner === clientId) {
        this.commandOwnersByRunId.delete(runId);
      }
    }
    for (const [runId, owner] of this.runOwnersByRunId) {
      if (owner === clientId) {
        this.runOwnersByRunId.delete(runId);
      }
    }
  }

  resetRuntimeState(): void {
    this.activePrompt = undefined;
    this.runOwnersByRunId.clear();
    this.runSessionIdsByRunId.clear();
  }

  private commandEventBelongsToClient(
    event: Extract<
      UiEvent,
      {
        type: "command.started" | "command.result.delivered" | "command.failed";
      }
    >,
    clientId: string,
  ): boolean {
    const owner =
      event.type === "command.started"
        ? this.commandOwnersByInvocationId.get(event.command.clientInvocationId)
        : this.commandOwnerForEvent(event);
    return owner === clientId;
  }

  private runtimeEventBelongsToClient(
    event: Extract<UiEvent, { type: "runtime.updated" }>,
    clientId: string,
  ): boolean {
    const sessionId = this.runtimeEventSessionId(event);
    if (sessionId !== undefined) {
      return this.clientViews.get(clientId)?.activeSessionId === sessionId;
    }

    return this.runtimeEventOwner(event) === clientId;
  }

  private runtimeEventOwner(
    event: Extract<UiEvent, { type: "runtime.updated" }>,
  ): string | undefined {
    if (event.status.kind === "running") {
      return (
        this.runOwnersByRunId.get(event.status.runId) ??
        this.activePrompt?.clientId
      );
    }
    return this.activePrompt?.clientId;
  }

  private runtimeEventSessionId(
    event: Extract<UiEvent, { type: "runtime.updated" }>,
  ): string | undefined {
    if (event.status.kind === "running") {
      return (
        this.runSessionIdsByRunId.get(event.status.runId) ??
        this.activePrompt?.sessionId
      );
    }
    return this.activePrompt?.sessionId;
  }

  private interactionEventBelongsToClient(
    event: Extract<
      UiEvent,
      { type: "interaction.requested" | "interaction.resolved" }
    >,
    clientId: string,
  ): boolean {
    const clientInvocationId =
      event.type === "interaction.requested"
        ? event.request.clientInvocationId
        : event.clientInvocationId;
    const commandRunId =
      event.type === "interaction.requested"
        ? event.request.commandRunId
        : event.commandRunId;
    const owner =
      (clientInvocationId === undefined
        ? undefined
        : this.commandOwnersByInvocationId.get(clientInvocationId)) ??
      this.commandOwnersByRunId.get(commandRunId);
    return owner === undefined || owner === clientId;
  }

  private commandOwnerForEvent(
    event: Extract<
      UiEvent,
      { type: "command.result.delivered" | "command.failed" }
    >,
  ): string | undefined {
    return (
      this.commandOwnersByInvocationId.get(event.clientInvocationId) ??
      this.commandOwnersByRunId.get(event.commandRunId)
    );
  }

  private forgetCommandOwner(
    event: Extract<
      UiEvent,
      { type: "command.result.delivered" | "command.failed" }
    >,
  ): void {
    this.commandOwnersByInvocationId.delete(event.clientInvocationId);
    this.commandOwnersByRunId.delete(event.commandRunId);
  }

  private setClientActiveSession(clientId: string, sessionId: string): void {
    const view = this.clientViews.get(clientId);
    if (view === undefined) {
      return;
    }
    view.activeSessionId = sessionId;
    view.pendingSessionId = undefined;
  }
}
