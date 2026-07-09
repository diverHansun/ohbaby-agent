import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  SubmitPromptOptions,
  UiBackendClient,
  UiArchiveSessionInput,
  UiCommandCatalog,
  UiCommandInvocation,
  UiCompactSessionOptions,
  UiCompactSessionResult,
  UiConnectModelInput,
  UiConnectModelResult,
  UiContextWindowUsage,
  UiCurrentModelConfig,
  UiEvent,
  UiEventHandler,
  UiGoal,
  UiInteractionResponse,
  UiMessage,
  UiNotice,
  UiPermissionResponse,
  UiPermissionUpdate,
  UiRun,
  UiRunStatus,
  UiSetSearchApiKeyInput,
  UiSetSearchApiKeyResult,
  UiSessionGoal,
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
  CommandGoalBackend,
  CommandModelSummary,
  CommandSessionSummary,
} from "../commands/index.js";
import {
  GoalStore,
  InMemoryGoalPersistence,
  renderGoalContextNote,
} from "../goals/index.js";
import type {
  GoalPersistencePort,
  GoalSnapshot,
  GoalTurnOutcome,
} from "../goals/index.js";
import { createCommandService } from "../commands/index.js";
import { createInteractionBroker } from "../runtime/interaction-broker/index.js";
import {
  createContextWindowUsageTracker,
  type ContextWindowUsageTracker,
} from "../core/context/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../core/message/index.js";
import type {
  MessageManager,
  MessageWithParts,
} from "../core/message/index.js";
import type { Session as CoreSession } from "../services/session/index.js";
import {
  createTemporarySessionTitle,
  generateSessionTitle,
  isDefaultSessionTitle,
  resolveSessionDisplayTitle,
  sameSessionProjectRoot,
} from "../services/session/index.js";
import {
  createPermissionManager,
  createPermissionState,
} from "../permission/index.js";
import type { PermissionResponse as CorePermissionResponse } from "../permission/index.js";
import { Project } from "../project/index.js";
import type { AgentManager } from "../agents/index.js";
import type { SubagentInstanceStore } from "../agents/index.js";
import {
  SkillLoader,
  SkillRegistry,
  formatSkillToolOutput,
  type SkillLogger,
} from "../skill/index.js";
import type {
  HookExecutor,
  RunCompletion,
} from "../runtime/run-manager/index.js";
import {
  SessionRunBusyError,
  type RunLedger,
} from "../runtime/run-ledger/index.js";
import type { StreamBridge } from "../runtime/stream-bridge/index.js";
import {
  cloneMessage,
  cloneRun,
  cloneSession,
  createInMemoryUiStateStore,
} from "./ui-state/index.js";
import type { UiStateStore } from "./ui-state/index.js";
import { createUiRuntimeComposition } from "./ui-runtime/composition.js";
import type { UiRuntimeComposition } from "./ui-runtime/types.js";
import {
  startPermissionEventProjection,
  subscribeAppEventProjectors,
} from "./app-events/index.js";
import {
  applyActiveModelConfig,
  probeActiveModelContextWindow,
} from "../config/llm/apply-active-model-config.js";
import { loadModelJson } from "../config/llm/loaders.js";
import { ConfigError } from "../config/llm/types.js";
import { validateModelJson } from "../config/llm/validation.js";
import type { ModelJsonConfig } from "../config/llm/types.js";
import {
  reloadSearchConfig,
  setSearchApiKey as writeSearchApiKey,
} from "../config/tools/search/index.js";
import { InProcessPromptController } from "./ui-inprocess/prompt-controller.js";
import { InProcessEventRouter } from "./ui-inprocess/event-router.js";
import {
  InProcessRuntimeController,
  type RunStreamProjection,
} from "./ui-inprocess/runtime-controller.js";
import {
  isPrimarySession,
  parseUiTimestamp,
  resolveSessionForNewPrompt,
  sessionMetadataToUiSession,
  sortCoreSessionsByUpdatedAtDesc,
  sortUiSessionsByUpdatedAtDesc,
  type InProcessSessionManager,
} from "./ui-inprocess/session-controller.js";
import type { NoticeDraft } from "./ui-inprocess/types.js";

const EMPTY_SNAPSHOT: UiSnapshot = {
  sessions: [],
  activeSessionId: null,
  runs: [],
  permissions: [],
  permission: {
    level: "default",
    mode: "auto",
    sessionRules: [],
  },
  status: {
    kind: "idle",
  },
};

type UiPermissionState = NonNullable<UiSnapshot["permission"]>;

type PromptOwner = "user" | "goal";

type InternalSubmitPromptOptions = SubmitPromptOptions & {
  readonly owner?: PromptOwner;
  readonly suppressGoalContextNote?: boolean;
};

export interface InProcessUiBackendOptions {
  readonly afterPromptSubmitSettled?: () => Promise<void> | void;
  readonly agentManager?: AgentManager;
  readonly beforePromptSubmit?: () => Promise<void> | void;
  readonly bus?: BusInstance;
  readonly createSubagentId?: () => string;
  readonly createRunId?: () => string;
  readonly goalPersistence?: GoalPersistencePort;
  readonly hookExecutor?: HookExecutor;
  readonly initialSnapshot?: UiSnapshot;
  readonly llmClient?: LLMClientInstance;
  readonly createLLMClient?: (
    options?: CreateLLMClientOptions,
  ) => Promise<LLMClientInstance>;
  readonly messageManager?: MessageManager;
  readonly sessionManager?: InProcessSessionManager;
  readonly stateStore?: UiStateStore;
  readonly projectDirectory?: string;
  readonly now?: () => Date;
  readonly runLedger?: RunLedger;
  readonly streamBridge?: StreamBridge;
  readonly subagentInstanceStore?: SubagentInstanceStore;
  readonly subagentOwnerId?: string;
  readonly subagentOwnerPid?: number;
  readonly workdir?: string;
}

