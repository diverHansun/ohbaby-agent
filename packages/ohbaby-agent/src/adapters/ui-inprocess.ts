import path from "node:path";
import type {
  SubmitPromptOptions,
  UiBackendClient,
  UiCommandCatalog,
  UiCommandInvocation,
  UiCompactSessionOptions,
  UiCompactSessionResult,
  UiEvent,
  UiEventHandler,
  UiInteractionResponse,
  UiMessage,
  UiNotice,
  UiPermissionRequest,
  UiPermissionResponse,
  UiRun,
  UiRunStatus,
  UiSnapshot,
  UiSession,
} from "ohbaby-sdk";
import type { BusInstance } from "../bus/index.js";
import { createLLMClient } from "../core/llm-client/index.js";
import type {
  CreateLLMClientOptions,
  LLMClientInstance,
} from "../core/llm-client/index.js";
import { createBus } from "../bus/index.js";
import type {
  CommandModelSummary,
  CommandSessionSummary,
} from "../commands/index.js";
import { CommandsEvent, createCommandService } from "../commands/index.js";
import {
  createInteractionBroker,
  InteractionEvent,
} from "../runtime/interaction-broker/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../core/message/index.js";
import type {
  MessageManager,
  MessageWithParts,
} from "../core/message/index.js";
import type {
  Session as CoreSession,
  SessionManager,
} from "../services/session/index.js";
import {
  createPermissionManager,
  PermissionEvent,
} from "../permission/index.js";
import type {
  PermissionInfo,
  PermissionResponse as CorePermissionResponse,
} from "../permission/index.js";
import { createPolicyManager, PolicyEvent } from "../policy/index.js";
import { Project } from "../project/index.js";
import type { AgentManager } from "../agents/index.js";
import {
  SkillLoader,
  SkillRegistry,
  formatSkillToolOutput,
  type SkillLogger,
} from "../skill/index.js";
import type { HookExecutor } from "../runtime/run-manager/index.js";
import type { RunLedger } from "../runtime/run-ledger/index.js";
import type { StreamBridge } from "../runtime/stream-bridge/index.js";
import {
  cloneMessage,
  cloneRun,
  cloneSession,
  createInMemoryUiStateStore,
} from "./ui-state/index.js";
import type { UiStateStore } from "./ui-state/index.js";
import { createUiRuntimeComposition } from "./ui-runtime/composition.js";
import { startRunStreamProjection } from "./ui-runtime/run-stream-adapter.js";
import type { UiRuntimeComposition } from "./ui-runtime/types.js";

const EMPTY_SNAPSHOT: UiSnapshot = {
  sessions: [],
  activeSessionId: null,
  runs: [],
  permissions: [],
  policy: {
    agentState: "ask-before-edit",
    mode: "agent",
  },
  status: {
    kind: "idle",
  },
};

type NoticeDraft = Omit<UiNotice, "id" | "createdAt"> & {
  readonly createdAt?: string;
};

type UiPolicyState = NonNullable<UiSnapshot["policy"]>;

export interface InProcessUiBackendOptions {
  readonly agentManager?: AgentManager;
  readonly bus?: BusInstance;
  readonly createAgentTaskId?: () => string;
  readonly createRunId?: () => string;
  readonly hookExecutor?: HookExecutor;
  readonly initialSnapshot?: UiSnapshot;
  readonly llmClient?: LLMClientInstance;
  readonly createLLMClient?: (
    options?: CreateLLMClientOptions,
  ) => Promise<LLMClientInstance>;
  readonly messageManager?: MessageManager;
  readonly sessionManager?: Pick<
    SessionManager,
    "create" | "get" | "getRecent"
  > &
    Partial<Pick<SessionManager, "incrementStats">>;
  readonly stateStore?: UiStateStore;
  readonly projectDirectory?: string;
  readonly now?: () => Date;
  readonly runLedger?: RunLedger;
  readonly streamBridge?: StreamBridge;
  readonly workdir?: string;
}

function isSnapshot(
  value: UiSnapshot | InProcessUiBackendOptions,
): value is UiSnapshot {
  return "sessions" in value && "runs" in value && "status" in value;
}

function createId(prefix: string, value: number): string {
  return `${prefix}_${String(value)}`;
}

function getNumericSuffix(prefix: string, id: string): number | undefined {
  const prefixWithSeparator = `${prefix}_`;
  if (!id.startsWith(prefixWithSeparator)) {
    return undefined;
  }

  const value = Number(id.slice(prefixWithSeparator.length));
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

interface IdFactory {
  next(): string;
  reserve(id: string): void;
}

function createIdFactory(
  prefix: string,
  existingIds: Iterable<string>,
): IdFactory {
  const usedIds = new Set(existingIds);
  const numericSuffixes = Array.from(usedIds)
    .map((id) => getNumericSuffix(prefix, id))
    .filter((value): value is number => value !== undefined);
  let nextValue =
    numericSuffixes.length === 0 ? 1 : Math.max(...numericSuffixes) + 1;

  function reserve(id: string): void {
    usedIds.add(id);
    const numericSuffix = getNumericSuffix(prefix, id);
    if (numericSuffix !== undefined && numericSuffix >= nextValue) {
      nextValue = numericSuffix + 1;
    }
  }

  return {
    next(): string {
      let id = createId(prefix, nextValue);
      while (usedIds.has(id)) {
        nextValue += 1;
        id = createId(prefix, nextValue);
      }
      reserve(id);
      return id;
    },
    reserve,
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function createTextMessage(input: {
  id: string;
  role: UiMessage["role"];
  text: string;
  createdAt: string;
}): UiMessage {
  return {
    id: input.id,
    role: input.role,
    createdAt: input.createdAt,
    parts: input.text === "" ? [] : [{ type: "text", text: input.text }],
  };
}

function sessionMetadataToUiSession(session: CoreSession): UiSession {
  return {
    createdAt: new Date(session.createdAt).toISOString(),
    id: session.id,
    messages: [],
    projectRoot: session.projectRoot,
    title: session.title,
    updatedAt: new Date(session.updatedAt).toISOString(),
  };
}

function isPrimarySession(session: CoreSession): boolean {
  return !session.isSubagent;
}

function maxMessageTimestamp(
  messages: readonly MessageWithParts[],
): number | undefined {
  let latest: number | undefined;
  for (const message of messages) {
    const candidates = [
      message.info.time.created,
      message.info.time.updated,
      message.info.time.completed,
    ].filter((value): value is number => value !== undefined);
    for (const value of candidates) {
      latest = latest === undefined ? value : Math.max(latest, value);
    }
  }
  return latest;
}

function toUiPermissionRequest(input: {
  readonly info: PermissionInfo;
  readonly runId: string;
}): UiPermissionRequest {
  return {
    id: input.info.id,
    runId: input.runId,
    title: input.info.title,
    description: input.info.pattern,
    choices: [
      { id: "allow_once", label: "Allow once", intent: "allow" },
      { id: "allow_always", label: "Always allow", intent: "allow" },
      { id: "reject", label: "Reject", intent: "deny" },
      { id: "cancel", label: "Cancel run", intent: "abort" },
    ],
  };
}

function toCorePermissionResponse(
  response: UiPermissionResponse,
): CorePermissionResponse {
  if (response.choiceId === "allow_once") {
    return { type: "once" };
  }
  if (response.choiceId === "allow_always" || response.remember === true) {
    return { type: "always" };
  }
  if (response.choiceId === "cancel") {
    return { type: "cancel" };
  }

  return { type: "reject" };
}

export function createInProcessUiBackendClient(
  optionsOrSnapshot: UiSnapshot | InProcessUiBackendOptions = EMPTY_SNAPSHOT,
): UiBackendClient {
  const options = isSnapshot(optionsOrSnapshot)
    ? { initialSnapshot: optionsOrSnapshot }
    : optionsOrSnapshot;
  const initialSnapshot = options.initialSnapshot ?? EMPTY_SNAPSHOT;
  const stateStore =
    options.stateStore ?? createInMemoryUiStateStore(initialSnapshot);
  const bus = options.bus ?? createBus();
  const policy = createPolicyManager({ bus });
  if (initialSnapshot.policy) {
    policy.setMode(initialSnapshot.policy.mode);
    policy.setAgentState(initialSnapshot.policy.agentState);
  }
  const permission = createPermissionManager({ bus });
  const messageManager =
    options.messageManager ??
    createMessageManager({
      bus,
      store: createInMemoryMessageStore(),
    });
  const interactionBroker = createInteractionBroker({ bus });
  const handlers = new Set<UiEventHandler>();
  const sessionIds = createIdFactory(
    "session",
    initialSnapshot.sessions.map((session) => session.id),
  );
  const messageIds = createIdFactory(
    "message",
    initialSnapshot.sessions.flatMap((session) =>
      session.messages.map((message) => message.id),
    ),
  );
  const runIds = createIdFactory(
    "run",
    initialSnapshot.runs.map((run) => run.id),
  );
  const noticeIds = createIdFactory("notice", []);
  let promptInFlight = false;
  let activeRunId: string | undefined;
  let runtimePromise: Promise<UiRuntimeComposition> | undefined;
  let skillRegistryPromise: Promise<SkillRegistry> | undefined;
  const pendingPermissionSessions = new Map<string, string>();

  function assertStateStoreWritable(): void {
    if (
      stateStore.requiresServiceManagersForWrites === true &&
      (!options.sessionManager || !options.messageManager)
    ) {
      throw new Error(
        "Persistent UI state store requires injected sessionManager and messageManager for prompt submission",
      );
    }
  }

  async function reserveIdsFromState(): Promise<void> {
    const snapshot = await stateStore.readSnapshot();
    for (const session of snapshot.sessions) {
      sessionIds.reserve(session.id);
      for (const message of session.messages) {
        messageIds.reserve(message.id);
      }
    }
    for (const run of snapshot.runs) {
      runIds.reserve(run.id);
    }
  }

  async function nextRunId(): Promise<string> {
    let runId = options.createRunId?.() ?? runIds.next();
    while ((await stateStore.hasRun?.(runId)) === true) {
      runId = options.createRunId?.() ?? runIds.next();
    }
    runIds.reserve(runId);
    return runId;
  }

  function now(): Date {
    return options.now?.() ?? new Date();
  }

  function timestamp(): string {
    return now().toISOString();
  }

  function publish(event: UiEvent): void {
    for (const handler of handlers) {
      try {
        handler(event);
      } catch {
        // UI event handlers are observers; they must not break backend state.
      }
    }
  }

  function publishNotice(notice: NoticeDraft): void {
    publish({
      notice: {
        ...notice,
        createdAt: notice.createdAt ?? timestamp(),
        id: noticeIds.next(),
      },
      timestamp: Date.now(),
      type: "notice.emitted",
    });
  }

  function formatSkillWarning(
    message: string,
    context?: Record<string, unknown>,
  ): string {
    const error = context?.error;
    return error === undefined
      ? message
      : `${message}: ${getErrorMessage(error)}`;
  }

  function createSkillLogger(): SkillLogger {
    return {
      warn(message, context): void {
        const detail = formatSkillWarning(message, context);
        publishNotice({
          key: `skill:warning:${detail}`,
          level: "warning",
          message: detail,
          title: "Skill warning",
        });
      },
    };
  }

  function upsertSession(session: UiSession): Promise<void> {
    return stateStore.upsertSession(session);
  }

  function updateRun(run: UiRun): Promise<void> {
    return stateStore.updateRun(run);
  }

  async function updateStatus(status: UiRunStatus): Promise<void> {
    await stateStore.setStatus(status);
    publish({ type: "runtime.updated", status, timestamp: Date.now() });
  }

  async function updateActiveRunStatus(status: UiRunStatus): Promise<void> {
    const runId = activeRunId;
    if (!runId) {
      return;
    }
    const snapshot = await stateStore.readSnapshot();
    const run = snapshot.runs.find((candidate) => candidate.id === runId);
    if (!run) {
      return;
    }
    const updatedRun = {
      ...run,
      status,
      updatedAt: timestamp(),
    };
    await updateRun(updatedRun);
    publish({ type: "run.updated", run: cloneRun(updatedRun) });
  }

  async function reconcileRuntimeStatus(): Promise<UiRunStatus> {
    const snapshot = await stateStore.readSnapshot();
    let status: UiRunStatus;
    if (snapshot.permissions.length > 0) {
      status = {
        kind: "waiting-for-permission",
        requestId: snapshot.permissions[0].id,
      };
    } else if (promptInFlight && activeRunId) {
      status = {
        kind: "running",
        runId: activeRunId,
      };
    } else {
      status = { kind: "idle" };
    }

    if (activeRunId) {
      await updateActiveRunStatus(status);
    }
    await updateStatus(status);
    return status;
  }

  async function clearPendingPermissionsForRun(
    runId: string | undefined,
  ): Promise<void> {
    const snapshot = await stateStore.readSnapshot();
    const requests = snapshot.permissions.filter(
      (request) => runId === undefined || request.runId === runId,
    );
    if (requests.length === 0) {
      return;
    }

    const sessionIds = new Set<string>();
    for (const request of requests) {
      const sessionId = pendingPermissionSessions.get(request.id);
      if (sessionId) {
        sessionIds.add(sessionId);
      }
    }

    for (const sessionId of sessionIds) {
      permission.cancelPending(sessionId);
    }
    for (const request of requests) {
      pendingPermissionSessions.delete(request.id);
      await stateStore.removePermission(request.id);
    }
    await reconcileRuntimeStatus();
  }

  async function cancelPromptRun(runId: string): Promise<void> {
    try {
      const runtime = await getRuntime();
      runtime.cancel(runId, "run aborted");
    } catch {
      // Abort is best-effort; the run may already have completed.
    } finally {
      await clearPendingPermissionsForRun(runId);
    }
  }

  function currentPolicyState(): UiPolicyState {
    const state = policy.getState();
    return {
      agentState: state.agentState,
      mode: state.mode,
    };
  }

  async function readSnapshotWithPolicy(): Promise<UiSnapshot> {
    return {
      ...(await stateStore.readSnapshot()),
      policy: currentPolicyState(),
    };
  }

  function publishPolicyUpdated(): void {
    publish({
      type: "policy.updated",
      policy: currentPolicyState(),
      timestamp: Date.now(),
    });
  }

  async function abortPromptRun(runId?: string): Promise<boolean> {
    const targetRunId = runId ?? activeRunId;
    if (!targetRunId || targetRunId !== activeRunId) {
      return false;
    }
    await cancelPromptRun(targetRunId);
    return true;
  }

  function projectDirectory(): string {
    return options.workdir ?? options.projectDirectory ?? process.cwd();
  }

  async function resolveProjectRoot(): Promise<string> {
    const directory = projectDirectory();
    const project = await Project.fromDirectory(directory);

    return options.workdir || options.projectDirectory
      ? path.resolve(directory)
      : project.rootPath;
  }

  function getSkillRegistry(): Promise<SkillRegistry> {
    skillRegistryPromise ??= (async (): Promise<SkillRegistry> => {
      const projectRoot = await resolveProjectRoot();
      return new SkillRegistry({
        loader: new SkillLoader({
          logger: createSkillLogger(),
          projectDirectory: projectRoot,
        }),
      });
    })();
    return skillRegistryPromise;
  }

  async function resolveLLMClient(
    projectRoot?: string,
  ): Promise<LLMClientInstance> {
    const projectDirectory = projectRoot ?? (await resolveProjectRoot());
    if (options.llmClient) {
      return options.llmClient;
    }
    if (options.createLLMClient) {
      return options.createLLMClient({ projectDirectory });
    }
    return createLLMClient({ projectDirectory });
  }

  function getRuntime(): Promise<UiRuntimeComposition> {
    runtimePromise ??= (async (): Promise<UiRuntimeComposition> => {
      const baseProjectRoot = await resolveProjectRoot();
      const llmClient = await resolveLLMClient(baseProjectRoot);
      const skillRegistry = await getSkillRegistry();

      return createUiRuntimeComposition({
        agentManager: options.agentManager,
        bus,
        ...(options.createAgentTaskId
          ? { createAgentTaskId: options.createAgentTaskId }
          : {}),
        createRunId: options.createRunId ?? ((): string => runIds.next()),
        llmClient,
        messageManager,
        hookExecutor: options.hookExecutor,
        now: () => now().getTime(),
        onNotice: publishNotice,
        permission,
        policy,
        runLedger: options.runLedger,
        sessionManager: options.sessionManager,
        skillRegistry,
        streamBridge: options.streamBridge,
        workdir: baseProjectRoot,
      });
    })().catch((error: unknown) => {
      runtimePromise = undefined;
      throw error;
    });

    return runtimePromise;
  }

  async function getRuntimeForPrompt(): Promise<UiRuntimeComposition> {
    try {
      return await getRuntime();
    } catch (error) {
      const message = getErrorMessage(error);
      await updateStatus({
        kind: "error",
        message,
        recoverable: true,
      });
      publishNotice({
        key: `runtime:${message}`,
        level: "error",
        message,
        title: "Runtime error",
      });
      throw error;
    }
  }

  async function currentModelFromOptions(): Promise<CommandModelSummary | null> {
    const client = options.llmClient ?? (await resolveLLMClient());
    return {
      id: `${client.config.provider}:${client.config.model}`,
      label: client.config.model,
      provider: client.config.provider,
    };
  }

  async function listModelsFromOptions(): Promise<
    readonly CommandModelSummary[]
  > {
    const current = await currentModelFromOptions();
    return current ? [current] : [];
  }

  async function listSessionsFromState(): Promise<
    readonly CommandSessionSummary[]
  > {
    if (options.sessionManager) {
      const sessions = await options.sessionManager.getRecent();
      return sessions.filter(isPrimarySession).map((session) => ({
        id: session.id,
        title: session.title,
      }));
    }
    const snapshot = await stateStore.readSnapshot();
    return snapshot.sessions.map((session) => ({
      id: session.id,
      title: session.title,
    }));
  }

  async function createSessionFromCommand(): Promise<CommandSessionSummary> {
    await reserveIdsFromState();
    const createdAt = timestamp();
    const projectRoot = await resolveProjectRoot();
    const title = "New session";
    const agentName = options.agentManager?.getDefault() ?? "default";
    let session: UiSession;

    if (options.sessionManager) {
      const created = await options.sessionManager.create(projectRoot, {
        agentName,
        title,
      });
      session = sessionMetadataToUiSession(created);
    } else {
      session = {
        id: sessionIds.next(),
        title,
        messages: [],
        projectRoot,
        createdAt,
        updatedAt: createdAt,
      };
    }

    sessionIds.reserve(session.id);
    await upsertSession(session);
    await stateStore.setActiveSessionId(session.id);
    publish({ type: "session.updated", session: cloneSession(session) });
    publish({
      snapshot: await readSnapshotWithPolicy(),
      timestamp: Date.now(),
      type: "snapshot.replaced",
    });

    return { id: session.id, title: session.title };
  }

  async function assertCanUseAsPrimarySession(
    sessionId: string | undefined,
  ): Promise<void> {
    if (!sessionId || !options.sessionManager) {
      return;
    }
    const session = await options.sessionManager.get(sessionId);
    if (session?.isSubagent === true) {
      throw new Error(
        `Cannot submit a primary prompt to subagent session: ${sessionId}`,
      );
    }
  }

  async function syncSessionStatsBestEffort(sessionId: string): Promise<void> {
    if (!options.sessionManager?.incrementStats) {
      return;
    }

    try {
      const [session, messages] = await Promise.all([
        options.sessionManager.get(sessionId),
        messageManager.listBySession(sessionId),
      ]);
      if (!session) {
        return;
      }
      const messageCountDelta = messages.length - session.stats.messageCount;
      const lastMessageAt = maxMessageTimestamp(messages);
      if (
        messageCountDelta === 0 &&
        lastMessageAt === session.stats.lastMessageAt
      ) {
        return;
      }
      await options.sessionManager.incrementStats(sessionId, {
        lastMessageAt,
        messageCountDelta,
      });
    } catch (error) {
      const message = getErrorMessage(error);
      publishNotice({
        key: `session:stats:${sessionId}:${message}`,
        level: "warning",
        message: `Session metadata could not be updated: ${message}`,
        title: "Session warning",
      });
    }
  }

  async function resolveCompactTarget(
    compactOptions: UiCompactSessionOptions = {},
  ): Promise<{
    readonly projectRoot: string;
    readonly sessionId: string;
  }> {
    const snapshot = await stateStore.readSnapshot();
    const sessionId = compactOptions.sessionId ?? snapshot.activeSessionId;
    if (!sessionId) {
      throw new Error("No active session to compact");
    }

    await assertCanUseAsPrimarySession(sessionId);
    const [uiSession, coreSession] = await Promise.all([
      stateStore.getSession(sessionId),
      options.sessionManager?.get(sessionId),
    ]);
    if (!uiSession && !coreSession) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    return {
      projectRoot:
        uiSession?.projectRoot ??
        coreSession?.projectRoot ??
        (await resolveProjectRoot()),
      sessionId,
    };
  }

  async function compactSessionInternal(
    compactOptions: UiCompactSessionOptions = {},
  ): Promise<UiCompactSessionResult> {
    const target = await resolveCompactTarget(compactOptions);
    const runtime = await getRuntimeForPrompt();
    runtime.setSessionWorkdir(target.sessionId, target.projectRoot);
    const result = await runtime.compactSession({
      force: compactOptions.force ?? true,
      projectRoot: target.projectRoot,
      sessionId: target.sessionId,
    });

    return {
      ...result,
      sessionId: target.sessionId,
    };
  }

  async function submitPromptInternal(
    text: string,
    submitOptions?: SubmitPromptOptions,
  ): Promise<void> {
    if (promptInFlight) {
      throw new Error("A prompt is already running");
    }
    assertStateStoreWritable();
    promptInFlight = true;
    const createdAt = timestamp();
    let projection: ReturnType<typeof startRunStreamProjection> | undefined;
    let submittedSessionId: string | undefined;

    try {
      await assertCanUseAsPrimarySession(submitOptions?.sessionId);
      await reserveIdsFromState();
      const runtime = await getRuntimeForPrompt();
      const agentName = runtime.agentManager.getDefault();
      const baseProjectRoot = await resolveProjectRoot();
      let session = submitOptions?.sessionId
        ? await stateStore.getSession(submitOptions.sessionId)
        : undefined;
      const existingCoreSession =
        submitOptions?.sessionId && options.sessionManager
          ? await options.sessionManager.get(submitOptions.sessionId)
          : undefined;
      if (!session && existingCoreSession) {
        session = sessionMetadataToUiSession(existingCoreSession);
      } else if (session && !session.projectRoot && existingCoreSession) {
        session = {
          ...session,
          projectRoot: existingCoreSession.projectRoot,
        };
      }

      const isNewSession = !session;
      if (!session) {
        const title = text.trim().slice(0, 48) || "Untitled session";
        if (options.sessionManager) {
          const created = await options.sessionManager.create(baseProjectRoot, {
            agentName,
            id: submitOptions?.sessionId,
            title,
          });
          session = sessionMetadataToUiSession(created);
        } else {
          session = {
            id: submitOptions?.sessionId ?? sessionIds.next(),
            title,
            messages: [],
            projectRoot: baseProjectRoot,
            createdAt,
            updatedAt: createdAt,
          };
        }
        sessionIds.reserve(session.id);
      }
      const resolvedProjectRoot = session.projectRoot ?? baseProjectRoot;
      submittedSessionId = session.id;

      const runId = runtime.reserveRunId(await nextRunId());
      activeRunId = runId;
      const result = await runtime.startSession({
        agentName,
        prompt: text,
        projectRoot: resolvedProjectRoot,
        sessionId: session.id,
        title: session.title,
      });
      if (result.runId !== runId) {
        throw new Error(
          `Agent service created unexpected run id: ${result.runId}`,
        );
      }

      const userMessage = createTextMessage({
        id: messageIds.next(),
        role: "user",
        text,
        createdAt,
      });

      if (isNewSession) {
        await upsertSession(session);
        publish({ type: "session.updated", session: cloneSession(session) });
      }

      await stateStore.setActiveSessionId(session.id);

      session = {
        ...session,
        messages: [...session.messages, userMessage],
        updatedAt: createdAt,
      };
      await upsertSession(session);
      publish({
        type: "message.appended",
        sessionId: session.id,
        message: cloneMessage(userMessage),
      });

      const assistantMessageId = messageIds.next();
      projection = startRunStreamProjection({
        assistantMessageId,
        nextMessageId: () => messageIds.next(),
        publish,
        runId,
        sessionId: session.id,
        stateStore,
        streamBridge: runtime.streamBridge,
        timestamp,
      });

      try {
        const completion = await runtime.runManager.waitForCompletion(runId);
        await projection.done;
        if (completion.status !== "succeeded") {
          throw new Error(completion.error ?? `Run ${completion.status}`);
        }
      } catch (error) {
        await projection.done.catch(() => undefined);
        const snapshot = await stateStore.readSnapshot();
        if (snapshot.status.kind !== "error") {
          await updateStatus({
            kind: "error",
            message: getErrorMessage(error),
            recoverable: true,
          });
        }
        throw error;
      }
    } finally {
      if (submittedSessionId) {
        await syncSessionStatsBestEffort(submittedSessionId);
      }
      promptInFlight = false;
      activeRunId = undefined;
    }
  }

  const commandService = createCommandService({
    bus,
    interactionBroker,
    tools: {
      async listTools() {
        const runtime = await getRuntime();
        return runtime.listToolSummaries({
          agentName: runtime.agentManager.getDefault(),
        });
      },
    },
    models: {
      currentModel: currentModelFromOptions,
      listModels: listModelsFromOptions,
    },
    sessions: {
      createSession: createSessionFromCommand,
      listSessions: listSessionsFromState,
      async selectSession(sessionId: string): Promise<void> {
        await assertCanUseAsPrimarySession(sessionId);
        const session = await stateStore.getSession(sessionId);
        if (!session) {
          throw new Error(`Session not found: ${sessionId}`);
        }
        await stateStore.setActiveSessionId(sessionId);
        publish({
          snapshot: await readSnapshotWithPolicy(),
          timestamp: Date.now(),
          type: "snapshot.replaced",
        });
      },
    },
    compact: {
      compactSession: compactSessionInternal,
    },
    skills: {
      async listUserInvocable() {
        return (await getSkillRegistry()).listUserInvocable();
      },
      async loadPrompt(name: string): Promise<string> {
        const registry = await getSkillRegistry();
        return formatSkillToolOutput(await registry.load(name));
      },
    },
    submitPrompt: submitPromptInternal,
    policy: {
      getState: currentPolicyState,
      setMode(mode): void {
        policy.setMode(mode);
      },
      setAgentState(agentState): void {
        policy.setAgentState(agentState);
      },
    },
    abortRun(runId?: string): void {
      if (!runId) {
        void abortPromptRun();
        interactionBroker.abortAll("aborted");
        return;
      }
      if (runId === activeRunId) {
        void abortPromptRun(runId);
        return;
      }
      commandService.abortCommandRun(runId, "aborted");
    },
    getStatus(): string {
      return promptInFlight ? "running" : "idle";
    },
  });

  bus.subscribe(CommandsEvent.Started, (payload) => {
    publish({
      type: "command.started",
      command: {
        commandRunId: payload.commandRunId,
        clientInvocationId: payload.clientInvocationId,
        commandId: payload.commandId,
        path: payload.path,
        surface: payload.surface,
        sessionId: payload.sessionId,
      },
      timestamp: payload.timestamp,
    });
  });
  bus.subscribe(CommandsEvent.ResultDelivered, (payload) => {
    publish({
      type: "command.result.delivered",
      commandRunId: payload.commandRunId,
      clientInvocationId: payload.clientInvocationId,
      output: payload.output,
      action: payload.action,
      timestamp: payload.timestamp,
    });
  });
  bus.subscribe(CommandsEvent.Failed, (payload) => {
    publish({
      type: "command.failed",
      commandRunId: payload.commandRunId,
      clientInvocationId: payload.clientInvocationId,
      error: payload.error,
      timestamp: payload.timestamp,
    });
  });
  bus.subscribe(InteractionEvent.Requested, (payload) => {
    publish({
      type: "interaction.requested",
      request: payload.request,
      timestamp: payload.timestamp,
    });
  });
  bus.subscribe(InteractionEvent.Resolved, (payload) => {
    publish({
      type: "interaction.resolved",
      interactionId: payload.interactionId,
      commandRunId: payload.commandRunId,
      clientInvocationId: payload.clientInvocationId,
      status: payload.response.kind,
      timestamp: payload.timestamp,
    });
  });
  bus.subscribe(PolicyEvent.ModeChanged, () => {
    publishPolicyUpdated();
  });
  bus.subscribe(PolicyEvent.AgentStateChanged, () => {
    publishPolicyUpdated();
  });
  bus.subscribe(PermissionEvent.Updated, (payload) => {
    void (async (): Promise<void> => {
      const request = toUiPermissionRequest({
        info: payload.info,
        runId: activeRunId ?? payload.info.callId,
      });
      pendingPermissionSessions.set(payload.info.id, payload.info.sessionId);
      await stateStore.upsertPermission(request);
      await reconcileRuntimeStatus();
      publish({
        type: "permission.requested",
        request,
        timestamp: Date.now(),
      });
    })();
  });
  bus.subscribe(PermissionEvent.Replied, (payload) => {
    void (async (): Promise<void> => {
      pendingPermissionSessions.delete(payload.permissionId);
      await stateStore.removePermission(payload.permissionId);
      publish({
        type: "permission.resolved",
        requestId: payload.permissionId,
        timestamp: Date.now(),
      });
      await reconcileRuntimeStatus();
    })();
  });
  bus.subscribe(PermissionEvent.AutoEditRequested, () => {
    policy.setAgentState("edit-automatically");
  });

  return {
    getSnapshot(): Promise<UiSnapshot> {
      return readSnapshotWithPolicy();
    },

    subscribeEvents(handler: UiEventHandler) {
      handlers.add(handler);

      return () => {
        handlers.delete(handler);
      };
    },

    listCommands(query): Promise<UiCommandCatalog> {
      return commandService.listCommands(query);
    },

    submitPrompt(
      text: string,
      submitOptions?: SubmitPromptOptions,
    ): Promise<void> {
      return submitPromptInternal(text, submitOptions);
    },

    compactSession(
      compactOptions?: UiCompactSessionOptions,
    ): Promise<UiCompactSessionResult> {
      return compactSessionInternal(compactOptions);
    },

    executeCommand(invocation: UiCommandInvocation): Promise<void> {
      return commandService.executeCommand(invocation);
    },

    respondPermission(
      requestId: string,
      response: UiPermissionResponse,
    ): Promise<void> {
      const sessionId = pendingPermissionSessions.get(requestId);
      if (!sessionId) {
        return Promise.resolve();
      }
      if (response.choiceId === "cancel") {
        return (async (): Promise<void> => {
          const snapshot = await stateStore.readSnapshot();
          const runId =
            snapshot.permissions.find((request) => request.id === requestId)
              ?.runId ?? activeRunId;
          if (runId) {
            await cancelPromptRun(runId);
            return;
          }
          permission.cancelPending(sessionId);
        })();
      }
      permission.respond(
        sessionId,
        requestId,
        toCorePermissionResponse(response),
      );
      return Promise.resolve();
    },

    respondInteraction(
      interactionId: string,
      response: UiInteractionResponse,
    ): Promise<void> {
      return interactionBroker.respond(interactionId, response);
    },

    async abortRun(runId?: string): Promise<void> {
      if (!runId) {
        await abortPromptRun();
        interactionBroker.abortAll("aborted");
      } else if (runId === activeRunId) {
        await abortPromptRun(runId);
      } else {
        commandService.abortCommandRun(runId, "aborted");
      }
    },
  };
}