export interface InProcessUiBackendClient extends UiBackendClient {
  dispose(): void;
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
): InProcessUiBackendClient {
  const options = isSnapshot(optionsOrSnapshot)
    ? { initialSnapshot: optionsOrSnapshot }
    : optionsOrSnapshot;
  const initialSnapshot = options.initialSnapshot ?? EMPTY_SNAPSHOT;
  const stateStore =
    options.stateStore ?? createInMemoryUiStateStore(initialSnapshot);
  const bus = options.bus ?? createBus();
  const permissionState = createPermissionState({
    bus,
    initialLevel: initialSnapshot.permission?.level,
    initialMode: initialSnapshot.permission?.mode,
  });
  for (const rules of initialSnapshot.permission?.sessionRules ?? []) {
    for (const rule of rules.rules) {
      permissionState.addSessionRule(rules.sessionId, rule);
    }
  }
  const permission = createPermissionManager({ bus, state: permissionState });
  const messageManager =
    options.messageManager ??
    createMessageManager({
      bus,
      store: createInMemoryMessageStore(),
    });
  const goalPersistence =
    options.goalPersistence ?? new InMemoryGoalPersistence();
  const interactionBroker = createInteractionBroker({ bus });
  const contextWindowUsage: ContextWindowUsageTracker =
    createContextWindowUsageTracker({ now: timestamp });
  const uiGoalsBySession = new Map<string, UiGoal>();
  for (const goal of initialSnapshot.goals ?? []) {
    uiGoalsBySession.set(goal.sessionId, { ...goal.goal });
  }
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
  const eventRouter = new InProcessEventRouter({
    createNotice: (notice): UiNotice => ({
      ...notice,
      createdAt: notice.createdAt ?? timestamp(),
      id: noticeIds.next(),
    }),
    nowMs: (): number => Date.now(),
  });
  let promptInFlight = false;
  let promptInFlightOwner: PromptOwner | undefined;
  let promptInFlightSessionId: string | undefined;
  let promptRunReady = false;
  const promptIdleWaiters = new Set<() => void>();
  const promptRunReadyWaiters = new Set<() => void>();
  let configSaveQueue: Promise<void> = Promise.resolve();
  let skillRegistryPromise: Promise<SkillRegistry> | undefined;
  const pendingPermissionSessions = new Map<string, string>();
  const runtimeController = new InProcessRuntimeController({
    clearPendingPermissionsForRun,
    createRuntime: async (): Promise<UiRuntimeComposition> => {
      const baseProjectRoot = await resolveProjectRoot();
      const llmClient = await resolveLLMClient(baseProjectRoot);
      const skillRegistry = await getSkillRegistry();
      const runtimeRunIdFactory =
        options.createRunId ??
        (usesPersistentStateStore() ? undefined : (): string => runIds.next());

      const runtime = await createUiRuntimeComposition({
        agentManager: options.agentManager,
        bus,
        ...(options.createSubagentId
          ? { createSubagentId: options.createSubagentId }
          : {}),
        ...(runtimeRunIdFactory === undefined
          ? {}
          : { createRunId: runtimeRunIdFactory }),
        goalPersistence,
        llmClient,
        messageManager,
        hookExecutor: options.hookExecutor,
        now: () => now().getTime(),
        onGoalChange: (event) => {
          publishGoalUpdated(event.sessionId, event.snapshot);
        },
        onNotice: publishNotice,
        permission,
        permissionState,
        runLedger: options.runLedger,
        sessionManager: options.sessionManager,
        skillRegistry,
        streamBridge: options.streamBridge,
        subagentInstanceStore: options.subagentInstanceStore,
        subagentOwnerId: options.subagentOwnerId,
        subagentOwnerPid: options.subagentOwnerPid,
        workdir: baseProjectRoot,
      });
      runtime.goals.attachTurnRunner({
        async runTurn(sessionId, promptText) {
          try {
            await waitForPromptIdle();
            const completion = await submitPromptInternal(promptText, {
              owner: "goal",
              sessionId,
              suppressGoalContextNote: true,
            });
            return goalOutcomeFromRunCompletion(completion);
          } catch (error) {
            return { error: getErrorMessage(error), status: "failed" };
          }
        },
      });
      return runtime;
    },
    publishNotice,
    updateStatus,
  });
  const promptController = new InProcessPromptController({
    isBusyError: (error): boolean => error instanceof SessionRunBusyError,
    readActiveSessionId: async (): Promise<string | null> => {
      const snapshot = await stateStore.readSnapshot();
      return snapshot.activeSessionId;
    },
    retryDelayMs: 250,
    async submitPromptInternal(text, submitOptions): Promise<void> {
      await submitPromptInternal(text, submitOptions);
    },
  });

  function usesPersistentStateStore(): boolean {
    return stateStore.requiresServiceManagersForWrites === true;
  }

  function createDefaultRunId(): string {
    return usesPersistentStateStore() ? `run_${randomUUID()}` : runIds.next();
  }

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
    let runId = options.createRunId?.() ?? createDefaultRunId();
    while ((await stateStore.hasRun?.(runId)) === true) {
      runId = options.createRunId?.() ?? createDefaultRunId();
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
    eventRouter.publish(event);
  }

  function publishNotice(notice: NoticeDraft): void {
    eventRouter.publishNotice(notice);
  }

  function goalSnapshotToUiGoal(snapshot: GoalSnapshot): UiGoal | null {
    if (snapshot.status !== "active" && snapshot.status !== "paused") {
      return null;
    }
    return {
      objective: snapshot.objective,
      ...(snapshot.pauseReason === undefined
        ? {}
        : { pauseReason: snapshot.pauseReason }),
      status: snapshot.status,
    };
  }

  function setGoalProjection(
    sessionId: string,
    snapshot: GoalSnapshot | null,
  ): UiGoal | null {
    const goal = snapshot === null ? null : goalSnapshotToUiGoal(snapshot);
    if (goal === null) {
      uiGoalsBySession.delete(sessionId);
    } else {
      uiGoalsBySession.set(sessionId, goal);
    }
    return goal;
  }

  function publishGoalUpdated(
    sessionId: string,
    snapshot: GoalSnapshot | null,
  ): void {
    const goal = setGoalProjection(sessionId, snapshot);
    publish({
      goal,
      sessionId,
      timestamp: now().getTime(),
      type: "goal.updated",
    });
  }

  function snapshotGoalsFor(
    sessions: readonly UiSession[],
  ): readonly UiSessionGoal[] {
    const sessionIds = new Set(sessions.map((session) => session.id));
    return Array.from(uiGoalsBySession.entries())
      .filter(([sessionId]) => sessionIds.has(sessionId))
      .map((entry) => ({
        goal: { ...entry[1] },
        sessionId: entry[0],
      }));
  }

  async function syncGoalProjectionsFromSource(
    sessions: readonly UiSession[],
  ): Promise<void> {
    const runtime = await runtimeController
      .getRuntimeIfStarted()
      ?.catch(() => undefined);
    if (runtime !== undefined) {
      await Promise.all(
        sessions.map(async (session) => {
          const snapshot = await runtime.goals.getSnapshot(session.id);
          setGoalProjection(session.id, snapshot);
        }),
      );
      return;
    }

    await Promise.all(
      sessions.map(async (session) => {
        const store = await GoalStore.rebuild({
          persistence: goalPersistence,
          sessionId: session.id,
          now: () => now().getTime(),
        });
        setGoalProjection(session.id, store.getSnapshot());
      }),
    );
  }

  function publishSnapshotReplacement(): Promise<void> {
    return eventRouter.publishSnapshotReplacement(readSnapshotWithPermission);
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
        if (context?.kind === "skill-override") {
          return;
        }

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
    const runId = runtimeController.getActiveRunId();
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
    const activeRunId = runtimeController.getActiveRunId();
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

  function currentPermissionState(): UiPermissionState {
    return permissionState.toSnapshot();
  }

  async function readSnapshotWithPermission(): Promise<UiSnapshot> {
    const snapshot = await stateStore.readSnapshot();
    const contextWindowUsages = contextWindowUsage.list();
    await syncGoalProjectionsFromSource(snapshot.sessions);
    const goals = snapshotGoalsFor(snapshot.sessions);
    return {
      ...snapshot,
      ...(contextWindowUsages.length > 0 ? { contextWindowUsages } : {}),
      ...(goals.length > 0 || snapshot.goals !== undefined ? { goals } : {}),
      permission: currentPermissionState(),
    };
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

  async function currentModelFromOptions(): Promise<CommandModelSummary | null> {
    const client = options.llmClient ?? (await resolveLLMClient());
    return {
      active: true,
      ...(client.config.apiKeyEnv === undefined
        ? {}
        : { apiKeyEnv: client.config.apiKeyEnv }),
      baseUrl: client.config.baseUrl,
      id: `${client.config.provider}:${client.config.model}`,
      interfaceProvider: client.config.interfaceProvider,
      label: client.config.model,
      model: client.config.model,
      provider: client.config.provider,
    };
  }

  function connectModelConfigFromRuntimeConfig(
    config: LLMClientInstance["config"],
  ): UiCurrentModelConfig {
    return {
      ...(config.apiKeyEnv === undefined
        ? {}
        : { apiKeyEnv: config.apiKeyEnv }),
      baseUrl: config.baseUrl,
      ...(config.contextWindowTokens === undefined
        ? {}
        : { contextWindowTokens: config.contextWindowTokens }),
      interfaceProvider: config.interfaceProvider,
      maxOutputTokens: config.maxTokens,
      model: config.model,
      provider: config.provider,
    };
  }

  function connectModelConfigFromModelJson(
    modelJson: ModelJsonConfig,
  ): UiCurrentModelConfig {
    return {
      ...(modelJson.apiConfig.apiKeyEnv === undefined
        ? {}
        : { apiKeyEnv: modelJson.apiConfig.apiKeyEnv }),
      baseUrl: modelJson.apiConfig.baseUrl,
      ...(modelJson.llmParams.contextWindowTokens === undefined
        ? {}
        : { contextWindowTokens: modelJson.llmParams.contextWindowTokens }),
      interfaceProvider:
        modelJson.apiConfig.interfaceProvider ?? "openai-compatible",
      maxOutputTokens: modelJson.llmParams.maxTokens,
      model: modelJson.defaultModel,
      provider: modelJson.provider,
    };
  }

  async function currentConnectModelFromOptions(): Promise<UiCurrentModelConfig | null> {
    if (options.llmClient) {
      return connectModelConfigFromRuntimeConfig(options.llmClient.config);
    }
    try {
      const rawConfig = await loadModelJson();
      validateModelJson(rawConfig);
      return connectModelConfigFromModelJson(rawConfig);
    } catch (error) {
      if (error instanceof ConfigError && error.code === "FILE_NOT_FOUND") {
        return null;
      }
      throw error;
    }
  }

  async function listModelsFromOptions(): Promise<
    readonly CommandModelSummary[]
  > {
    const current = await currentModelFromOptions();
    return current ? [current] : [];
  }

  async function resolveCoreSessionDisplayTitle(
    session: CoreSession,
  ): Promise<string> {
    if (!isDefaultSessionTitle(session.title)) {
      return session.title;
    }

    try {
      const messages = await messageManager.listBySession(session.id);
      return resolveSessionDisplayTitle({
        messages,
        title: session.title,
      });
    } catch {
      return session.title;
    }
  }

  function resolveUiSessionDisplayTitle(session: UiSession): string {
    if (!isDefaultSessionTitle(session.title)) {
      return session.title;
    }

    for (const message of session.messages) {
      if (message.role !== "user") {
        continue;
      }
      const text = message.parts
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join(" ")
        .trim();
      if (text !== "") {
        return createTemporarySessionTitle(text);
      }
    }

    return session.title;
  }

  async function listSessionsFromState(): Promise<
    readonly CommandSessionSummary[]
  > {
    const projectRoot = await resolveProjectRoot();
    if (options.sessionManager) {
      const sessions = await options.sessionManager.listByProjectRoot(
        projectRoot,
        {
          status: "active",
        },
      );
      return Promise.all(
        sessions
          .filter(
            (session) =>
              isPrimarySession(session) &&
              sameSessionProjectRoot(session.projectRoot, projectRoot),
          )
          .sort(sortCoreSessionsByUpdatedAtDesc)
          .map(async (session) => ({
            createdAt: session.createdAt,
            id: session.id,
            title: await resolveCoreSessionDisplayTitle(session),
            updatedAt: session.updatedAt,
          })),
      );
    }
    const snapshot = await stateStore.readSnapshot();
    return snapshot.sessions
      .filter(
        (session) =>
          session.projectRoot === undefined ||
          sameSessionProjectRoot(session.projectRoot, projectRoot),
      )
      .sort(sortUiSessionsByUpdatedAtDesc)
      .map((session) => ({
        createdAt: parseUiTimestamp(session.createdAt),
        id: session.id,
        title: resolveUiSessionDisplayTitle(session),
        updatedAt: parseUiTimestamp(session.updatedAt),
      }));
  }

  async function resolveNewSessionProjectRoot(
    snapshot: UiSnapshot,
  ): Promise<string> {
    const activeSession = snapshot.sessions.find(
      (session) => session.id === snapshot.activeSessionId,
    );
    if (activeSession?.projectRoot && activeSession.projectRoot !== "") {
      return activeSession.projectRoot;
    }
    return resolveProjectRoot();
  }

  async function activateSessionForNewCommand(input: {
    readonly publishUpdate: boolean;
    readonly session: UiSession;
  }): Promise<CommandSessionSummary> {
    sessionIds.reserve(input.session.id);
    await upsertSession(input.session);
    await stateStore.setActiveSessionId(input.session.id);
    if (input.publishUpdate) {
      publish({
        type: "session.updated",
        session: cloneSession(input.session),
      });
    }
    await publishSnapshotReplacement();

    return {
      created: false,
      id: input.session.id,
      title: input.session.title,
    };
  }

  async function createSessionFromCommand(input?: {
    readonly reuseInactiveEmptySessions?: boolean;
  }): Promise<CommandSessionSummary> {
    await reserveIdsFromState();
    const snapshot = await stateStore.readSnapshot();
    const createdAt = timestamp();
    const projectRoot = await resolveNewSessionProjectRoot(snapshot);
    const title = "New session";
    const agentName = options.agentManager?.getDefault() ?? "default";
    const resolved = await resolveSessionForNewPrompt({
      createSession: async () => {
        if (options.sessionManager) {
          const created = await options.sessionManager.create(projectRoot, {
            agentName,
            title,
          });
          return sessionMetadataToUiSession(created);
        }
        return {
          id: sessionIds.next(),
          title,
          messages: [],
          projectRoot,
          createdAt,
          updatedAt: createdAt,
        };
      },
      getUiSession: (id) => stateStore.getSession(id),
      projectRoot,
      reuseInactiveEmptySessions: input?.reuseInactiveEmptySessions ?? true,
      sessionManager: options.sessionManager,
      snapshot,
    });
    const session = resolved.session;
    const sessionAlreadyInSnapshot = snapshot.sessions.some(
      (candidate) => candidate.id === session.id,
    );

    if (!resolved.isNewSession) {
      return activateSessionForNewCommand({
        publishUpdate: !sessionAlreadyInSnapshot,
        session,
      });
    }

    sessionIds.reserve(session.id);
    await upsertSession(session);
    await stateStore.setActiveSessionId(session.id);
    publish({ type: "session.updated", session: cloneSession(session) });
    await publishSnapshotReplacement();

    return { created: true, id: session.id, title: session.title };
  }

  async function archiveSessionInternal(
    input: UiArchiveSessionInput,
  ): Promise<void> {
    const sessionId = input.sessionId.trim();
    if (sessionId.length === 0) {
      throw new Error("sessionId is required");
    }
    if (!options.sessionManager) {
      throw new Error("Session archive is not available in this backend");
    }
    const snapshot = await stateStore.readSnapshot();
    const session = await options.sessionManager.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (!isPrimarySession(session)) {
      throw new Error(`Cannot archive subagent session: ${sessionId}`);
    }

    await options.sessionManager.update(sessionId, { status: "archived" });
    await stateStore.removeSession?.(sessionId);

    if (snapshot.activeSessionId === sessionId) {
      const remainingSessions = (
        await options.sessionManager.listByProjectRoot(session.projectRoot, {
          status: "active",
        })
      )
        .filter(isPrimarySession)
        .filter((candidate) =>
          sameSessionProjectRoot(candidate.projectRoot, session.projectRoot),
        )
        .sort(sortCoreSessionsByUpdatedAtDesc);
      await stateStore.setActiveSessionId(remainingSessions[0]?.id ?? null);
    }

    await publishSnapshotReplacement();
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

  async function isFirstUserMessageForTitle(input: {
    readonly coreSession?: CoreSession;
    readonly uiSession: UiSession;
  }): Promise<boolean> {
    if (input.coreSession?.isSubagent === true) {
      return false;
    }
    if (
      !isDefaultSessionTitle(input.uiSession.title) ||
      (input.coreSession && !isDefaultSessionTitle(input.coreSession.title))
    ) {
      return false;
    }
    if (input.uiSession.messages.length > 0) {
      return false;
    }
    if ((input.coreSession?.stats.messageCount ?? 0) > 0) {
      return false;
    }

    try {
      const messages = await messageManager.listBySession(input.uiSession.id);
      return messages.length === 0;
    } catch {
      return true;
    }
  }

  async function applyTemporarySessionTitle(input: {
    readonly session: UiSession;
    readonly title: string;
  }): Promise<UiSession> {
    if (input.session.title === input.title) {
      return input.session;
    }

    let updatedSession: UiSession;
    if (options.sessionManager?.update) {
      const updatedCoreSession = await options.sessionManager.update(
        input.session.id,
        { title: input.title },
      );
      updatedSession = {
        ...sessionMetadataToUiSession(updatedCoreSession),
        messages: input.session.messages,
      };
    } else {
      updatedSession = {
        ...input.session,
        title: input.title,
        updatedAt: timestamp(),
      };
    }

    await upsertSession(updatedSession);
    publish({
      type: "session.updated",
      session: cloneSession(updatedSession),
    });
    return updatedSession;
  }

  function scheduleSessionTitleGeneration(input: {
    readonly expectedTitle: string;
    readonly firstUserMessage: string;
    readonly projectRoot: string;
    readonly sessionId: string;
  }): void {
    void (async (): Promise<void> => {
      const llmClient = await resolveLLMClient(input.projectRoot);
      const generatedTitle = await generateSessionTitle({
        firstUserMessage: input.firstUserMessage,
        llmClient,
      });
      if (!generatedTitle || generatedTitle === input.expectedTitle) {
        return;
      }
      await applyGeneratedSessionTitleIfUnchanged({
        expectedTitle: input.expectedTitle,
        sessionId: input.sessionId,
        title: generatedTitle,
      });
    })().catch(() => undefined);
  }

  async function applyGeneratedSessionTitleIfUnchanged(input: {
    readonly expectedTitle: string;
    readonly sessionId: string;
    readonly title: string;
  }): Promise<void> {
    if (options.sessionManager?.update) {
      const coreSession = await options.sessionManager.get(input.sessionId);
      if (coreSession?.title !== input.expectedTitle) {
        return;
      }
      const updatedCoreSession = await options.sessionManager.update(
        input.sessionId,
        { title: input.title },
      );
      const uiSession = await stateStore.getSession(input.sessionId);
      if (uiSession?.title === input.expectedTitle) {
        const updatedUiSession = {
          ...sessionMetadataToUiSession(updatedCoreSession),
          messages: uiSession.messages,
        };
        await upsertSession(updatedUiSession);
        publish({
          type: "session.updated",
          session: cloneSession(updatedUiSession),
        });
      }
      return;
    }

    const uiSession = await stateStore.getSession(input.sessionId);
    if (uiSession?.title !== input.expectedTitle) {
      return;
    }
    const updatedUiSession = {
      ...uiSession,
      title: input.title,
      updatedAt: timestamp(),
    };
    await upsertSession(updatedUiSession);
    publish({
      type: "session.updated",
      session: cloneSession(updatedUiSession),
    });
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
    const runtime = await runtimeController.getRuntimeForPrompt();
    await runtime.setSessionWorkdir(target.sessionId, target.projectRoot);
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

  async function resolveSessionProjectRoot(
    sessionId: string,
  ): Promise<string | null> {
    const [uiSession, coreSession] = await Promise.all([
      stateStore.getSession(sessionId),
      options.sessionManager?.get(sessionId),
    ]);
    if (!uiSession && !coreSession) {
      return null;
    }
    return (
      uiSession?.projectRoot ??
      coreSession?.projectRoot ??
      (await resolveProjectRoot())
    );
  }

  async function getContextWindowUsageInternal(input: {
    readonly sessionId: string;
  }): Promise<UiContextWindowUsage | null> {
    const cached = contextWindowUsage.get(input.sessionId);
    if (cached) {
      return cached;
    }

    const projectRoot = await resolveSessionProjectRoot(input.sessionId);
    if (!projectRoot) {
      return null;
    }

    const runtime = await runtimeController.getRuntime();
    const usage = await runtime.getContextUsage({
      projectRoot,
      sessionId: input.sessionId,
    });
    return contextWindowUsage.updateFromContextUsage(input.sessionId, usage);
  }

  async function submitPromptInternal(
    text: string,
    submitOptions?: InternalSubmitPromptOptions,
  ): Promise<RunCompletion | undefined> {
    const owner = submitOptions?.owner ?? "user";
    await waitForPromptSlot(owner);
    assertStateStoreWritable();
    await options.beforePromptSubmit?.();
    promptInFlight = true;
    promptInFlightOwner = owner;
    promptInFlightSessionId = submitOptions?.sessionId;
    promptRunReady = false;
    const createdAt = timestamp();
    let projection: RunStreamProjection | undefined;
    let submittedSessionId: string | undefined;

    try {
      await assertCanUseAsPrimarySession(submitOptions?.sessionId);
      await reserveIdsFromState();
      const runtime = await runtimeController.getRuntimeForPrompt();
      const agentName = runtime.agentManager.getDefault();
      const baseProjectRoot = await resolveProjectRoot();
      const temporaryTitle = createTemporarySessionTitle(text);
      const snapshot = await stateStore.readSnapshot();
      const resolvedSession = await resolveSessionForNewPrompt({
        createSession: async (id) => {
          if (options.sessionManager) {
            const created = await options.sessionManager.create(
              baseProjectRoot,
              {
                agentName,
                id,
                title: temporaryTitle,
              },
            );
            return sessionMetadataToUiSession(created);
          }
          return {
            id: id ?? sessionIds.next(),
            title: temporaryTitle,
            messages: [],
            projectRoot: baseProjectRoot,
            createdAt,
            updatedAt: createdAt,
          };
        },
        explicitSessionId: submitOptions?.sessionId,
        getUiSession: (id) => stateStore.getSession(id),
        projectRoot: baseProjectRoot,
        sessionManager: options.sessionManager,
        snapshot,
      });
      let session = resolvedSession.session;
      const existingCoreSession = resolvedSession.coreSession;
      let shouldGenerateSessionTitle = false;
      const isNewSession = resolvedSession.isNewSession;
      if (isNewSession) {
        shouldGenerateSessionTitle = true;
        sessionIds.reserve(session.id);
      } else if (
        await isFirstUserMessageForTitle({
          coreSession: existingCoreSession ?? undefined,
          uiSession: session,
        })
      ) {
        shouldGenerateSessionTitle = true;
        session = await applyTemporarySessionTitle({
          session,
          title: temporaryTitle,
        });
      }
      const resolvedProjectRoot = session.projectRoot ?? baseProjectRoot;
      submittedSessionId = session.id;
      promptInFlightSessionId = session.id;

      const modelPromptText = await promptTextForModel({
        owner,
        runtime,
        sessionId: session.id,
        suppressGoalContextNote:
          submitOptions?.suppressGoalContextNote === true,
        text,
      });

      const userMessage = createTextMessage({
        id: messageIds.next(),
        role: "user",
        text,
        createdAt,
      });
      const runId = await nextRunId();
      const assistantMessageId = messageIds.next();
      runtimeController.setActiveRunId(runId);
      projection = runtimeController.startRunStreamProjection({
        assistantMessageId,
        autoStart: false,
        contextWindowUsage,
        nextMessageId: () => messageIds.next(),
        onNotice: publishNotice,
        publish,
        runId,
        sessionId: session.id,
        stateStore,
        streamBridge: runtime.streamBridge,
        timestamp,
      });

      try {
        const result = await runtime.startSession({
          agentName,
          prompt: modelPromptText,
          projectRoot: resolvedProjectRoot,
          runId,
          sessionId: session.id,
          title: session.title,
        });
        if (result.runId !== runId) {
          throw new Error(
            `Agent service created unexpected run id: ${result.runId}`,
          );
        }
      } catch (error) {
        await projection.stop();
        throw error;
      }

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

      if (shouldGenerateSessionTitle) {
        scheduleSessionTitleGeneration({
          expectedTitle: temporaryTitle,
          firstUserMessage: text,
          projectRoot: resolvedProjectRoot,
          sessionId: session.id,
        });
      }

      projection.start();
      promptRunReady = true;
      notifyPromptRunReady();

      try {
        const completion = await runtime.runManager.waitForCompletion(runId);
        await projection.done;
        if (completion.status === "cancelled") {
          // Interruption is a normal user action, not an error.
          return completion;
        }
        if (completion.status !== "succeeded") {
          throw new Error(completion.error ?? `Run ${completion.status}`);
        }
        return completion;
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
      promptInFlightOwner = undefined;
      promptInFlightSessionId = undefined;
      promptRunReady = false;
      runtimeController.clearActiveRunId();
      try {
        await options.afterPromptSubmitSettled?.();
      } finally {
        notifyPromptIdle();
      }
    }
  }

  function notifyPromptIdle(): void {
    const waiters = [...promptIdleWaiters];
    promptIdleWaiters.clear();
    for (const resolve of waiters) {
      resolve();
    }
  }

  function notifyPromptRunReady(): void {
    const waiters = [...promptRunReadyWaiters];
    promptRunReadyWaiters.clear();
    for (const resolve of waiters) {
      resolve();
    }
  }

  async function waitForPromptSlot(owner: PromptOwner): Promise<void> {
    for (;;) {
      if (!promptInFlight) {
        return;
      }
      if (owner === "user" && promptInFlightOwner === "goal") {
        await interruptGoalPromptInFlight();
        continue;
      }
      if (owner === "goal" && promptInFlightOwner === "user") {
        await waitForPromptIdle();
        continue;
      }
      throw new Error("A prompt is already running");
    }
  }

  async function interruptGoalPromptInFlight(): Promise<void> {
    const sessionId = promptInFlightSessionId;
    try {
      await waitForPromptRunReadyOrIdle();
      const runId = runtimeController.getActiveRunId();
      if (runId) {
        await runtimeController.abortPromptRun(runId);
      }
      if (sessionId) {
        const runtime = await runtimeController.getRuntimeForPrompt();
        await runtime.goals
          .pauseGoal(sessionId, "interrupted")
          .catch(() => undefined);
      }
    } finally {
      await waitForPromptIdle();
    }
  }

  async function waitForPromptIdle(): Promise<void> {
    if (!promptInFlight) {
      return;
    }
    await new Promise<void>((resolve) => {
      promptIdleWaiters.add(resolve);
    });
  }

  async function waitForPromptRunReadyOrIdle(): Promise<void> {
    if (!promptInFlight || promptRunReady) {
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const resolveOnce = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        promptRunReadyWaiters.delete(resolveOnce);
        promptIdleWaiters.delete(resolveOnce);
        resolve();
      };
      promptRunReadyWaiters.add(resolveOnce);
      promptIdleWaiters.add(resolveOnce);
    });
  }

  async function promptTextForModel(input: {
    readonly owner: PromptOwner;
    readonly runtime: UiRuntimeComposition;
    readonly sessionId: string;
    readonly suppressGoalContextNote: boolean;
    readonly text: string;
  }): Promise<string> {
    if (input.owner !== "user" || input.suppressGoalContextNote) {
      return input.text;
    }
    const snapshot = await input.runtime.goals.getSnapshot(input.sessionId);
    if (snapshot === null) {
      return input.text;
    }
    publishGoalUpdated(input.sessionId, snapshot);
    const note = renderGoalContextNote(snapshot);
    if (note === undefined) {
      return input.text;
    }
    return `${note}\n\nCurrent user request:\n${input.text}`;
  }

  async function connectModelInternal(
    input: UiConnectModelInput,
  ): Promise<UiConnectModelResult> {
    const isPromptRunning = (): boolean => promptInFlight;
    if (isPromptRunning()) {
      throw new Error("Cannot save while running");
    }
    if (options.llmClient) {
      throw new Error("Connect model is unavailable for injected LLM clients");
    }

    const previousSave = configSaveQueue;
    let releaseSave!: () => void;
    const currentSave = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    configSaveQueue = previousSave.then(
      () => currentSave,
      () => currentSave,
    );

    await previousSave.catch(() => undefined);
    if (isPromptRunning()) {
      releaseSave();
      throw new Error("Cannot save while running");
    }

    try {
      const projectRoot = await resolveProjectRoot();
      const result = await applyActiveModelConfig({
        ...input,
        projectRoot,
      });
      runtimeController.resetRuntime();
      contextWindowUsage.clear();
      await publishSnapshotReplacement();
      return result;
    } finally {
      releaseSave();
    }
  }

  async function probeModelContextWindowInternal(
    input: Parameters<UiBackendClient["probeModelContextWindow"]>[0],
  ): ReturnType<UiBackendClient["probeModelContextWindow"]> {
    return probeActiveModelContextWindow(input);
  }

  async function setSearchApiKeyInternal(
    input: UiSetSearchApiKeyInput,
  ): Promise<UiSetSearchApiKeyResult> {
    const isPromptRunning = (): boolean => promptInFlight;
    if (isPromptRunning()) {
      throw new Error("Cannot save while running");
    }

    const previousSave = configSaveQueue;
    let releaseSave!: () => void;
    const currentSave = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    configSaveQueue = previousSave.then(
      () => currentSave,
      () => currentSave,
    );

    await previousSave.catch(() => undefined);
    if (isPromptRunning()) {
      releaseSave();
      throw new Error("Cannot save while running");
    }

    try {
      const result = await writeSearchApiKey(input);
      await reloadSearchConfig();
      return result;
    } finally {
      releaseSave();
    }
  }

  function goalOutcomeFromRunCompletion(
    completion: RunCompletion | undefined,
  ): GoalTurnOutcome {
    if (completion?.status === "cancelled") {
      return { status: "cancelled" };
    }
    if (completion?.status === "succeeded") {
      return {
        status: "succeeded",
        ...(completion.usage?.totalTokens === undefined
          ? {}
          : { tokensUsed: completion.usage.totalTokens }),
      };
    }
    return {
      error: completion?.error ?? `Run ${completion?.status ?? "failed"}`,
      status: "failed",
    };
  }

  async function resolveGoalSessionId(
    explicit?: string,
  ): Promise<string | undefined> {
    const explicitSessionId = explicit?.trim();
    if (explicitSessionId) {
      await assertCanUseAsPrimarySession(explicitSessionId);
      return explicitSessionId;
    }
    const snapshot = await stateStore.readSnapshot();
    if (!snapshot.activeSessionId) {
      return undefined;
    }
    await assertCanUseAsPrimarySession(snapshot.activeSessionId);
    return snapshot.activeSessionId;
  }

  async function goalService(): Promise<UiRuntimeComposition["goals"]> {
    const runtime = await runtimeController.getRuntimeForPrompt();
    return runtime.goals;
  }

  const goalCommandBackend: CommandGoalBackend = {
    async cancel(sessionId) {
      await (await goalService()).cancelGoal(sessionId);
    },
    async create(sessionId, input) {
      return (await goalService()).createGoal(sessionId, {
        actor: "user",
        objective: input.objective,
        ...(input.budgetLimits === undefined
          ? {}
          : { budgetLimits: input.budgetLimits }),
      });
    },
    async pause(sessionId) {
      return (await goalService()).pauseGoal(sessionId);
    },
    async replace(sessionId, objective) {
      return (await goalService()).replaceGoal(sessionId, objective);
    },
    resolveSessionId: resolveGoalSessionId,
    async resume(sessionId) {
      return (await goalService()).resumeGoal(sessionId);
    },
    async setBudget(sessionId, limits) {
      return (await goalService()).setBudget(sessionId, limits);
    },
    async status(sessionId) {
      const snapshot = await (await goalService()).getSnapshot(sessionId);
      publishGoalUpdated(sessionId, snapshot);
      return snapshot;
    },
  };

  const commandService = createCommandService({
    bus,
    goals: goalCommandBackend,
    interactionBroker,
    tools: {
      async listTools() {
        const runtime = await runtimeController.getRuntime();
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
        await publishSnapshotReplacement();
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
    mcps: {
      async listServers() {
        const runtime = await runtimeController.getRuntime();
        return runtime.listMcpServerSummaries();
      },
    },
    async submitPrompt(text, submitOptions): Promise<void> {
      await submitPromptInternal(text, submitOptions);
    },
    connectModel: connectModelInternal,
    setSearchApiKey: setSearchApiKeyInternal,
    permission: {
      getState: currentPermissionState,
      setMode(mode): void {
        permissionState.setMode(mode);
      },
      toggleMode(): ReturnType<typeof permissionState.toggleMode> {
        return permissionState.toggleMode();
      },
      setLevel(level): void {
        permissionState.setLevel(level);
      },
    },
    abortRun(runId?: string): void {
      if (!runId) {
        void runtimeController.abortPromptRun();
        interactionBroker.abortAll("aborted");
        return;
      }
      if (runtimeController.isActiveRun(runId)) {
        void runtimeController.abortPromptRun(runId);
        return;
      }
      commandService.abortCommandRun(runId, "aborted");
    },
    getStatus(): string {
      return promptInFlight ? "running" : "idle";
    },
    getContextWindowUsage(input) {
      return getContextWindowUsageInternal(input);
    },
    async getContextUsage(input) {
      if (!input.sessionId) {
        return null;
      }
      try {
        const runtime = await runtimeController.getRuntime();
        return await runtime.getContextUsage({
          projectRoot: await resolveProjectRoot(),
          sessionId: input.sessionId,
        });
      } catch {
        return null;
      }
    },
    getProjectRoot: resolveProjectRoot,
  });

  eventRouter.addSubscriptions(
    subscribeAppEventProjectors({
      bus,
      target(projected) {
        publish(projected.uiEvent);
      },
    }),
    startPermissionEventProjection({
      bus,
      currentPermissionState,
      getActiveRunId: () => runtimeController.getActiveRunId(),
      now: () => Date.now(),
      pendingPermissionSessions,
      publish,
      reconcileRuntimeStatus,
      stateStore,
      onAsyncError(error): void {
        const message = getErrorMessage(error);
        publishNotice({
          key: `permission:projection:${message}`,
          level: "error",
          message: `Permission event projection failed: ${message}`,
          source: "permission",
          title: "Permission update failed",
        });
      },
    }),
  );
  return {
    dispose(): void {
      promptController.close();
      eventRouter.dispose();
    },

    getSnapshot(): Promise<UiSnapshot> {
      return readSnapshotWithPermission();
    },

    getContextWindowUsage(input): Promise<UiContextWindowUsage | null> {
      return getContextWindowUsageInternal(input);
    },

    subscribeEvents(handler: UiEventHandler): () => void {
      return eventRouter.subscribeEvents(handler);
    },

    listCommands(query): Promise<UiCommandCatalog> {
      return commandService.listCommands(query);
    },

    submitPrompt(
      text: string,
      submitOptions?: SubmitPromptOptions,
    ): Promise<void> {
      return promptController.submitPrompt(text, submitOptions);
    },

    compactSession(
      compactOptions?: UiCompactSessionOptions,
    ): Promise<UiCompactSessionResult> {
      return compactSessionInternal(compactOptions);
    },

    archiveSession(input: UiArchiveSessionInput): Promise<void> {
      return archiveSessionInternal(input);
    },

    probeModelContextWindow(
      input: Parameters<UiBackendClient["probeModelContextWindow"]>[0],
    ): ReturnType<UiBackendClient["probeModelContextWindow"]> {
      return probeModelContextWindowInternal(input);
    },

    connectModel(input: UiConnectModelInput): Promise<UiConnectModelResult> {
      return connectModelInternal(input);
    },

    setSearchApiKey(
      input: UiSetSearchApiKeyInput,
    ): Promise<UiSetSearchApiKeyResult> {
      return setSearchApiKeyInternal(input);
    },

    setPermission(input: UiPermissionUpdate): Promise<UiPermissionState> {
      if (input.mode !== undefined) {
        permissionState.setMode(input.mode);
      }
      if (input.level !== undefined) {
        permissionState.setLevel(input.level);
      }
      return Promise.resolve(permissionState.toSnapshot());
    },

    getCurrentModel(): Promise<UiCurrentModelConfig | null> {
      return currentConnectModelFromOptions();
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
              ?.runId ?? runtimeController.getActiveRunId();
          if (runId) {
            await runtimeController.cancelPromptRun(runId);
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
        await runtimeController.abortPromptRun();
        interactionBroker.abortAll("aborted");
      } else if (runtimeController.isActiveRun(runId)) {
        await runtimeController.abortPromptRun(runId);
      } else {
        commandService.abortCommandRun(runId, "aborted");
      }
    },
  };
}
