import { AgentRegistry } from "../agents/registry.js";
import { loadAgentConfigWithOrigins } from "../config/agents/loaders.js";
import {
  readSettingsMcpStatus,
  readSettingsSkills,
  readSettingsAgents,
  type InstanceSettingsReader,
  type InstanceSettingsControl,
} from "../services/settings/reader.js";
import {
  slashSkillUsage,
  slashSkillName,
  expandedSkillNamingSource,
  publicNamingSource,
} from "../skill/usage.js";
import {
  collectCleanup,
  createShutdownOptions,
  type ShutdownOptions,
  type CleanupResult,
} from "../runtime/shutdown.js";
import { SessionExecutionGate } from "./session-execution.js";
import { exportSession } from "../services/session-export/index.js";
import { getAgentPackageVersion } from "../package-version.js";
import { projectUnconsumedSteers } from "./ui-inprocess/steer-recovery.js";
import { RunFinalizationError } from "../runtime/run-manager/errors.js";
import { SubagentConversationProjection } from "./ui-inprocess/subagent-conversation.js";
import { InMemorySubagentExecutionStore } from "../agents/subagents/execution-store.js";
import { createSubagentViewReader } from "./ui-inprocess/subagent-views.js";
import {
  InMemoryCurrentRunInputStore,
  type CurrentRunInputStore,
} from "../runtime/prompt-scheduler/current-run-inputs.js";
import { createCoordinatedRunLedger } from "./ui-state/coordinated-run-ledger.js";
import { createInMemoryRunLedger } from "../runtime/run-ledger/index.js";
import { SourceSessionProjection } from "./ui-state/source-session-projection.js";
import { runToUiRun, messageToUiMessage } from "./ui-state/persistent-store.js";
import type {
  UiSessionRecoveryClient,
  UiSessionScope,
  UiSessionView,
  UiSessionHistory,
  UiSessionControl,
  UiPromptReceiptResult,
} from "ohbaby-sdk";
import type { ResolveRequestReasoningOptions } from "ohbaby-llm";
import { validateReasoningConfig } from "ohbaby-llm";
import type { ReasoningConfig } from "ohbaby-llm";
import { resolveRequestReasoning } from "ohbaby-llm";
import { reasoningCapabilityView } from "../services/llm-model/reasoning-view.js";
import { currentDiscoveryState } from "../config/llm/apply-active-model-config.js";
import {
  coordinateModelConfig,
  settingsConfigVersion,
  type SettingsConfigVersions,
} from "../config/llm/config-coordination.js";
import { createModelClientPool } from "./ui-inprocess/model-client-pool.js";
import { createRunModel } from "./ui-runtime/run-model.js";
import type { RunModel } from "../core/run-model.js";
import {
  readModelDocument,
  configurationComplete,
  ModelSettingsError,
} from "../config/llm/model-document.js";
import { selectModelEntry } from "../config/llm/writer.js";
import { createPermissionProjection } from "./app-events/permission-projection.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { submitPromptAndWait as composeSubmitPromptAndWait } from "ohbaby-sdk";
import type {
  SubmitPromptOptions,
  UiSubmitPromptAndWaitOptions,
  UiWaitForPromptOptions,
  UiBackendClient,
  UiAcquirePromptEditLeaseInput,
  UiSteerQueuedPromptInput,
  UiSteerQueuedPromptResult,
  UiResendSteerInput,
  UiCancelQueuedPromptInput,
  UiEditQueuedPromptInput,
  UiResubmitRetainedPromptInput,
  UiPromptResubmissionReceipt,
  UiPromptCompletion,
  UiPromptCacheUsage,
  UiPromptEditLease,
  UiPromptReceipt,
  UiPromptSubmission,
  UiRenewPromptEditLeaseInput,
  UiReleasePromptEditLeaseInput,
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
  UiSessionIndexEntry,
  UiSessionCreationResult,
  UiPermissionUpdate,
  UiRun,
  UiRunStatus,
  UiSetSearchApiKeyInput,
  UiSetSearchApiKeyResult,
  UiSessionGoal,
  UiSessionTodoList,
  UiSnapshot,
  UiSession,
} from "ohbaby-sdk";
import type { BusInstance } from "../bus/index.js";
import type { LLMConfig } from "ohbaby-llm";
import type { LLMClientInstance } from "ohbaby-llm";
import { createBus } from "../bus/index.js";
import type {
  CommandGoalBackend,
  CommandModelSummary,
  CommandSessionSummary,
} from "../commands/index.js";
import { GoalService, InMemoryGoalPersistence } from "../goals/index.js";
import { executeGoalExecutionInterrupt } from "./goal-execution-control.js";
import type {
  GoalPersistencePort,
  GoalExecutionInterruptInput,
  GoalSnapshot,
  GoalTurnOutcome,
  GoalTurnTicket,
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
import { createPromptCacheUsageTracker } from "./ui-inprocess/prompt-cache-usage.js";
import {
  promptRecordToCompletion,
  promptRecordToUi,
  runCompletionToPromptExecutionResult,
} from "./ui-inprocess/prompt-mapper.js";
import {
  createTemporarySessionTitle,
  sessionTitleIntent,
  generateSessionTitle,
  isDefaultSessionTitle,
  isSessionInWorkingDirectory,
  resolveSessionDisplayTitle,
  sameSessionDirectory,
  SessionEvent,
  SessionMovedError,
  sessionTargetWorkingDirectory,
} from "../services/session/index.js";
import {
  createPermissionManager,
  createPermissionState,
  InvalidPermissionChoiceError,
  PermissionUnavailableError,
} from "../permission/index.js";
import type { PermissionResponse as CorePermissionResponse } from "../permission/index.js";
import { Project } from "../project/index.js";
import { IrisError } from "../utils/index.js";
import { AgentManager } from "../agents/index.js";
import {
  InMemorySubagentInstanceStore,
  type SubagentInstanceStore,
} from "../agents/index.js";
import {
  goalTodoWorkScopeId,
  recoverTodosFromMessages,
  type TodoService,
  type TodoWorkScopeId,
  type TodoWorkScopeLease,
  type TodoWriteEvent,
} from "../tools/todo.js";
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
  InMemoryPromptSubmissionStore,
  WorkspacePromptScheduler,
  PromptSubmissionRejectedError,
  type PromptExecutionResult,
  type PromptSubmissionStore,
} from "../runtime/prompt-scheduler/index.js";
import {
  cloneMessage,
  cloneRun,
  cloneSession,
  createInMemoryUiStateStore,
} from "./ui-state/index.js";
import type { UiStateStore } from "./ui-state/index.js";
import {
  createUiRuntimeComposition,
  loadConfiguredSkillDirectories,
} from "./ui-runtime/composition.js";
import { McpManager } from "../mcp/core/manager.js";
import type { HostLocalSandboxManager } from "./ui-runtime/host-local-environment.js";
import type { UiRuntimeComposition } from "./ui-runtime/types.js";
import {
  startPermissionEventProjection,
  subscribeAppEventProjectors,
} from "./app-events/index.js";
import {
  applyActiveModelConfig,
  probeActiveModelContextWindow,
} from "../config/llm/apply-active-model-config.js";
import { ConfigError } from "ohbaby-llm";
import {
  reloadSearchConfig,
  SearchConfigError,
  setSearchApiKey as writeSearchApiKey,
} from "../config/tools/search/index.js";
import { InProcessEventRouter } from "./ui-inprocess/event-router.js";
import {
  InProcessRuntimeController,
  RuntimeSwitchPendingError,
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
import { NOOP_LOGGER, type Logger } from "../observability/index.js";

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
  readonly expectedTemporaryTitle?: string;
  readonly hasModelSnapshot?: boolean;
  readonly signal?: AbortSignal;
  readonly owner?: PromptOwner;
  readonly goalId?: string;
  readonly goalTicket?: GoalTurnTicket;
  /** Display value from the same admission snapshot as goalTicket. */
  readonly displayText?: string;
  readonly reservedUserMessageId?: string;
  readonly onRunStarted?: (runId: string) => Promise<void>;
};

interface ActivePromptState {
  readonly owner: PromptOwner;
  readonly sessionId: string;
  readonly goalId?: string;
  readonly todoWorkScopeId?: TodoWorkScopeId;
  runId?: string;
  runReady: boolean;
}

export interface InProcessUiBackendOptions {
  readonly afterPromptSubmitSettled?: () => Promise<void> | void;
  readonly agentManager?: AgentManager;
  readonly beforePromptSubmit?: () => Promise<void> | void;
  readonly bus?: BusInstance;
  readonly createSubagentId?: () => string;
  readonly createRunId?: () => string;
  readonly createPromptUserMessageId?: () => string;
  readonly goalPersistence?: GoalPersistencePort;
  readonly hookExecutor?: HookExecutor;
  readonly initialSnapshot?: UiSnapshot;
  readonly startupReady?: Promise<unknown>;
  readonly recoverExecutionSession?: (
    sessionId: string,
  ) => Promise<boolean> | Promise<void>;
  readonly llmClient?: LLMClientInstance;
  readonly logger?: Logger;
  readonly diagnosticsFilePath?: string;
  readonly createLLMClient?: (config: LLMConfig) => Promise<LLMClientInstance>;
  readonly messageManager?: MessageManager;
  readonly sessionManager?: InProcessSessionManager;
  readonly stateStore?: UiStateStore;
  readonly projectDirectory?: string;
  readonly promptScopeKey?: string;
  readonly promptSubmissionStore?: PromptSubmissionStore;
  readonly currentRunInputStore?: CurrentRunInputStore;
  /** Startup recovery failures stay visible until explicit session entry succeeds. */
  readonly assertExecutionRecoveryReady?: (sessionId: string) => void;
  readonly promptQueueOwnerClientId?: string;
  readonly now?: () => Date;
  readonly runLedger?: RunLedger;
  readonly sandboxManager?: HostLocalSandboxManager;
  readonly streamBridge?: StreamBridge;
  readonly subagentInstanceStore?: SubagentInstanceStore;
  readonly subagentExecutionStore?: import("../agents/index.js").SubagentExecutionStore;
  readonly subagentOwnerId?: string;
  readonly subagentOwnerPid?: number;
  readonly workdir?: string;
}

export interface UiPromptQueueExecutionPort {
  resubmitRetainedPromptForOwner(
    input: UiResubmitRetainedPromptInput,
    trustedOwnerClientId: string,
  ): Promise<UiPromptResubmissionReceipt>;
  steerQueuedPromptForOwner(
    input: UiSteerQueuedPromptInput,
    trustedOwnerClientId: string,
  ): Promise<UiSteerQueuedPromptResult>;
  resendSteerInputForOwner(
    input: UiResendSteerInput,
    trustedOwnerClientId: string,
    expectedSessionId?: string,
  ): Promise<UiPromptReceipt>;
  editQueuedPromptForOwner(
    input: UiEditQueuedPromptInput,
    trustedOwnerClientId: string,
  ): Promise<UiPromptSubmission>;
  cancelQueuedPromptForOwner(
    input: UiCancelQueuedPromptInput,
    trustedOwnerClientId: string,
  ): Promise<UiPromptSubmission>;
  acquirePromptEditLeaseForOwner(
    input: UiAcquirePromptEditLeaseInput,
    trustedOwnerClientId: string,
  ): Promise<UiPromptEditLease>;
  renewPromptEditLeaseForOwner(
    input: UiRenewPromptEditLeaseInput,
    trustedOwnerClientId: string,
  ): Promise<UiPromptEditLease>;
  releasePromptEditLeaseForOwner(
    input: UiReleasePromptEditLeaseInput,
    trustedOwnerClientId: string,
  ): Promise<UiPromptSubmission>;
}

export interface InProcessUiBackendClient
  extends
    Omit<UiBackendClient, keyof UiSessionRecoveryClient>,
    UiPromptQueueExecutionPort,
    UiSessionRecoveryClient,
    InstanceSettingsReader,
    InstanceSettingsControl {
  listSubagentExecutions: NonNullable<
    UiBackendClient["listSubagentExecutions"]
  >;
  getSubagentExecutionView: NonNullable<
    UiBackendClient["getSubagentExecutionView"]
  >;
  getSubagentConversationView: NonNullable<
    UiBackendClient["getSubagentConversationView"]
  >;
  retainSubagentConversation: NonNullable<
    UiBackendClient["retainSubagentConversation"]
  >;
  releaseSubagentConversation: NonNullable<
    UiBackendClient["releaseSubagentConversation"]
  >;
  initialize(): Promise<void>;
  initializeSession(sessionId: string): Promise<void>;
  /** Re-reads the durable prompt queue after another workspace handed prompts over. */
  wakePromptQueue(): void;
  assertSessionRoutable(sessionId: string): Promise<void>;
  /** Read inside the session owner boundary; does not steer or reserve execution. */
  getActiveGoalRunForSteer(
    sessionId: string,
  ): { runId: string; goalId: string } | undefined;
  closeAdmission(): void;
  dispose(options?: ShutdownOptions): Promise<CleanupResult>;
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
    return response.remember === true ? { type: "always" } : { type: "once" };
  }
  if (response.choiceId === "allow_always" && response.remember !== false)
    return { type: "always" };
  if (response.choiceId === "reject" && response.remember !== true)
    return { type: "reject" };
  throw new InvalidPermissionChoiceError();
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
  if (
    options.runLedger !== undefined &&
    stateStore.runLedger !== undefined &&
    options.runLedger !== stateStore.runLedger
  ) {
    throw new Error(
      "Injected runLedger must match the UI state store runLedger",
    );
  }
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
  const permissionProjection = createPermissionProjection();
  const permission = createPermissionManager({
    bus,
    state: permissionState,
    criticalCommit: permissionProjection.criticalCommit,
    onCommitted: permissionProjection.notifyCommitted,
    onUnavailable: permissionProjection.markUnavailable,
  });
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
  const promptCacheUsage = createPromptCacheUsageTracker();
  let acceptsPromptCacheUsage = true;
  const retiredPromptCacheSessionIds = new Set<string>();
  const retirePromptCacheSession = (sessionId: string): void => {
    retiredPromptCacheSessionIds.add(sessionId);
    promptCacheUsage.clearSession(sessionId);
  };
  const unsubscribePromptCacheUsageSessionRemoved = bus.subscribe(
    SessionEvent.Removed,
    ({ sessionId }) => {
      retirePromptCacheSession(sessionId);
    },
  );
  const uiGoalsBySession = new Map<string, UiGoal>();
  const goalSnapshotsBySession = new Map<string, GoalSnapshot>();
  for (const goal of initialSnapshot.goals ?? []) {
    uiGoalsBySession.set(goal.sessionId, { ...goal.goal });
  }
  const uiTodosBySession = new Map<string, UiSessionTodoList>();
  const todoProjectionScopesBySession = new Map<
    string,
    TodoWorkScopeId | undefined
  >();
  for (const todoList of initialSnapshot.todos ?? []) {
    uiTodosBySession.set(todoList.sessionId, cloneTodoList(todoList));
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
  const promptQueueOwnerClientId =
    options.promptQueueOwnerClientId ?? `inprocess_${randomUUID()}`;
  const sessionExecution = new SessionExecutionGate();
  const activePromptsBySession = new Map<string, ActivePromptState>();
  const compactingSessions = new Set<string>();
  const pendingRuntimePromptsBySession = new Map<string, number>();
  const acceptedNewSessionIds = new Set<string>();
  // Multiple submits may admit together, while New takes a short exclusive
  // window through its authoritative empty check and candidate decision.
  let admissionReaders = 0;
  let admissionWriter = false;
  const admissionQueue: {
    readonly kind: "read" | "write";
    readonly grant: (release: () => void) => void;
  }[] = [];
  function drainAdmissionQueue(): void {
    if (admissionWriter) return;
    if (admissionQueue[0]?.kind === "write") {
      if (admissionReaders > 0) return;
      const next = admissionQueue.shift();
      if (!next) return;
      admissionWriter = true;
      next.grant(() => {
        admissionWriter = false;
        drainAdmissionQueue();
      });
      return;
    }
    const firstWriter = admissionQueue.findIndex(
      (item) => item.kind === "write",
    );
    const readCount = firstWriter === -1 ? admissionQueue.length : firstWriter;
    for (const next of admissionQueue.splice(0, readCount)) {
      admissionReaders += 1;
      next.grant(() => {
        admissionReaders -= 1;
        drainAdmissionQueue();
      });
    }
  }
  function withSessionAdmission<T>(
    kind: "read" | "write",
    operation: () => Promise<T>,
  ): Promise<T> {
    // Enqueue synchronously, before either operation reaches its first await.
    const admission = new Promise<() => void>((grant) => {
      admissionQueue.push({ kind, grant });
      drainAdmissionQueue();
    });
    return admission.then(async (release) => {
      try {
        return await operation();
      } finally {
        release();
      }
    });
  }
  let implicitAdmissionSessionId: string | undefined;
  const promptIdleWaiters = new Map<string, Set<() => void>>();
  const promptRunReadyWaiters = new Map<string, Set<() => void>>();
  let configSaveQueue: Promise<void> = Promise.resolve();
  let skillRegistryPromise: Promise<SkillRegistry> | undefined;

  const sessionMetadataById = new Map(
    initialSnapshot.sessions.map((session) => [session.id, session]),
  );
  eventRouter.addSubscriptions(
    bus.subscribe(SessionEvent.Created, ({ session }) => {
      sessionMetadataById.set(session.id, sessionMetadataToUiSession(session));
    }),
    bus.subscribe(SessionEvent.Updated, ({ session }) => {
      sessionMetadataById.set(session.id, sessionMetadataToUiSession(session));
    }),
  );
  const sessionSubviewFailures = new Map<
    string,
    { goal?: string; todo?: string; steerRecovery?: string }
  >();
  const subagentInstanceStore =
    options.subagentInstanceStore ?? new InMemorySubagentInstanceStore();
  const subagentExecutionStore =
    options.subagentExecutionStore ?? new InMemorySubagentExecutionStore();
  const sourceLedger =
    options.runLedger ?? stateStore.runLedger ?? createInMemoryRunLedger();
  function projectRunRecord(
    record: import("../runtime/run-ledger/index.js").RunLedgerRecord,
  ): Promise<UiRun> {
    return Promise.resolve(runToUiRun(record));
  }
  async function unconsumedSteers(
    sessionId: string,
  ): Promise<readonly import("ohbaby-sdk").UiUnconsumedSteer[] | undefined> {
    try {
      const inputs = currentRunInputStore
        ? await projectUnconsumedSteers({
            sessionId,
            scopeKey: promptScopeKey,
            inputs: currentRunInputStore,
            prompts: promptSubmissionStore,
            runs: sourceLedger,
            messages: messageManager,
            assertRecoveryReady: () =>
              options.assertExecutionRecoveryReady?.(sessionId),
          })
        : [];
      const failures = sessionSubviewFailures.get(sessionId);
      if (failures) delete failures.steerRecovery;
      return inputs;
    } catch (error) {
      // A failed recovery field must not hide readable history or other sessions.
      sessionSubviewFailures.set(sessionId, {
        ...sessionSubviewFailures.get(sessionId),
        steerRecovery: getErrorMessage(error),
      });
      return undefined;
    }
  }
  function executionRecoveryFor(
    sessionId: string,
    state = promptScheduler.getRecoveryState(sessionId),
  ): NonNullable<UiSessionView["executionRecovery"]> {
    const failure = sessionSubviewFailures.get(sessionId)?.steerRecovery;
    return state.status === "ready" && failure !== undefined
      ? { status: "blocked", message: failure }
      : state;
  }
  const sourceProjection: SourceSessionProjection = new SourceSessionProjection(
    {
      runtimeEpoch: permissionProjection.permissionEpoch,
      messageManager,
      metadata: async (sessionId): Promise<Omit<UiSession, "messages">> => {
        const core = await options.sessionManager?.get(sessionId);
        const session = core
          ? sessionMetadataToUiSession(core)
          : (sessionMetadataById.get(sessionId) ??
            (await stateStore.getSessionIndex()).find(
              (session) => session.id === sessionId,
            ));
        if (!session)
          throw new Error(`Session metadata unavailable: ${sessionId}`);
        return {
          ...session,
          unconsumedSteers: await unconsumedSteers(sessionId),
        };
      },
      runs: async (sessionId): Promise<readonly UiRun[]> => {
        const stored = await Promise.all(
          (await sourceLedger.listBySession(sessionId, { limit: 50 }))
            .filter((run) => run.contextScopeId === undefined)
            .map(projectRunRecord),
        );
        return stored.length
          ? stored
          : initialSnapshot.runs.filter((run) => run.sessionId === sessionId);
      },
      prompts: async (
        sessionId,
        messages,
        runs,
      ): Promise<readonly UiPromptSubmission[]> =>
        (
          await promptScheduler.listForSession(sessionId, {
            messageIds: messages.map((message) => message.id),
            runIds: [
              ...new Set([
                ...runs.map((run) => run.id),
                ...messages.flatMap((message) =>
                  message.runId ? [message.runId] : [],
                ),
              ]),
            ],
          })
        ).map(promptRecordToUi),
      publish: (event): void => {
        eventRouter.publishRecovery(event);
      },
      subviews: (
        sessionId,
      ): Partial<
        Pick<UiSessionView, "goal" | "todo" | "context" | "executionRecovery">
      > => {
        const goal = sharedGoalService.peekSnapshot(sessionId);
        const todo = uiTodosBySession.get(sessionId);
        const context = contextWindowUsage.get(sessionId);
        const failures = sessionSubviewFailures.get(sessionId);
        return {
          executionRecovery: executionRecoveryFor(sessionId),
          ...(goal === undefined
            ? {}
            : {
                goal: {
                  status: "ready" as const,
                  value: goal === null ? null : goalSnapshotToUiGoal(goal),
                },
              }),
          ...(todo === undefined
            ? {}
            : {
                todo: { status: "ready" as const, value: cloneTodoList(todo) },
              }),
          ...(context === null
            ? {}
            : { context: { status: "ready" as const, value: context } }),
          ...(failures?.goal === undefined
            ? {}
            : {
                goal: { status: "unavailable" as const, reason: failures.goal },
              }),
          ...(failures?.todo === undefined
            ? {}
            : {
                todo: { status: "unavailable" as const, reason: failures.todo },
              }),
        };
      },
    },
  );
  const subagentConversations = new SubagentConversationProjection({
    runtimeEpoch: permissionProjection.permissionEpoch,
    source: sourceProjection,
    messages: messageManager,
    executions: subagentExecutionStore,
    instances: subagentInstanceStore,
    validateRoot: async (id): Promise<void> => {
      await validatePermissionRoot(id);
    },
    runs: async (sessionId, scopeId): Promise<readonly UiRun[]> =>
      (await sourceLedger.listBySession(sessionId, { limit: 50 }))
        .filter(
          (run) => scopeId !== undefined && run.contextScopeId === scopeId,
        )
        .map(runToUiRun),
    publish: (event): void => {
      eventRouter.publishRecovery(event);
    },
  });
  const coordinatedRunLedger = createCoordinatedRunLedger({
    ledger: sourceLedger,
    coordinator: {
      run: (sessionId, operation) =>
        sourceProjection.owner.run(sessionId, operation),
      onCommitted: (record) => {
        if (record.contextScopeId === undefined)
          void projectRunRecord(record)
            .then(async (run) => {
              await sourceProjection.commitEvent({ type: "run.updated", run });
              refreshSteerRecovery(record.sessionId);
            })
            .catch((error: unknown) => {
              sourceProjection.owner.markUnavailable(record.sessionId, error);
            });
        else sourceProjection.commitScopeRun(runToUiRun(record));
      },
      onProjectionError: (sessionId, error): void => {
        sourceProjection.owner.markUnavailable(sessionId, error);
      },
    },
  });
  const sessionInitializationById = new Map<string, Promise<void>>();
  const sessionEntries = new Map<string, Promise<void>>();
  const sharedGoalService: GoalService = new GoalService({
    persistence: goalPersistence,
    now: (): number => now().getTime(),
    executionControl: { interruptGoalExecution },
    withSessionMutation: (sessionId, operation) =>
      sourceProjection.owner.runControl(sessionId, operation),
    resolveMutationContext(
      sessionId,
      runId,
    ): import("../goals/types.js").GoalMutationContext {
      const active = activePromptsBySession.get(sessionId);
      if (active?.runId !== runId) return { kind: "invalid" };
      if (active.owner === "user") return { kind: "user" };
      const ticket = sharedGoalService.getTicketForRun(sessionId, runId);
      return ticket ? { kind: "goal", ticket } : { kind: "invalid" };
    },
    onChange(event): void {
      publishGoalUpdated(event.sessionId, event.snapshot);
      sessionExecution.notify(event.sessionId);
      if (event.change.kind === "progress") return;
      const status = event.snapshot?.status;
      publishNotice({
        level: "info",
        source: "goals",
        title: "Goal",
        message:
          event.change.kind === "completion"
            ? "Goal completed."
            : event.snapshot === null
              ? "Goal cleared."
              : `Goal ${status ?? "updated"}${event.snapshot.pauseReason ? `: ${event.snapshot.pauseReason}` : ""}`,
      });
    },
    onError({ error, sessionId }): void {
      publishNotice({
        key: `goal:execution:${sessionId}:${getErrorMessage(error)}`,
        level: "error",
        message: getErrorMessage(error),
        source: "goals",
        title: "Goal execution control failed",
      });
    },
  });

  function initializeSessionView(
    sessionId: string,
    metadata?: UiSession,
  ): Promise<void> {
    if (metadata) sessionMetadataById.set(sessionId, metadata);
    const existing = sessionInitializationById.get(sessionId);
    if (existing) return existing;
    const initialization = (async (): Promise<void> => {
      await sourceProjection.owner.initialize(sessionId);
      let goal: import("ohbaby-sdk").UiSessionView["goal"];
      let goalFailure: unknown;
      let goalFailed = false;
      try {
        await sharedGoalService.initSession(sessionId);
        setGoalProjection(
          sessionId,
          sharedGoalService.peekSnapshot(sessionId) ?? null,
        );
        goal = {
          status: "ready",
          value: uiGoalsBySession.get(sessionId) ?? null,
        };
      } catch (error) {
        goalFailed = true;
        goalFailure = error;
        goal = { status: "unavailable", reason: getErrorMessage(error) };
        sessionSubviewFailures.set(sessionId, {
          ...sessionSubviewFailures.get(sessionId),
          goal: goal.reason,
        });
      }
      let todo: import("ohbaby-sdk").UiSessionView["todo"];
      try {
        await syncTodoProjectionsFromSource([{ id: sessionId }]);
        todo = {
          status: "ready",
          value: uiTodosBySession.get(sessionId) ?? null,
        };
      } catch (error) {
        todo = { status: "unavailable", reason: getErrorMessage(error) };
        sessionSubviewFailures.set(sessionId, {
          ...sessionSubviewFailures.get(sessionId),
          todo: todo.reason,
        });
      }
      await sourceProjection.owner.run(sessionId, () => {
        try {
          sourceProjection.owner.commit(sessionId, { goal, todo });
        } catch (error) {
          // Execution startup depends on seed and goal recovery, not chat health.
          sourceProjection.owner.markUnavailable(sessionId, error);
        }
        return Promise.resolve();
      });
      // Goal recovery controls execution safety; only display subviews are independent.
      if (goalFailed)
        throw goalFailure instanceof Error
          ? goalFailure
          : new Error(getErrorMessage(goalFailure));
      const steerFailure = sessionSubviewFailures.get(sessionId)?.steerRecovery;
      if (steerFailure !== undefined) throw new Error(steerFailure);
    })().catch((error: unknown) => {
      sessionInitializationById.delete(sessionId);
      throw error;
    });
    sessionInitializationById.set(sessionId, initialization);
    return initialization;
  }

  // Entry joins live recovery and seeding outside the owner queue: recovery
  // callbacks themselves need that queue to commit their result.
  function enterSession(
    sessionId: string,
    waitForStartup = false,
  ): Promise<void> {
    const existing = sessionEntries.get(sessionId);
    if (existing) return existing;
    const entry = Promise.resolve()
      .then(async () => {
        if (waitForStartup) {
          await ready;
          await validatePermissionRoot(sessionId);
        }
        try {
          await promptScheduler.recoverSession(sessionId);
          await initializeSessionView(sessionId);
        } catch (error) {
          // Execution can be blocked while history remains readable. A read-only
          // seed must not retry durable recovery or replace its original error.
          await sourceProjection.owner
            .initialize(sessionId)
            .catch(() => undefined);
          await sourceProjection.owner.runControl(sessionId, () =>
            Promise.resolve(),
          );
          throw error;
        }
      })
      .finally(() => {
        if (sessionEntries.get(sessionId) === entry)
          sessionEntries.delete(sessionId);
      });
    sessionEntries.set(sessionId, entry);
    return entry;
  }

  let appliedMcpVersion: string | undefined;
  let skillDirectoriesSignature: string | undefined;

  const runtimeController = new InProcessRuntimeController({
    clearPendingPermissionsForRun,
    getConfigVersion: async (): Promise<SettingsConfigVersions> =>
      settingsConfigVersion(await resolveProjectRoot()),
    coordinateAdmission: <T>(work: () => Promise<T>): Promise<T> =>
      coordinateModelConfig(undefined, work),
    onRuntimeReplaced: (): void => {
      contextWindowUsage.clear();
    },
    prepareRuntime: async (changedDomains): Promise<void> => {
      if (
        changedDomains === undefined ||
        changedDomains.some((domain) => domain === "search" || domain === "env")
      ) {
        try {
          await reloadSearchConfig();
        } catch (error) {
          // Search remains optional; a missing key must not prevent chat admission.
          if (
            !(error instanceof SearchConfigError) ||
            !["MISSING_API_KEY", "EMPTY_API_KEY"].includes(error.code)
          )
            throw error;
        }
      }
    },
    createRuntime: async (changedDomains): Promise<UiRuntimeComposition> => {
      const baseProjectRoot = await resolveProjectRoot();
      const mcpVersion = (await settingsConfigVersion(baseProjectRoot)).mcp;
      if (
        changedDomains?.includes("mcp") ||
        (appliedMcpVersion !== undefined && appliedMcpVersion !== mcpVersion)
      )
        await McpManager.getInstance(baseProjectRoot).reload();
      const skillRegistryWasLoaded = skillRegistryPromise !== undefined;
      const skillRegistry = await getSkillRegistry();
      if (
        changedDomains?.includes("skills") ||
        (changedDomains === undefined && skillRegistryWasLoaded)
      ) {
        const directories = await loadConfiguredSkillDirectories({
          projectDirectory: baseProjectRoot,
          onNotice: publishNotice,
        });
        await skillRegistry.reload(directories);
        skillDirectoriesSignature = JSON.stringify(directories);
      }
      const runtimeRunIdFactory =
        options.createRunId ??
        (usesPersistentStateStore() ? undefined : (): string => runIds.next());

      const runtime: UiRuntimeComposition = await createUiRuntimeComposition({
        logger: options.logger,
        agentManager: options.agentManager,
        bus,
        ...(options.createSubagentId
          ? { createSubagentId: options.createSubagentId }
          : {}),
        ...(runtimeRunIdFactory === undefined
          ? {}
          : { createRunId: runtimeRunIdFactory }),
        goalPersistence,
        goalService: sharedGoalService,
        displayReasoning: sourceProjection.reasoning,
        goalExecutionControl: { interruptGoalExecution },
        resolveRunModel,
        messageManager,
        hookExecutor: options.hookExecutor,
        now: () => now().getTime(),
        onStepUsage({ isSubagent, sessionId, tokenUsage }): void {
          if (
            !acceptsPromptCacheUsage ||
            isSubagent === true ||
            retiredPromptCacheSessionIds.has(sessionId)
          ) {
            return;
          }
          const runModel = runtime.runManager.getActiveRunModel(sessionId);
          if (runModel && matchesSelectedModel(sessionId, runModel))
            promptCacheUsage.record(sessionId, tokenUsage);
        },
        onGoalChange: (event) => {
          publishGoalUpdated(event.sessionId, event.snapshot);
        },
        onTodoWrite: publishTodoWrite,
        onNotice: publishNotice,
        permissionManager: permission,
        permissionState,
        currentRunInputStore,
        runLedger: coordinatedRunLedger,
        sandboxManager: options.sandboxManager,
        sessionManager: options.sessionManager,
        skillRegistry,
        streamBridge: options.streamBridge,
        subagentInstanceStore,
        subagentExecutionStore,
        subagentOwnerId: options.subagentOwnerId,
        subagentOwnerPid: options.subagentOwnerPid,
        workdir: baseProjectRoot,
      });
      appliedMcpVersion = mcpVersion;
      runtime.goals.attachTurnRunner({
        runTurn: runGoalTurn,
        finishTurn: finishGoalTurn,
      });
      return runtime;
    },
    publishNotice,
    updateStatus,
  });
  const promptSubmissionStore =
    options.promptSubmissionStore ?? new InMemoryPromptSubmissionStore();
  const currentRunInputStore =
    options.currentRunInputStore ??
    (promptSubmissionStore instanceof InMemoryPromptSubmissionStore &&
    sourceLedger.runtimeInputMemory &&
    messageManager.runtimeInputMemory
      ? new InMemoryCurrentRunInputStore({
          runLedger: sourceLedger,
          promptStore: promptSubmissionStore,
          messageManager,
          now: (): number => now().getTime(),
        })
      : undefined);
  currentRunInputStore?.setMessageCommitObserver((message): void => {
    // Queue after any scheduler owner lane; never await that lane recursively.
    void sourceProjection.owner
      .run(message.info.sessionId, () => {
        sourceProjection.acceptRuntimeInput(message);
        return Promise.resolve();
      })
      .catch((error: unknown) => {
        sourceProjection.owner.markUnavailable(message.info.sessionId, error);
      });
  });
  // Refresh after the committing owner entry; rebuild itself joins that queue.
  const steerRecoveryRefreshes = new Map<string, Promise<void>>();
  function refreshSteerRecovery(sessionId: string): void {
    if (disposed || !sourceProjection.owner.hasViewOrPendingSeed(sessionId))
      return;
    const previous = steerRecoveryRefreshes.get(sessionId) ?? Promise.resolve();
    const refresh = previous
      .catch(() => undefined)
      .then(async () => {
        const changed = await sourceProjection.owner.runControl(
          sessionId,
          async () => {
            const next = await unconsumedSteers(sessionId);
            const current = sourceProjection.owner.read(sessionId);
            return (
              JSON.stringify(current.session.unconsumedSteers) !==
                JSON.stringify(next) ||
              JSON.stringify(current.executionRecovery) !==
                JSON.stringify(executionRecoveryFor(sessionId))
            );
          },
        );
        if (!changed || disposed) return;
        await sourceProjection.owner.rebuild(sessionId);
        publish({
          type: "session.updated",
          session: cloneSession(sourceProjection.owner.read(sessionId).session),
        });
      })
      .catch((error: unknown) => {
        if (!disposed) sourceProjection.owner.markUnavailable(sessionId, error);
      })
      .finally(() => {
        if (steerRecoveryRefreshes.get(sessionId) === refresh)
          steerRecoveryRefreshes.delete(sessionId);
      });
    steerRecoveryRefreshes.set(sessionId, refresh);
  }
  currentRunInputStore?.setStateChangeObserver(refreshSteerRecovery);
  const promptScopeKey =
    options.promptScopeKey ??
    options.workdir ??
    options.projectDirectory ??
    process.cwd();
  function getActiveGoalRunForSteer(
    sessionId: string,
  ): { runId: string; goalId: string } | undefined {
    const active = activePromptsBySession.get(sessionId);
    if (disposed || active?.owner !== "goal" || active.runId === undefined)
      return undefined;
    const ticket = sharedGoalService.getTicketForRun(sessionId, active.runId);
    if (
      !ticket ||
      !sharedGoalService.isExecutionCurrent(
        sessionId,
        ticket.goalId,
        ticket.executionEpoch,
      ) ||
      !currentRunInputStore?.isAcceptingSteer(active.runId)
    )
      return undefined;
    return { runId: active.runId, goalId: ticket.goalId };
  }
  const promptScheduler: WorkspacePromptScheduler =
    new WorkspacePromptScheduler({
      executionGate: sessionExecution,
      currentRunInputs: currentRunInputStore,
      resolveSteerTarget: getActiveGoalRunForSteer,
      now: () => now().getTime(),
      isExecutionPersistenceError: (error) =>
        error instanceof RunFinalizationError,
      async withFinalizationWriteBudget(runId, operation) {
        const runtime = await (runtimeController.getRuntimeIfStarted() ??
          closingRuntime);
        return runtime
          ? runtime.runManager.withFinalizationWriteBudget(runId, operation)
          : operation();
      },
      async recoverExecution(_prompt, error, runId) {
        const targetRunId =
          error instanceof RunFinalizationError ? error.runId : runId;
        if (!targetRunId) throw error;
        const runtime = await (runtimeController.getRuntimeIfStarted() ??
          closingRuntime);
        if (!runtime) throw error;
        const completion =
          await runtime.runManager.retryFinalization(targetRunId);
        await reconcileRuntimeStatus();
        return {
          ...runCompletionToPromptExecutionResult(completion),
          endedAt: runtime.runManager.get(targetRunId)?.endedAt,
        };
      },
      onRecoveryChanged(sessionId, state): void {
        const recovery = executionRecoveryFor(sessionId, state);
        sessionExecution.notify(sessionId);
        if (sourceProjection.owner.hasViewOrPendingSeed(sessionId))
          void sourceProjection.owner
            .runControl(sessionId, async () => {
              await sourceProjection.owner.ready(sessionId);
              const previous =
                sourceProjection.owner.read(sessionId).executionRecovery;
              if (JSON.stringify(previous) !== JSON.stringify(recovery))
                sourceProjection.owner.commit(sessionId, {
                  executionRecovery: recovery,
                });
            })
            .catch(() => undefined);
        if (state.status === "blocked")
          publishNotice({
            key: `execution:recovery:${sessionId}`,
            level: "error",
            title: "Execution record could not be saved",
            message: state.message,
          });
      },
      async beforeExecution(sessionId): Promise<void> {
        const changed = await options.recoverExecutionSession?.(sessionId);
        if (sourceProjection.owner.hasViewOrPendingSeed(sessionId)) {
          await sourceProjection.owner.ready(sessionId).catch(() => undefined);
          let rebuild =
            changed === true ||
            sessionSubviewFailures.get(sessionId)?.steerRecovery !== undefined;
          try {
            sourceProjection.owner.read(sessionId);
          } catch {
            rebuild = true;
          }
          if (rebuild) await sourceProjection.owner.rebuild(sessionId);
        }
        const steerFailure =
          sessionSubviewFailures.get(sessionId)?.steerRecovery;
        if (steerFailure !== undefined) throw new Error(steerFailure);
      },
      beforeSessionWrite: initializeSessionView,
      commitCoordinator: {
        runControl: (sessionId, operation) =>
          sourceProjection.owner.runControl(sessionId, operation),
        run: (sessionId, operation) =>
          sourceProjection.owner.run(sessionId, operation),
      },
      onProjectionError: (error, prompt): void => {
        sourceProjection.owner.markUnavailable(prompt.sessionId, error);
      },
      scopeKey: promptScopeKey,
      store: promptSubmissionStore,
      isBusyError: (error): boolean =>
        error instanceof SessionRunBusyError ||
        error instanceof RuntimeSwitchPendingError,
      onSubmitted(prompt): void {
        sessionExecution.notify(prompt.sessionId);
        if (prompt.resendOfPromptId) refreshSteerRecovery(prompt.sessionId);
        publish({
          type: "prompt.submitted",
          prompt: promptRecordToUi(prompt),
          timestamp: Date.now(),
        });
      },
      onUpdated(prompt): void {
        sessionExecution.notify(prompt.sessionId);
        if (prompt.resendOfPromptId) refreshSteerRecovery(prompt.sessionId);
        publish({
          type: "prompt.updated",
          prompt: promptRecordToUi(prompt),
          timestamp: Date.now(),
        });
      },
      async execute(prompt, controls): Promise<PromptExecutionResult> {
        let executedRunId: string | undefined;
        const completion = await submitPromptInternal(prompt.text, {
          owner: "user",
          signal: controls.signal,
          sessionId: prompt.sessionId,
          reservedUserMessageId: prompt.userMessageId,
          reasoning: prompt.reasoning,
          modelEntryId: prompt.modelEntryId,
          hasModelSnapshot: true,
          namingSource: prompt.namingSource,
          expectedTemporaryTitle: prompt.titleExpected,
          onRunStarted: (runId) => {
            executedRunId = runId;
            return controls.markRunning(runId);
          },
        });
        const run = executedRunId
          ? await sourceLedger.get(executedRunId)
          : undefined;
        return {
          ...runCompletionToPromptExecutionResult(completion),
          endedAt: run?.endedAt,
        };
      },
    });

  async function runGoalTurn(
    sessionId: string,
    goalId: string,
    epoch: number,
  ): Promise<GoalTurnOutcome> {
    // A moved session continues in its target workspace. Ending this
    // generation keeps the persisted goal; the target resumes it.
    if ((await movedSessionTarget(sessionId)) !== undefined)
      return { status: "not_admitted" };
    await sharedGoalService.initSession(sessionId);
    let ticket: GoalTurnTicket | null = null;
    for (;;) {
      let wake!: () => void;
      const changed = new Promise<void>((resolve) => {
        wake = resolve;
      });
      const unsubscribe = sessionExecution.subscribe(sessionId, wake);
      try {
        ticket = await sourceProjection.owner.runControl(
          sessionId,
          async () => {
            if (
              disposed ||
              !sharedGoalService.isExecutionCurrent(sessionId, goalId, epoch)
            )
              return null;
            const queued =
              await promptSubmissionStore.listQueued(promptScopeKey);
            const available =
              !sessionExecution.isHeld(sessionId) &&
              promptScheduler.getRecoveryState(sessionId).status === "ready" &&
              !queued.some((prompt) => prompt.sessionId === sessionId);
            const admitted = await sharedGoalService.admitTurnInBoundary(
              sessionId,
              goalId,
              epoch,
              available,
            );
            if (
              admitted &&
              !sessionExecution.reserve(sessionId, admitted.token)
            )
              throw new Error(
                "Goal execution reservation changed inside admission",
              );
            return admitted;
          },
        );
        if (ticket) break;
        if (
          disposed ||
          !sharedGoalService.isExecutionCurrent(sessionId, goalId, epoch)
        )
          return { status: "not_admitted" };
        await changed;
      } finally {
        unsubscribe();
      }
    }
    const admitted = ticket;
    const release = (): void => {
      sessionExecution.release(admitted.token);
    };
    try {
      const completion = await submitPromptInternal(admitted.modelText, {
        goalId,
        goalTicket: admitted,
        displayText: admitted.displayText,
        signal: admitted.controller.signal,
        owner: "goal",
        sessionId,
      });
      return {
        ...goalOutcomeFromRunCompletion(completion),
        ticket: admitted,
        release,
      };
    } catch (error) {
      if (error instanceof RunFinalizationError) {
        // One recovery slot owns runtime finalization, usage and complete clear.
        // Keep the final completion after the first stage succeeds.
        let recovered: GoalTurnOutcome | undefined;
        admitted.recoveryPending = true;
        promptScheduler.blockExecutionFinalization(
          sessionId,
          error,
          async () => {
            if (!recovered) {
              const runtime = await (runtimeController.getRuntimeIfStarted() ??
                closingRuntime);
              if (!runtime) throw error;
              recovered = goalOutcomeFromRunCompletion(
                await runtime.runManager.retryFinalization(error.runId),
              );
              await reconcileRuntimeStatus();
            }
            await sharedGoalService.settleTurn(sessionId, admitted, recovered);
          },
        );
        release();
        throw error;
      }
      return {
        status: admitted.controller.signal.aborted ? "cancelled" : "failed",
        error: getErrorMessage(error),
        ticket: admitted,
        release,
      };
    }
  }

  async function finishGoalTurn(
    sessionId: string,
    ticket: GoalTurnTicket,
    outcome: GoalTurnOutcome,
  ): Promise<void> {
    if (ticket.recoveryPending) return;
    try {
      await sharedGoalService.settleTurn(sessionId, ticket, outcome);
    } catch (error) {
      ticket.recoveryPending = true;
      promptScheduler.blockExecutionFinalization(
        sessionId,
        error instanceof Error ? error : new Error(String(error)),
        () => sharedGoalService.settleTurn(sessionId, ticket, outcome),
      );
      throw error;
    }
  }

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

  async function resolveSubmissionSession(
    text: string,
    submitOptions?: SubmitPromptOptions,
  ): Promise<string> {
    assertStateStoreWritable();
    if (submitOptions?.modelEntryId)
      await assertModelEntrySelectable(submitOptions.modelEntryId);
    await assertCanUseAsPrimarySession(submitOptions?.sessionId);
    await reserveIdsFromState();
    const createdAt = timestamp();
    const baseProjectRoot = await resolveProjectRoot();
    const temporaryTitle = createTemporarySessionTitle(
      sessionTitleIntent(text, submitOptions?.namingSource),
    );
    const snapshot = await stateStore.readSnapshot();
    const agentName = options.agentManager?.getDefault() ?? "build";
    const resolved = await resolveSessionForNewPrompt({
      createSession: async (id) => {
        if (options.sessionManager) {
          const created = await options.sessionManager.create(baseProjectRoot, {
            agentName,
            id,
            title: temporaryTitle,
          });
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
    await initializeSessionView(resolved.session.id, resolved.session);
    const isFirstPrompt =
      resolved.isNewSession ||
      ((submitOptions?.reasoning !== undefined ||
        submitOptions?.modelEntryId !== undefined) &&
        resolved.session.messages.length === 0 &&
        !(await promptSubmissionStore.hasForSession(
          promptScopeKey,
          resolved.session.id,
        )) &&
        (resolved.coreSession?.stats.messageCount ?? 0) === 0 &&
        (await messageManager.listBySession(resolved.session.id)).length === 0);
    if (
      resolved.isNewSession ||
      (isFirstPrompt &&
        (submitOptions?.reasoning || submitOptions?.modelEntryId))
    ) {
      let session = resolved.session;
      if (submitOptions?.reasoning || submitOptions?.modelEntryId) {
        const reasoning =
          submitOptions.reasoning &&
          (resolved.isNewSession ||
            (resolved.session.reasoning === undefined &&
              resolved.coreSession?.reasoning === undefined))
            ? { ...submitOptions.reasoning }
            : undefined;
        const modelEntryId = submitOptions.modelEntryId;
        if (modelEntryId) await assertModelEntrySelectable(modelEntryId);
        const updated = await options.sessionManager?.update(session.id, {
          ...(reasoning ? { reasoning } : {}),
          ...(modelEntryId ? { modelEntryId } : {}),
        });
        session = updated
          ? sessionMetadataToUiSession(updated)
          : {
              ...session,
              ...(reasoning ? { reasoning } : {}),
              ...(modelEntryId ? { modelEntryId } : {}),
            };
      }
      if (resolved.isNewSession) {
        sessionIds.reserve(session.id);
        acceptedNewSessionIds.add(session.id);
      }
      await upsertSession(session);
      publish({
        type: "session.updated",
        session: cloneSession(session),
      });
    }
    await stateStore.setActiveSessionId(resolved.session.id);
    return resolved.session.id;
  }

  function submitPromptAcceptedInternal(
    text: string,
    submitOptions?: SubmitPromptOptions,
  ): Promise<UiPromptReceipt> {
    return withSessionAdmission("read", () =>
      submitPromptAcceptedWork(text, submitOptions),
    );
  }

  async function submitPromptAcceptedWork(
    text: string,
    submitOptions?: SubmitPromptOptions,
    resendOfPromptId?: string,
  ): Promise<UiPromptReceipt> {
    await ready;
    if (
      !submitOptions?.sessionId &&
      implicitAdmissionSessionId &&
      !(await promptScheduler.hasPendingSession(implicitAdmissionSessionId))
    ) {
      implicitAdmissionSessionId = undefined;
    }
    try {
      validateReasoningConfig(submitOptions?.reasoning);
    } catch (error) {
      throw new PromptSubmissionRejectedError(error);
    }
    let submissionSession: Promise<UiSession> | undefined;
    const snapshotSession = (sessionId: string): Promise<UiSession> =>
      (submissionSession ??= requireOwnedSession(sessionId));
    const { record: accepted, steer } = await promptScheduler.accept({
      resendOfPromptId,
      reasoning:
        submitOptions?.reasoning ??
        (async (sessionId) => {
          const session = await snapshotSession(sessionId);
          if (!session.reasoning) return undefined;
          const selected = submitOptions?.modelEntryId ?? session.modelEntryId;
          const { config } = await modelClients.read(
            await resolveProjectRoot(),
            selected,
          );
          return filterReasoningPreference(
            sessionId,
            session.reasoning,
            config,
          );
        }),
      modelEntryId:
        submitOptions?.modelEntryId ??
        (async (sessionId) => (await snapshotSession(sessionId)).modelEntryId),
      namingSource: submitOptions?.namingSource,
      titleExpected: (sessionId) =>
        acceptedNewSessionIds.has(sessionId)
          ? createTemporarySessionTitle(
              sessionTitleIntent(text, submitOptions?.namingSource),
            )
          : undefined,
      clientRequestId: submitOptions?.clientRequestId,
      expectedSessionId: submitOptions?.sessionId,
      sessionId:
        submitOptions?.sessionId !== undefined
          ? async (): Promise<string> =>
              resolveSubmissionSession(text, submitOptions)
          : (implicitAdmissionSessionId ??
            (async (): Promise<string> => {
              const sessionId = await resolveSubmissionSession(
                text,
                submitOptions,
              );
              implicitAdmissionSessionId = sessionId;
              return sessionId;
            })),
      text,
      userMessageId: options.createPromptUserMessageId?.() ?? messageIds.next(),
    });
    acceptedNewSessionIds.delete(accepted.sessionId);
    return {
      promptId: accepted.promptId,
      clientRequestId: accepted.clientRequestId,
      userMessageId: accepted.userMessageId,
      sessionId: accepted.sessionId,
      status: accepted.status,
      createdAt: new Date(accepted.createdAt).toISOString(),
      steer:
        steer.status === "error"
          ? { ...steer, error: { ...steer.error, source: "scheduler" } }
          : steer,
    };
  }

  async function waitForPromptInternal(
    promptId: string,
    waitOptions?: UiWaitForPromptOptions,
  ): Promise<UiPromptCompletion> {
    return {
      prompt: promptRecordToCompletion(
        await promptScheduler.waitForCompletion(promptId, waitOptions),
      ),
    };
  }

  function submitPromptAndWaitInternal(
    text: string,
    submitOptions?: UiSubmitPromptAndWaitOptions,
  ): Promise<UiPromptCompletion> {
    return composeSubmitPromptAndWait(
      {
        submitPromptAccepted: submitPromptAcceptedInternal,
        waitForPrompt: waitForPromptInternal,
      },
      text,
      submitOptions,
    );
  }

  function publish(event: UiEvent): void {
    if (event.type === "session.updated") {
      // Metadata-only producers preserve the durable recovery projection.
      if (event.session.unconsumedSteers === undefined) {
        try {
          event = {
            ...event,
            session: {
              ...event.session,
              unconsumedSteers: sourceProjection.owner.read(event.session.id)
                .session.unconsumedSteers,
            },
          };
        } catch {
          /* An unseeded session has no recovery projection yet. */
        }
      }
      sessionMetadataById.set(event.session.id, event.session);
    }
    try {
      if (event.type !== "run.updated")
        void sourceProjection.commitEvent(event);
    } catch (error) {
      const sessionId =
        "sessionId" in event
          ? event.sessionId
          : event.type === "run.updated"
            ? event.run.sessionId
            : event.type === "prompt.submitted" ||
                event.type === "prompt.updated"
              ? event.prompt.sessionId
              : undefined;
      if (typeof sessionId === "string")
        sourceProjection.owner.markUnavailable(sessionId, error);
    }
    eventRouter.publish(event);
  }

  function publishNotice(notice: NoticeDraft): void {
    eventRouter.publishNotice(notice);
  }

  function goalSnapshotToUiGoal(snapshot: GoalSnapshot): UiGoal | null {
    if (snapshot.status === "complete") {
      return null;
    }
    return {
      objective: snapshot.objective,
      ...(snapshot.pauseReason === undefined
        ? {}
        : { pauseReason: snapshot.pauseReason }),
      status: snapshot.status,
      turnsUsed: snapshot.turnsUsed,
      wallClockMs: snapshot.wallClockMs,
      ...(snapshot.budget.turnBudget === null
        ? {}
        : { turnBudget: snapshot.budget.turnBudget }),
    };
  }

  function setGoalProjection(
    sessionId: string,
    snapshot: GoalSnapshot | null,
  ): UiGoal | null {
    const failures = sessionSubviewFailures.get(sessionId);
    if (failures) delete failures.goal;
    if (snapshot === null || snapshot.status === "complete") {
      goalSnapshotsBySession.delete(sessionId);
    } else {
      goalSnapshotsBySession.set(sessionId, snapshot);
    }
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

  function cloneTodoList(todoList: UiSessionTodoList): UiSessionTodoList {
    return {
      ...todoList,
      todos: todoList.todos.map((todo) => ({ ...todo })),
    };
  }

  function todoListsEqual(
    left: UiSessionTodoList,
    right: UiSessionTodoList,
  ): boolean {
    return (
      left.sessionId === right.sessionId &&
      left.visible === right.visible &&
      left.todos.length === right.todos.length &&
      left.todos.every(
        (todo, index) =>
          todo.content === right.todos[index]?.content &&
          todo.status === right.todos[index]?.status,
      )
    );
  }

  function setTodoProjection(
    todoList: UiSessionTodoList,
    workScopeId?: TodoWorkScopeId,
  ): {
    readonly changed: boolean;
    readonly todoList: UiSessionTodoList;
  } {
    const failures = sessionSubviewFailures.get(todoList.sessionId);
    if (failures) delete failures.todo;
    const next = cloneTodoList(todoList);
    const previous = uiTodosBySession.get(next.sessionId);
    const changed = previous === undefined || !todoListsEqual(previous, next);
    uiTodosBySession.set(next.sessionId, next);
    todoProjectionScopesBySession.set(next.sessionId, workScopeId);
    return { changed, todoList: cloneTodoList(next) };
  }

  function publishTodoProjection(
    todoList: UiSessionTodoList,
    workScopeId?: TodoWorkScopeId,
  ): void {
    const result = setTodoProjection(todoList, workScopeId);
    if (!result.changed) {
      return;
    }
    publish({
      sessionId: result.todoList.sessionId,
      timestamp: now().getTime(),
      todos: result.todoList.todos,
      type: "todo.updated",
      visible: result.todoList.visible,
    });
  }

  function publishTodoWrite(event: TodoWriteEvent): void {
    if (event.contextScopeId !== undefined) {
      return;
    }
    const activePrompt = activePromptsBySession.get(event.sessionId);
    if (
      activePrompt === undefined ||
      activePrompt.todoWorkScopeId !== event.workScopeId
    ) {
      return;
    }
    if (activePrompt.owner === "goal") {
      const goal = goalSnapshotsBySession.get(event.sessionId);
      if (goal?.status !== "active" || goal.goalId !== activePrompt.goalId) {
        return;
      }
    }
    publishTodoProjection(
      {
        sessionId: event.sessionId,
        todos: event.todos,
        visible: event.todos.length > 0,
      },
      event.workScopeId,
    );
  }

  function snapshotTodosFor(
    sessions: readonly UiSession[],
  ): readonly UiSessionTodoList[] {
    const sessionIds = new Set(sessions.map((session) => session.id));
    return Array.from(uiTodosBySession.values())
      .filter((todoList) => sessionIds.has(todoList.sessionId))
      .map(cloneTodoList);
  }

  async function syncTodoProjectionsFromSource(
    sessions: readonly Pick<UiSession, "id">[],
  ): Promise<void> {
    const runtime = await runtimeController
      .getRuntimeIfStarted()
      ?.catch(() => undefined);
    await Promise.all(
      sessions.map(async (session) => {
        const activePrompt = activePromptsBySession.get(session.id);
        const goal = goalSnapshotsBySession.get(session.id);
        const workScopeId =
          activePrompt !== undefined
            ? activePrompt.todoWorkScopeId
            : goal?.status === "active"
              ? goalTodoWorkScopeId(goal.goalId)
              : undefined;
        let todos: UiSessionTodoList["todos"];
        if (runtime !== undefined) {
          todos = await runtime.todos.read(session.id, undefined, workScopeId);
        } else {
          try {
            todos = recoverTodosFromMessages(
              (
                await messageManager.listPageBySession(session.id, {
                  limit: 50,
                  scope: { contextScopeId: undefined },
                })
              ).messages,
              (message, error) => {
                publishNotice({
                  key: `todo:recovery:${session.id}:${message}`,
                  level: "warning",
                  message:
                    error instanceof Error
                      ? `${message}: ${error.message}`
                      : message,
                  source: "todo",
                  title: "Todo recovery warning",
                });
              },
              workScopeId,
            );
          } catch (error) {
            publishNotice({
              key: `todo:recovery:${session.id}:${getErrorMessage(error)}`,
              level: "warning",
              message: `Todo history could not be loaded: ${getErrorMessage(error)}`,
              source: "todo",
              title: "Todo recovery warning",
            });
            todos = [];
          }
        }
        const current = uiTodosBySession.get(session.id);
        const currentScope = todoProjectionScopesBySession.get(session.id);
        const visible =
          activePrompt !== undefined &&
          current !== undefined &&
          currentScope === workScopeId
            ? current.visible
            : activePrompt !== undefined
              ? workScopeId === undefined
                ? todos.some((todo) => todo.status !== "completed")
                : todos.length > 0
              : workScopeId !== undefined && todos.length > 0;
        setTodoProjection(
          {
            sessionId: session.id,
            todos,
            visible,
          },
          workScopeId,
        );
      }),
    );
  }

  async function showTodoForRun(
    sessionId: string,
    todoService: TodoService,
    workScopeId?: TodoWorkScopeId,
  ): Promise<void> {
    const todos = await todoService.read(sessionId, undefined, workScopeId);
    const visible =
      workScopeId === undefined
        ? todos.some((todo) => todo.status !== "completed")
        : todos.length > 0;
    const previous = uiTodosBySession.get(sessionId);
    if (!visible && previous === undefined && todos.length === 0) {
      setTodoProjection({ sessionId, todos, visible: false }, workScopeId);
      return;
    }
    publishTodoProjection({ sessionId, todos, visible }, workScopeId);
  }

  function hideTodoAfterRun(sessionId: string): void {
    const current = uiTodosBySession.get(sessionId);
    if (!current?.visible) {
      return;
    }
    publishTodoProjection(
      { ...current, visible: false },
      todoProjectionScopesBySession.get(sessionId),
    );
  }

  function shouldKeepTodoVisibleAfterRun(
    activePrompt: ActivePromptState,
  ): boolean {
    if (activePrompt.owner !== "goal" || activePrompt.goalId === undefined) {
      return false;
    }
    const goal = goalSnapshotsBySession.get(activePrompt.sessionId);
    return goal?.status === "active" && goal.goalId === activePrompt.goalId;
  }

  async function refreshTodoProjectionAfterRun(
    sessionId: string,
    runtime: UiRuntimeComposition,
  ): Promise<void> {
    const goal = await runtime.goals.getSnapshot(sessionId);
    setGoalProjection(sessionId, goal);
    const workScopeId =
      goal?.status === "active" ? goalTodoWorkScopeId(goal.goalId) : undefined;
    const todos = await runtime.todos.read(sessionId, undefined, workScopeId);
    publishTodoProjection(
      {
        sessionId,
        todos,
        visible: workScopeId !== undefined && todos.length > 0,
      },
      workScopeId,
    );
  }

  function syncGoalProjectionsFromSource(sessions: readonly UiSession[]): void {
    for (const session of sessions) {
      const snapshot = sharedGoalService.peekSnapshot(session.id);
      if (snapshot !== undefined) setGoalProjection(session.id, snapshot);
    }
  }

  async function publishSessionIndexInvalidation(): Promise<void> {
    const selectedSessionId = await stateStore.getActiveSessionId();
    publish({ type: "session.index.invalidated", selectedSessionId });
  }
  async function publishModelInvalidation(): Promise<void> {
    const affected = contextWindowUsage.list().map((usage) => usage.sessionId);
    publish({ type: "model.invalidated" });
    await Promise.all(
      affected.map(async (sessionId) => {
        try {
          await getContextWindowUsageInternal({ sessionId });
        } catch {
          contextWindowUsage.clearSession(sessionId);
          promptCacheUsage.clearSession(sessionId);
        }
      }),
    );
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

  async function updateActiveRunStatus(
    status: UiRunStatus,
    runId?: string,
  ): Promise<void> {
    runId ??= runtimeController.getActiveRunId();
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

  async function reconcileRuntimeStatus(
    expectedSessionId?: string | null,
  ): Promise<UiRunStatus> {
    const snapshot = await stateStore.readSnapshot();
    const selectedSessionId =
      expectedSessionId === undefined
        ? snapshot.activeSessionId
        : expectedSessionId;
    const activeRunId =
      selectedSessionId === null
        ? undefined
        : runtimeController.getActiveRunId(selectedSessionId);
    const selectedPermission = permissionProjection
      .listRequests()
      .find((request) => request.rootSessionId === selectedSessionId);
    let status: UiRunStatus;
    if (selectedPermission) {
      status = {
        kind: "waiting-for-permission",
        requestId: selectedPermission.id,
      };
    } else if (activeRunId) {
      status = {
        kind: "running",
        runId: activeRunId,
      };
    } else {
      status = { kind: "idle" };
    }

    if (
      activeRunId &&
      (!selectedPermission || selectedPermission.runId === activeRunId)
    ) {
      await updateActiveRunStatus(status, activeRunId);
    }
    const updated = stateStore.updateStatusForActiveSession(
      selectedSessionId,
      () => status,
    );
    if (updated) {
      publish({
        type: "runtime.updated",
        status: updated,
        timestamp: Date.now(),
      });
      return updated;
    }
    return (await stateStore.readSnapshot()).status;
  }

  async function setActiveSessionAndReconcileStatus(
    sessionId: string | null,
  ): Promise<void> {
    await stateStore.setActiveSessionId(sessionId);
    await reconcileRuntimeStatus(sessionId);
  }

  function clearPendingPermissionsForRun(runId: string): Promise<void> {
    permission.revokeByRun(runId, "Run ended");
    return Promise.resolve();
  }

  function currentPermissionState(): UiPermissionState {
    return permissionState.toSnapshot();
  }

  async function readSnapshotWithPermission(): Promise<UiSnapshot> {
    await ready;
    const snapshot = await stateStore.readSnapshot();
    if (snapshot.activeSessionId) {
      await sessionEntries
        .get(snapshot.activeSessionId)
        ?.catch(() => undefined);
      await sessionInitializationById.get(snapshot.activeSessionId);
    }
    const prompts = (await promptScheduler.listVisible()).map(promptRecordToUi);
    // Explicit legacy reads retain their full-history shape; recovery clients use the bounded view.
    const sessions = await Promise.all(
      snapshot.sessions.map(async (session) => {
        const messages = new Map(
          session.messages.map((message) => [message.id, message]),
        );
        for (const record of await messageManager.listBySession(session.id)) {
          if (record.info.contextScopeId !== undefined) continue;
          const projected = messageToUiMessage(record);
          if (projected) messages.set(projected.id, projected);
        }
        try {
          for (const message of sourceProjection.owner.read(session.id).session
            .messages)
            messages.set(message.id, message);
        } catch {
          /* Legacy reads do not initialize or rebuild. */
        }
        const recovery = await unconsumedSteers(session.id);
        if (recovery === undefined) {
          // Keep an already-open view honest without running execution recovery.
          refreshSteerRecovery(session.id);
          await steerRecoveryRefreshes.get(session.id);
        }
        return {
          ...session,
          unconsumedSteers: recovery,
          messages: [...messages.values()].sort((a, b) =>
            a.createdAt < b.createdAt
              ? -1
              : a.createdAt > b.createdAt
                ? 1
                : a.id < b.id
                  ? -1
                  : a.id > b.id
                    ? 1
                    : 0,
          ),
        };
      }),
    );
    const contextWindowUsages = contextWindowUsage.list();
    syncGoalProjectionsFromSource(snapshot.sessions);
    const goals = snapshotGoalsFor(snapshot.sessions);
    const todos = snapshotTodosFor(snapshot.sessions);
    return {
      ...snapshot,
      sessions,
      runs: await Promise.all(
        snapshot.runs.map(async (run) => {
          const record = await sourceLedger.get(run.id);
          return record ? { ...run, ...(await projectRunRecord(record)) } : run;
        }),
      ),
      ...(contextWindowUsages.length > 0 ? { contextWindowUsages } : {}),
      ...(goals.length > 0 || snapshot.goals !== undefined ? { goals } : {}),
      ...(prompts.length > 0 || snapshot.prompts !== undefined
        ? { prompts }
        : {}),
      ...(todos.length > 0 || snapshot.todos !== undefined ? { todos } : {}),
      permission: currentPermissionState(),
      permissions: permissionProjection.listRequests(),
    };
  }

  function permissionError(
    code: string,
    message: string,
  ): Error & { code: string } {
    return Object.assign(new Error(message), { code });
  }

  async function getSessionIndex(): Promise<readonly UiSessionIndexEntry[]> {
    return stateStore.getSessionIndex();
  }

  async function validatePermissionRoot(
    sessionId: string,
  ): Promise<UiSessionIndexEntry> {
    const core = await options.sessionManager?.get(sessionId);
    if (core && !isPrimarySession(core))
      throw permissionError(
        "PERMISSION_SCOPE_CHANGED",
        "Select a primary session to manage permissions",
      );
    const session = (await getSessionIndex()).find(
      (item) => item.id === sessionId,
    );
    const projectRoot = await resolveProjectRoot();
    // Permissions follow membership, like viewing: a moving session's
    // current turn and its target workspace may both ask.
    if (
      !session ||
      (core
        ? !isSessionInWorkingDirectory(core, projectRoot)
        : session.workingDirectory !== undefined &&
          !sameSessionDirectory(session.workingDirectory, projectRoot))
    )
      throw permissionError(
        "PERMISSION_SCOPE_CHANGED",
        "Permission session is unavailable",
      );
    return session;
  }

  let selectionGeneration = 0;
  async function selectSessionMetadata(sessionId: string): Promise<void> {
    const generation = ++selectionGeneration;
    await ready;
    await validatePermissionRoot(sessionId);
    void enterSession(sessionId).catch((error: unknown) => {
      publishNotice({
        key: `session:initialize:${sessionId}`,
        level: "error",
        title: "Session unavailable",
        message: getErrorMessage(error),
      });
    });
    if (generation !== selectionGeneration)
      throw permissionError(
        "PERMISSION_SCOPE_CHANGED",
        "Session selection has changed",
      );
    await stateStore.setActiveSessionId(sessionId);
    void publishSessionIndexInvalidation().catch(() => {
      /* History is independent of selection. */
    });
  }

  // The hot UI page can be empty even when storage contains messages.
  // Require authoritative metadata and all message/run/prompt owners to agree.
  async function isAuthoritativelyEmptySession(
    candidate: CoreSession | UiSession | null | undefined,
    projectRoot: string,
  ): Promise<boolean> {
    if (
      !candidate ||
      !sameSessionDirectory(candidate.workingDirectory, projectRoot)
    )
      return false;
    if ("stats" in candidate) {
      if (
        !isPrimarySession(candidate) ||
        candidate.status !== "active" ||
        candidate.stats.messageCount !== 0
      )
        return false;
    } else if (candidate.messages.length !== 0) {
      return false;
    }
    const hotView = await stateStore.getSession(candidate.id);
    if (hotView?.messages.length) return false;
    if ((pendingRuntimePromptsBySession.get(candidate.id) ?? 0) > 0)
      return false;
    const [page, runs, hasPrompt] = await Promise.all([
      messageManager.listPageBySession(candidate.id, { limit: 1 }),
      sourceLedger.listBySession(candidate.id, { limit: 1 }),
      promptSubmissionStore.hasForSession(promptScopeKey, candidate.id),
    ]);
    return !page.messages.length && !page.hasMore && !runs.length && !hasPrompt;
  }

  async function isSessionIdAuthoritativelyEmpty(
    sessionId: string,
    projectRoot: string,
  ): Promise<boolean> {
    const candidate = options.sessionManager
      ? await options.sessionManager.get(sessionId)
      : await stateStore.getSession(sessionId);
    return isAuthoritativelyEmptySession(candidate, projectRoot);
  }

  async function findReusableEmptySession(
    input: Parameters<UiBackendClient["createSession"]>[0],
    projectRoot: string,
  ): Promise<CoreSession | UiSession | null> {
    const sessionManager = options.sessionManager;
    const reuseSessionId = input?.reuseSessionId;
    if (reuseSessionId) {
      const candidate = sessionManager
        ? await sessionManager.get(reuseSessionId)
        : await stateStore.getSession(reuseSessionId);
      if (
        candidate &&
        (await isAuthoritativelyEmptySession(candidate, projectRoot))
      )
        return candidate;
    }
    const inactive = input?.reuseInactiveEmpty;
    if (!inactive) return null;
    const excluded = new Set(inactive.excludeSessionIds);
    if (reuseSessionId) excluded.add(reuseSessionId);
    const candidates = sessionManager
      ? await sessionManager.listByWorkingDirectory(projectRoot, {
          status: "active",
        })
      : (await stateStore.readSnapshot()).sessions;
    for (const candidate of candidates) {
      if (
        excluded.has(candidate.id) ||
        ("stats" in candidate &&
          (!isPrimarySession(candidate) || candidate.stats.messageCount !== 0))
      )
        continue;
      if (await isAuthoritativelyEmptySession(candidate, projectRoot))
        return candidate;
    }
    return null;
  }

  function createSessionMetadata(
    input?: Parameters<UiBackendClient["createSession"]>[0],
  ): Promise<UiSessionCreationResult> {
    return withSessionAdmission("write", () =>
      createSessionMetadataWork(input),
    );
  }

  async function createSessionMetadataWork(
    input?: Parameters<UiBackendClient["createSession"]>[0],
  ): Promise<UiSessionCreationResult> {
    await ready;
    const index = await getSessionIndex();
    for (const entry of index) sessionIds.reserve(entry.id);
    const projectRoot = await resolveProjectRoot();
    const reusable = await findReusableEmptySession(input, projectRoot);
    if (reusable) {
      if (reusable.id !== input?.reuseSessionId)
        await initializeSessionView(reusable.id);
      return {
        created: false,
        id: reusable.id,
        title: reusable.title,
        workingDirectory: reusable.workingDirectory,
        createdAt:
          "stats" in reusable
            ? new Date(reusable.createdAt).toISOString()
            : reusable.createdAt,
        updatedAt:
          "stats" in reusable
            ? new Date(reusable.updatedAt).toISOString()
            : reusable.updatedAt,
      };
    }
    const createdAt = timestamp();
    const core = await options.sessionManager?.create(projectRoot, {
      agentName: options.agentManager?.getDefault() ?? "default",
      title: "New session",
    });
    const session: UiSession = core
      ? sessionMetadataToUiSession(core)
      : {
          id: sessionIds.next(),
          title: "New session",
          workingDirectory: projectRoot,
          createdAt,
          updatedAt: createdAt,
          messages: [],
        };
    await initializeSessionView(session.id, session);
    await upsertSession(session);
    publish({ type: "session.updated", session });
    return {
      created: true,
      id: session.id,
      title: session.title,
      workingDirectory: session.workingDirectory,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
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
      const directories = await loadConfiguredSkillDirectories({
        projectDirectory: projectRoot,
        onNotice: publishNotice,
      });
      skillDirectoriesSignature = JSON.stringify(directories);
      return new SkillRegistry({
        loader: new SkillLoader({
          directories,
          logger: createSkillLogger(),
          projectDirectory: projectRoot,
        }),
      });
    })();
    return skillRegistryPromise;
  }

  const modelClients = createModelClientPool(options);
  const sessionModels = new Map<
    string,
    { entryId: string; client: LLMClientInstance }
  >();

  function matchesSelectedModel(
    sessionId: string,
    runModel: RunModel,
  ): boolean {
    const selected = sessionModels.get(sessionId);
    return (
      selected?.entryId === runModel.entryId &&
      selected.client === runModel.client
    );
  }

  function observeSessionModel(
    sessionId: string,
    entryId: string,
    client: LLMClientInstance,
  ): void {
    const previous = sessionModels.get(sessionId);
    if (
      previous &&
      (previous.entryId !== entryId || previous.client !== client)
    ) {
      contextWindowUsage.clearSession(sessionId);
      promptCacheUsage.clearSession(sessionId);
    }
    sessionModels.set(sessionId, { entryId, client });
  }

  async function sessionModelEntryId(
    sessionId: string,
  ): Promise<string | undefined> {
    const core = await options.sessionManager?.get(sessionId);
    return core
      ? core.modelEntryId
      : (await stateStore.getSession(sessionId))?.modelEntryId;
  }

  async function resolveSessionModel(
    sessionId?: string,
    modelEntryId?: string,
  ) {
    if (sessionId) await requireOwnedSession(sessionId);
    return modelClients.resolve(
      await resolveProjectRoot(),
      modelEntryId ??
        (sessionId ? await sessionModelEntryId(sessionId) : undefined),
    );
  }

  async function resolveRunModel(input: {
    sessionId: string;
    modelEntryId?: string;
    hasModelSnapshot?: boolean;
  }): Promise<RunModel> {
    const selected = input.hasModelSnapshot
      ? input.modelEntryId
      : (input.modelEntryId ?? (await sessionModelEntryId(input.sessionId)));
    const resolved = await modelClients.resolve(
      await resolveProjectRoot(),
      selected,
    );
    if (resolved.removedEntryId) {
      const session = await stateStore.getSession(input.sessionId);
      const core = await options.sessionManager?.get(input.sessionId);
      if ((core ?? session)?.modelEntryId === resolved.removedEntryId) {
        const updatedCore = await options.sessionManager?.update(
          input.sessionId,
          { modelEntryId: undefined },
          { expectedModelEntryId: resolved.removedEntryId },
        );
        if (session) {
          const updated = updatedCore
            ? {
                ...session,
                ...sessionMetadataToUiSession(updatedCore),
                messages: session.messages,
              }
            : { ...session, modelEntryId: undefined };
          await upsertSession(updated);
          publish({ type: "session.updated", session: cloneSession(updated) });
        }
      }
      publishNotice({
        key: `model:entry-removed:${input.sessionId}`,
        level: "warning",
        title: "Model removed",
        message: `The selected model was removed. Using default ${resolved.entry.provider}/${resolved.entry.model}.`,
      });
    }
    // A queued execution may deliberately use an older selection. Its usage
    // must not replace the model currently displayed by this session.
    try {
      const current = await resolveSessionModel(input.sessionId);
      observeSessionModel(input.sessionId, current.entry.id, current.client);
    } catch {
      sessionModels.delete(input.sessionId);
      contextWindowUsage.clearSession(input.sessionId);
      promptCacheUsage.clearSession(input.sessionId);
    }
    return createRunModel(resolved.entry.id, resolved.client);
  }

  async function currentModelFromOptions(
    sessionId?: string,
  ): Promise<CommandModelSummary | null> {
    const exists = sessionId
      ? ((await options.sessionManager?.get(sessionId)) ??
        (await stateStore.getSession(sessionId)))
      : undefined;
    const current = await currentConnectModelFromOptions(
      exists ? sessionId : undefined,
    );
    return current ? { ...current, active: true, label: current.model } : null;
  }

  async function currentConnectModelFromOptions(
    sessionId?: string,
    draftEntryId?: string,
  ): Promise<UiCurrentModelConfig | null> {
    try {
      if (sessionId) await requireOwnedSession(sessionId);
      const selected = sessionId
        ? await sessionModelEntryId(sessionId)
        : draftEntryId;
      const { config, entry, source } = await modelClients.read(
        await resolveProjectRoot(),
        selected,
      );
      const reasoning = reasoningCapabilityView(
        config,
        await currentDiscoveryState(undefined, undefined, entry.id),
      );
      return {
        id: entry.id,
        source,
        apiKeyEnv: config.apiKeyEnv,
        baseUrl: config.baseUrl,
        contextWindowTokens: config.contextWindowTokens,
        interfaceProvider: config.interfaceProvider,
        maxOutputTokens: config.maxTokens,
        model: config.model,
        provider: config.provider,
        // This query describes the next turn's configuration. Settings keeps
        // the capability default separate from the entry's saved preference.
        reasoning:
          reasoning.status === "identified" && config.reasoning
            ? {
                ...reasoning,
                default: { ...reasoning.default, ...config.reasoning },
              }
            : reasoning,
      };
    } catch (error) {
      if (error instanceof ConfigError && error.code === "FILE_NOT_FOUND")
        return null;
      throw error;
    }
  }

  async function sessionReasoningPreference(
    sessionId: string,
    modelEntryId?: string,
  ): Promise<ReasoningConfig | undefined> {
    const core = await options.sessionManager?.get(sessionId);
    const session = core ?? (await stateStore.getSession(sessionId));
    if (!session?.reasoning) return undefined;
    const { client } = await resolveSessionModel(sessionId, modelEntryId);
    return filterReasoningPreference(
      sessionId,
      session.reasoning,
      client.config,
    );
  }

  function filterReasoningPreference(
    sessionId: string,
    preference: ReasoningConfig,
    config: ResolveRequestReasoningOptions,
  ): ReasoningConfig | undefined {
    if (compatibleReasoning(preference, config)) return { ...preference };
    publishNotice({
      key: `model:reasoning-fallback:${sessionId}`,
      level: "warning",
      title: "Reasoning preference reset",
      message:
        "This model does not support the selected reasoning preference. Using its default.",
    });
    return undefined;
  }

  function compatibleReasoning(
    preference: ReasoningConfig,
    config: ResolveRequestReasoningOptions,
  ): boolean {
    validateReasoningConfig(preference);
    const view = reasoningCapabilityView(config);
    if (view.status !== "identified") return true;
    try {
      resolveRequestReasoning({ ...config, reasoning: preference });
      return true;
    } catch {
      return false;
    }
  }

  async function requireOwnedSession(sessionId: string): Promise<UiSession> {
    const core = await options.sessionManager?.get(sessionId);
    const stored = await stateStore.getSession(sessionId);
    const session = core
      ? {
          ...stored,
          ...sessionMetadataToUiSession(core),
          messages: stored?.messages ?? [],
        }
      : stored;
    if (!session) throw new Error(`Session ${sessionId} not found`);
    const projectRoot = await resolveProjectRoot();
    if (
      session.workingDirectory &&
      !(core
        ? isSessionInWorkingDirectory(core, projectRoot)
        : sameSessionDirectory(session.workingDirectory, projectRoot))
    )
      throw new Error("Session belongs to another workspace");
    return session;
  }

  async function assertModelEntrySelectable(
    modelEntryId: string,
  ): Promise<void> {
    const document = await readModelDocument();
    if (
      options.llmClient &&
      document.models.length === 0 &&
      modelEntryId === "injected"
    )
      return;
    const entry = document.models.find((entry) => entry.id === modelEntryId);
    if (!entry) throw new ModelSettingsError("MODEL_NOT_FOUND");
    if (!configurationComplete(entry))
      throw new ModelSettingsError("MODEL_CONFIG_INCOMPLETE");
  }

  async function updateSessionReasoningInternal(
    input: Parameters<UiBackendClient["updateSessionReasoning"]>[0],
  ): ReturnType<UiBackendClient["updateSessionReasoning"]> {
    const session = await requireOwnedSession(input.sessionId);
    const preference = input.reasoning ?? undefined;
    validateReasoningConfig(preference);
    if (preference)
      resolveRequestReasoning({
        ...(await resolveSessionModel(input.sessionId)).client.config,
        reasoning: preference,
      });
    await options.sessionManager?.update(input.sessionId, {
      reasoning: preference,
    });
    const updated = {
      ...session,
      reasoning: preference ? { ...preference } : undefined,
      updatedAt: timestamp(),
    };
    await upsertSession(updated);
    publish({ type: "session.updated", session: cloneSession(updated) });
    return updated;
  }

  async function updateSessionModelInternal(
    input: Parameters<UiBackendClient["updateSessionModel"]>[0],
  ): ReturnType<UiBackendClient["updateSessionModel"]> {
    const session = await requireOwnedSession(input.sessionId);
    if (input.modelEntryId !== null)
      await assertModelEntrySelectable(input.modelEntryId);
    let reasoning = session.reasoning;
    if (reasoning) {
      try {
        const resolved = await modelClients.resolve(
          await resolveProjectRoot(),
          input.modelEntryId ?? undefined,
        );
        if (!compatibleReasoning(reasoning, resolved.client.config))
          reasoning = undefined;
      } catch (error) {
        if (
          !(
            error instanceof ConfigError &&
            error.code === "FILE_NOT_FOUND" &&
            input.modelEntryId === null
          )
        )
          throw error;
      }
    }
    const patch = { modelEntryId: input.modelEntryId ?? undefined, reasoning };
    const core = await options.sessionManager?.update(input.sessionId, patch);
    const updated = core
      ? {
          ...session,
          ...sessionMetadataToUiSession(core),
          messages: session.messages,
        }
      : { ...session, ...patch, updatedAt: timestamp() };
    await upsertSession(updated);
    publish({ type: "session.updated", session: cloneSession(updated) });
    promptCacheUsage.clearSession(input.sessionId);
    contextWindowUsage.clearSession(input.sessionId);
    await getContextWindowUsageInternal({ sessionId: input.sessionId }).catch(
      () => null,
    );
    return updated;
  }

  /** Complete entries, marking the session's model and the default (D20). */
  async function listModelsFromOptions(
    sessionId?: string,
  ): Promise<readonly CommandModelSummary[]> {
    const current = await currentModelFromOptions(sessionId);
    const complete = (await readModelDocument()).models.filter(
      configurationComplete,
    );
    // An injected client has no entries on disk; show what runs.
    if (complete.length === 0)
      return current ? [{ ...current, default: true }] : [];
    const defaultId = sessionId
      ? (await currentConnectModelFromOptions())?.id
      : current?.id;
    return complete.map((entry) => ({
      id: entry.id,
      label: entry.label ?? entry.model,
      provider: entry.provider,
      model: entry.model,
      interfaceProvider: entry.interfaceProvider,
      baseUrl: entry.baseUrl,
      ...(entry.apiKeyEnv === undefined ? {} : { apiKeyEnv: entry.apiKeyEnv }),
      active: entry.id === current?.id,
      default: entry.id === defaultId,
    }));
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
      const sessions = await options.sessionManager.listByWorkingDirectory(
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
              isSessionInWorkingDirectory(session, projectRoot),
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
          session.workingDirectory === undefined ||
          sameSessionDirectory(session.workingDirectory, projectRoot),
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
    if (
      activeSession?.workingDirectory &&
      activeSession.workingDirectory !== ""
    ) {
      return activeSession.workingDirectory;
    }
    return resolveProjectRoot();
  }

  /**
   * Reuse an existing empty session for `/new`. The session is treated as if
   * it had just been created: its `updatedAt` is bumped (core metadata and UI
   * state) so recency-sorted session lists move it to the top, and a
   * `session.updated` event is always published so connected clients reorder.
   */

  async function activateSessionForNewCommand(input: {
    readonly coreSession?: CoreSession;
    readonly session: UiSession;
  }): Promise<CommandSessionSummary> {
    await initializeSessionView(input.session.id, input.session);
    sessionIds.reserve(input.session.id);

    let updatedAt = timestamp();
    if (options.sessionManager && input.coreSession) {
      const touched = await options.sessionManager.update(
        input.coreSession.id,
        {},
      );
      updatedAt = new Date(touched.updatedAt).toISOString();
    }

    const session: UiSession = { ...input.session, updatedAt };
    await upsertSession(session);
    await setActiveSessionAndReconcileStatus(session.id);
    publish({ type: "session.updated", session: cloneSession(session) });
    await publishSessionIndexInvalidation();

    return {
      created: false,
      id: session.id,
      title: session.title,
    };
  }

  function createSessionFromCommand(input?: {
    readonly reuseInactiveEmptySessions?: boolean;
  }): Promise<CommandSessionSummary> {
    return withSessionAdmission("write", () =>
      createSessionFromCommandWork(input),
    );
  }

  async function createSessionFromCommandWork(input?: {
    readonly reuseInactiveEmptySessions?: boolean;
  }): Promise<CommandSessionSummary> {
    await ready;
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
          workingDirectory: projectRoot,
          createdAt,
          updatedAt: createdAt,
        };
      },
      getUiSession: (id) => stateStore.getSession(id),
      isAuthoritativelyEmpty: (id) =>
        isSessionIdAuthoritativelyEmpty(id, projectRoot),
      projectRoot,
      reuseInactiveEmptySessions: input?.reuseInactiveEmptySessions ?? true,
      sessionManager: options.sessionManager,
      snapshot,
    });
    const session = resolved.session;
    await initializeSessionView(session.id, session);

    if (!resolved.isNewSession) {
      return activateSessionForNewCommand({
        ...(resolved.coreSession ? { coreSession: resolved.coreSession } : {}),
        session,
      });
    }

    sessionIds.reserve(session.id);
    await upsertSession(session);
    await setActiveSessionAndReconcileStatus(session.id);
    publish({ type: "session.updated", session: cloneSession(session) });
    await publishSessionIndexInvalidation();

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

    const seen = new Set<string>();
    const pending = [sessionId];
    while (pending.length > 0) {
      const id = pending.pop();
      if (id === undefined) break;
      if (seen.has(id)) continue;
      seen.add(id);
      const runs = await sourceLedger.getActiveRuns(id);
      if (
        activePromptsBySession.has(id) ||
        runs.length > 0 ||
        (await promptSubmissionStore.hasUnfinishedForSession(id))
      ) {
        throw new SessionRunBusyError(
          sessionId,
          runs.map((run) => run.runId),
        );
      }
      const children = await options.sessionManager.listChildren(id);
      pending.push(...children.map((child) => child.id));
    }

    await options.sessionManager.update(sessionId, { status: "archived" });
    retirePromptCacheSession(sessionId);
    await stateStore.removeSession?.(sessionId);
    goalSnapshotsBySession.delete(sessionId);
    uiGoalsBySession.delete(sessionId);
    uiTodosBySession.delete(sessionId);
    todoProjectionScopesBySession.delete(sessionId);

    if (snapshot.activeSessionId === sessionId) {
      const remainingSessions = (
        await options.sessionManager.listByWorkingDirectory(
          session.workingDirectory,
          {
            status: "active",
          },
        )
      )
        .filter(isPrimarySession)
        .filter((candidate) =>
          sameSessionDirectory(
            candidate.workingDirectory,
            session.workingDirectory,
          ),
        )
        .sort(sortCoreSessionsByUpdatedAtDesc);
      await setActiveSessionAndReconcileStatus(
        remainingSessions[0]?.id ?? null,
      );
    }

    await publishSessionIndexInvalidation();
  }

  /** The database decides where a session's next turn runs; a pending project change wins. */
  async function movedSessionTarget(
    sessionId: string,
  ): Promise<string | undefined> {
    const session = await options.sessionManager?.get(sessionId);
    if (!session) return undefined;
    const target = sessionTargetWorkingDirectory(session);
    return sameSessionDirectory(target, await resolveProjectRoot())
      ? undefined
      : target;
  }

  async function assertSessionRoutable(sessionId: string): Promise<void> {
    const target = await movedSessionTarget(sessionId);
    if (target !== undefined) throw new SessionMovedError(sessionId, target);
  }

  /**
   * Viewing needs only membership: while a moved session finishes its turn
   * here, both this and the target workspace show it. Starting a turn
   * (prompt, compact) must happen in the target directory.
   */
  async function assertCanUseAsPrimarySession(
    sessionId: string | undefined,
    operation: "compact" | "prompt" | "view" = "prompt",
  ): Promise<void> {
    if (!sessionId || !options.sessionManager) {
      return;
    }
    const session = await options.sessionManager.get(sessionId);
    if (operation !== "view") {
      await assertSessionRoutable(sessionId);
    } else if (
      session &&
      !isSessionInWorkingDirectory(session, await resolveProjectRoot())
    ) {
      throw new SessionMovedError(
        sessionId,
        sessionTargetWorkingDirectory(session),
      );
    }
    if (session?.isSubagent === true || session?.parentId !== undefined) {
      const action =
        operation === "compact"
          ? "manually compact context for"
          : "submit a primary prompt to";
      throw new Error(`Cannot ${action} subagent session: ${sessionId}`);
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
    readonly expectedTemporaryTitle?: string;
    readonly hasModelSnapshot?: boolean;
    readonly uiSession: UiSession;
  }): Promise<boolean> {
    if (
      input.coreSession?.isSubagent === true ||
      input.uiSession.messages.length > 0 ||
      (input.coreSession?.stats.messageCount ?? 0) > 0
    ) {
      return false;
    }
    const expectedTitle =
      input.expectedTemporaryTitle ??
      (await promptSubmissionStore
        .getSessionTitleExpected(promptScopeKey, input.uiSession.id)
        .catch(() => undefined));
    if (
      (!isDefaultSessionTitle(input.uiSession.title) &&
        input.uiSession.title !== expectedTitle) ||
      (input.coreSession &&
        !isDefaultSessionTitle(input.coreSession.title) &&
        input.coreSession.title !== expectedTitle)
    )
      return false;

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
        { expectedTitle: input.session.title },
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
    updatedSession =
      (await stateStore.getSession(updatedSession.id)) ?? updatedSession;
    publish({
      type: "session.updated",
      session: cloneSession(updatedSession),
    });
    if (updatedSession.title !== input.session.title)
      await publishSessionIndexInvalidation();
    return updatedSession;
  }

  function scheduleSessionTitleGeneration(input: {
    readonly runModel: RunModel;
    readonly expectedTitle: string;
    readonly firstUserMessage: string;
    readonly namingSource?: import("ohbaby-sdk").UiPromptNamingSource;
    readonly projectRoot: string;
    readonly sessionId: string;
  }): void {
    void (async (): Promise<void> => {
      const llmClient = input.runModel.client;
      const generatedTitle = await generateSessionTitle({
        firstUserMessage: input.firstUserMessage,
        namingSource: input.namingSource,
        llmClient,
        logger: options.logger ?? NOOP_LOGGER,
        sessionId: input.sessionId,
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
        { expectedTitle: input.expectedTitle },
      );
      if (
        updatedCoreSession.title !== input.title ||
        updatedCoreSession.status !== "active"
      )
        return;
      const uiSession = await stateStore.getSession(input.sessionId);
      if (
        uiSession &&
        (uiSession.title === input.expectedTitle ||
          uiSession.title === input.title)
      ) {
        const updatedUiSession = {
          ...sessionMetadataToUiSession(updatedCoreSession),
          messages: uiSession.messages,
        };
        if (uiSession.title === input.expectedTitle)
          await upsertSession(updatedUiSession);
        publish({
          type: "session.updated",
          session: cloneSession(updatedUiSession),
        });
      }
      await publishSessionIndexInvalidation();
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
    await publishSessionIndexInvalidation();
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

    await assertCanUseAsPrimarySession(sessionId, "compact");
    const [uiSession, coreSession] = await Promise.all([
      stateStore.getSession(sessionId),
      options.sessionManager?.get(sessionId),
    ]);
    if (!uiSession && !coreSession) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    return {
      projectRoot:
        uiSession?.workingDirectory ??
        coreSession?.workingDirectory ??
        (await resolveProjectRoot()),
      sessionId,
    };
  }

  async function compactSessionInternal(
    compactOptions: UiCompactSessionOptions = {},
  ): Promise<UiCompactSessionResult> {
    const target = await resolveCompactTarget(compactOptions);
    compactOptions.signal?.throwIfAborted();
    const token = Symbol("manual compact");
    await sourceProjection.owner.runControl(target.sessionId, async () => {
      const queued = await promptSubmissionStore.listQueued(promptScopeKey);
      if (
        sessionExecution.isHeld(target.sessionId) ||
        promptScheduler.getRecoveryState(target.sessionId).status !== "ready" ||
        queued.some((prompt) => prompt.sessionId === target.sessionId) ||
        activePromptsBySession.has(target.sessionId) ||
        pendingRuntimePromptsBySession.has(target.sessionId)
      ) {
        throw new SessionRunBusyError(target.sessionId, []);
      }
      compactingSessions.add(target.sessionId);
      sessionExecution.reserve(target.sessionId, token);
    });
    let admission:
      | Awaited<ReturnType<typeof runtimeController.acquireRuntime>>
      | undefined;
    try {
      admission = await runtimeController.acquireRuntime();
      const runtime = admission.runtime;
      compactOptions.signal?.throwIfAborted();
      await runtime.setSessionWorkdir(target.sessionId, target.projectRoot);
      const result = await runtime.compactSession({
        signal: compactOptions.signal,
        force: compactOptions.force ?? true,
        reasoning: await sessionReasoningPreference(target.sessionId),
        projectRoot: target.projectRoot,
        sessionId: target.sessionId,
      });
      // Compaction has already finished; a failed refresh only degrades this estimate.
      const measured = await runtime
        .getContextUsage({
          projectRoot: target.projectRoot,
          sessionId: target.sessionId,
        })
        .catch(() => undefined);
      const usage = contextWindowUsage.updateFromContextUsage(
        target.sessionId,
        measured ?? result.usageAfter,
        measured?.composition,
      );
      if (usage) {
        const event: UiEvent = { type: "context.window.updated", usage };
        // A completed compact command includes its source context projection.
        // The owner handles projection failure; do not publish the fact twice.
        await sourceProjection.commitEvent(event);
        eventRouter.publish(event);
      }

      return {
        ...result,
        sessionId: target.sessionId,
      };
    } finally {
      compactingSessions.delete(target.sessionId);
      sessionExecution.release(token);
      admission?.release();
    }
  }

  async function getContextWindowUsageInternal(input: {
    readonly sessionId: string;
  }): Promise<UiContextWindowUsage | null> {
    const [coreSession, uiSession] = await Promise.all([
      options.sessionManager?.get(input.sessionId),
      stateStore
        .getSessionIndex()
        .then((sessions) =>
          sessions.find((session) => session.id === input.sessionId),
        ),
    ]);
    if (coreSession?.isSubagent === true) {
      return null;
    }

    let runModel: RunModel | undefined;
    if (coreSession || uiSession) {
      const selected = await resolveSessionModel(input.sessionId);
      observeSessionModel(input.sessionId, selected.entry.id, selected.client);
      runModel = createRunModel(selected.entry.id, selected.client);
    }
    const cached = contextWindowUsage.get(input.sessionId);
    if (cached) {
      return cached;
    }

    if (!runModel) {
      return null;
    }
    const projectRoot =
      uiSession?.workingDirectory ??
      coreSession?.workingDirectory ??
      (await resolveProjectRoot());

    const runtime = await runtimeController.getRuntime();
    const usage = await runtime.getContextUsage({
      runModel,
      projectRoot,
      sessionId: input.sessionId,
    });
    // A model switch can finish while the history query is still pending.
    if (!matchesSelectedModel(input.sessionId, runModel))
      return contextWindowUsage.get(input.sessionId) ?? null;
    // A live preparation or compact may have published newer context while
    // this static read was awaiting assembly. Keep that committed value.
    const newer = contextWindowUsage.get(input.sessionId);
    if (newer) return newer;
    const result = contextWindowUsage.updateFromContextUsage(
      input.sessionId,
      usage,
      usage.composition,
    );
    if (result) {
      const event: UiEvent = { type: "context.window.updated", usage: result };
      await sourceProjection.commitEvent(event);
      eventRouter.publish(event);
    }
    return result;
  }

  async function getPromptCacheUsageInternal(input: {
    readonly sessionId: string;
  }): Promise<UiPromptCacheUsage | null> {
    const [coreSession, uiSession] = await Promise.all([
      options.sessionManager?.get(input.sessionId),
      stateStore
        .getSessionIndex()
        .then((sessions) =>
          sessions.find((session) => session.id === input.sessionId),
        ),
    ]);
    if (coreSession?.isSubagent === true || (!coreSession && !uiSession)) {
      return null;
    }

    return promptCacheUsage.get(input.sessionId);
  }

  function submitPromptInternal(
    text: string,
    submitOptions?: InternalSubmitPromptOptions,
  ): Promise<RunCompletion | undefined> {
    const sessionId = submitOptions?.sessionId;
    if (sessionId && compactingSessions.has(sessionId)) {
      return Promise.reject(new SessionRunBusyError(sessionId, []));
    }
    if (sessionId) {
      pendingRuntimePromptsBySession.set(
        sessionId,
        (pendingRuntimePromptsBySession.get(sessionId) ?? 0) + 1,
      );
    }
    return submitPromptWork(text, submitOptions).finally(() => {
      if (!sessionId) return;
      const remaining =
        (pendingRuntimePromptsBySession.get(sessionId) ?? 1) - 1;
      if (remaining > 0)
        pendingRuntimePromptsBySession.set(sessionId, remaining);
      else pendingRuntimePromptsBySession.delete(sessionId);
    });
  }

  async function submitPromptWork(
    text: string,
    submitOptions?: InternalSubmitPromptOptions,
  ): Promise<RunCompletion | undefined> {
    const owner = submitOptions?.owner ?? "user";
    let todoWorkScopeId: TodoWorkScopeId | undefined;
    if (owner === "goal") {
      if (submitOptions?.goalId === undefined) {
        const message = "Goal-owned prompt is missing its goalId.";
        publishNotice({
          key: "goal:missing-run-identity",
          level: "error",
          message,
          source: "goals",
          title: "Goal execution invariant failed",
        });
        throw new Error(message);
      }
      todoWorkScopeId = goalTodoWorkScopeId(submitOptions.goalId);
    }
    let promptSessionId = submitOptions?.sessionId ?? `pending_${randomUUID()}`;
    await waitForPromptSlot(owner, promptSessionId);
    assertStateStoreWritable();
    await ready;
    if (submitOptions?.sessionId) {
      const recovery = promptScheduler.getRecoveryState(
        submitOptions.sessionId,
      );
      if (submitOptions.reservedUserMessageId && recovery.status === "blocked")
        throw new Error(recovery.message);
      await enterSession(submitOptions.sessionId);
    }
    submitOptions?.signal?.throwIfAborted();
    await options.beforePromptSubmit?.();
    let activePrompt: ActivePromptState = {
      owner,
      sessionId: promptSessionId,
      ...(submitOptions?.goalId === undefined
        ? {}
        : { goalId: submitOptions.goalId }),
      ...(todoWorkScopeId === undefined ? {} : { todoWorkScopeId }),
      runReady: false,
    };
    submitOptions?.signal?.throwIfAborted();
    const admission = await runtimeController.acquireRuntime();
    if (submitOptions?.signal?.aborted) {
      admission.release();
      submitOptions.signal.throwIfAborted();
    }
    activePromptsBySession.set(promptSessionId, activePrompt);
    const createdAt = timestamp();
    let projection: RunStreamProjection | undefined;
    let promptRuntime: UiRuntimeComposition | undefined;
    let submittedSessionId: string | undefined;
    let submittedRunId: string | undefined;
    let todoWorkScopeLease: TodoWorkScopeLease | undefined;

    try {
      submitOptions?.signal?.throwIfAborted();
      await assertCanUseAsPrimarySession(submitOptions?.sessionId);
      await reserveIdsFromState();
      const runtime = admission.runtime;
      promptRuntime = runtime;
      const agentName = runtime.agentManager.getDefault();
      const baseProjectRoot = await resolveProjectRoot();
      const temporaryTitle = createTemporarySessionTitle(
        sessionTitleIntent(text, submitOptions?.namingSource),
      );
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
      await initializeSessionView(
        resolvedSession.session.id,
        resolvedSession.session,
      );
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
          expectedTemporaryTitle: submitOptions?.expectedTemporaryTitle,
          uiSession: session,
        })
      ) {
        shouldGenerateSessionTitle = true;
        session = await applyTemporarySessionTitle({
          session,
          title: temporaryTitle,
        });
        shouldGenerateSessionTitle = session.title === temporaryTitle;
      }
      const resolvedProjectRoot = existingCoreSession
        ? sessionTargetWorkingDirectory(existingCoreSession)
        : (session.workingDirectory ?? baseProjectRoot);
      if (
        existingCoreSession &&
        !sameSessionDirectory(
          existingCoreSession.workingDirectory,
          resolvedProjectRoot,
        )
      ) {
        // The session arrives from another directory. Its last turn there must
        // finish first; this view may have been seeded while it was running.
        const active = await sourceLedger.getActiveRuns(session.id);
        if (active.length > 0)
          throw new SessionRunBusyError(
            session.id,
            active.map((run) => run.runId),
          );
        if (sourceProjection.owner.hasViewOrPendingSeed(session.id)) {
          await sourceProjection.owner.rebuild(session.id);
          publish({
            type: "session.updated",
            session: cloneSession(
              sourceProjection.owner.read(session.id).session,
            ),
          });
        }
      }
      submittedSessionId = session.id;
      if (promptSessionId !== session.id) {
        activePromptsBySession.delete(promptSessionId);
        promptSessionId = session.id;
        await waitForPromptSlot(owner, promptSessionId);
        activePrompt = {
          ...activePrompt,
          sessionId: promptSessionId,
        };
        activePromptsBySession.set(promptSessionId, activePrompt);
      }

      if (submitOptions?.reservedUserMessageId) {
        messageIds.reserve(submitOptions.reservedUserMessageId);
      }
      const userMessage = createTextMessage({
        id: submitOptions?.reservedUserMessageId ?? messageIds.next(),
        role: "user",
        text: submitOptions?.displayText ?? text,
        createdAt,
      });
      const runId = await nextRunId();
      submittedRunId = runId;
      submitOptions?.signal?.throwIfAborted();
      if (submitOptions?.goalTicket)
        sharedGoalService.bindTicketRun(submitOptions.goalTicket, runId);

      let runModel: RunModel;
      try {
        runModel = await resolveRunModel({
          sessionId: session.id,
          modelEntryId: submitOptions?.modelEntryId,
          hasModelSnapshot: submitOptions?.hasModelSnapshot,
        });
      } catch (error) {
        publishNotice({
          key: `runtime:model:${session.id}`,
          level: "error",
          title: "Runtime error",
          message: getErrorMessage(error),
        });
        throw error;
      }
      let reasoning =
        submitOptions?.reasoning ??
        (submitOptions?.hasModelSnapshot ? undefined : session.reasoning);
      if (
        reasoning &&
        !compatibleReasoning(reasoning, runModel.client.config)
      ) {
        reasoning = undefined;
        publishNotice({
          key: `model:reasoning-fallback:${session.id}`,
          level: "warning",
          title: "Reasoning preference reset",
          message:
            "This model does not support the selected reasoning preference. Using its default.",
        });
      }
      session = (await stateStore.getSession(session.id)) ?? session;

      runtimeController.setActiveRunId(runId, session.id);
      todoWorkScopeLease = runtime.todoWorkScopes.acquire(
        session.id,
        todoWorkScopeId,
      );
      await showTodoForRun(session.id, runtime.todos, todoWorkScopeId);
      activePrompt.runId = runId;
      projection = runtimeController.startRunStreamProjection({
        projectMessages: false,
        autoStart: false,
        contextWindowUsage: {
          ...contextWindowUsage,
          updateFromContextUsage: (id, usage, composition) =>
            matchesSelectedModel(id, runModel)
              ? contextWindowUsage.updateFromContextUsage(
                  id,
                  usage,
                  composition,
                )
              : null,
        },
        nextMessageId: () => messageIds.next(),
        onNotice: publishNotice,
        onBeforeTerminalRun: () => {
          if (!shouldKeepTodoVisibleAfterRun(activePrompt)) {
            hideTodoAfterRun(session.id);
          }
        },
        publish,
        runId,
        sessionId: session.id,
        stateStore,
        streamBridge: runtime.streamBridge,
        timestamp,
      });

      let startedRuntimeRunId: string | undefined;
      try {
        submitOptions?.signal?.throwIfAborted();
        const result = await runtime.startSession({
          preparationSignal: submitOptions?.goalTicket?.controller.signal,
          agentName,
          reasoning,
          runModel,
          initialUserMessageId: userMessage.id,
          skillUsage: slashSkillUsage(submitOptions?.namingSource),
          ...(submitOptions?.displayText === undefined
            ? {}
            : { displayUserText: submitOptions.displayText }),
          prompt: text,
          projectRoot: resolvedProjectRoot,
          runId,
          sessionId: session.id,
          title: session.title,
        });
        startedRuntimeRunId = result.runId;
        if (submitOptions?.goalTicket) {
          const stop = submitOptions.goalTicket.stopIntent;
          if (stop?.includePrimary)
            await runtime.interruptRunTree(result.runId, stop.reason);
          else if (stop)
            await runtime.interruptSubagentsByRootRun(
              result.runId,
              stop.reason,
            );
        }
        if (result.runId !== runId) {
          throw new Error(
            `Agent service created unexpected run id: ${result.runId}`,
          );
        }
        // The run ledger has admitted this turn; only now does a pending
        // project change become the session's execution directory.
        if (
          existingCoreSession &&
          !sameSessionDirectory(
            existingCoreSession.workingDirectory,
            resolvedProjectRoot,
          )
        ) {
          await options.sessionManager?.recordWorkingDirectory?.(
            session.id,
            resolvedProjectRoot,
          );
        }
        await submitOptions?.onRunStarted?.(runId);
      } catch (error) {
        try {
          if (startedRuntimeRunId !== undefined) {
            await Promise.allSettled([
              runtime.interruptRunTree(
                startedRuntimeRunId,
                "prompt start handshake failed",
              ),
              runtime.runManager.waitForCompletion(startedRuntimeRunId),
            ]);
          }
        } finally {
          await projection.stop();
        }
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
          runModel,
          expectedTitle: temporaryTitle,
          firstUserMessage: text,
          namingSource: submitOptions?.namingSource,
          projectRoot: resolvedProjectRoot,
          sessionId: session.id,
        });
      }

      projection.start();
      activePrompt.runReady = true;
      notifyPromptRunReady(session.id);

      try {
        const completion = await runtime.runManager.waitForCompletion(runId);
        await projection.done;
        if (
          completion.status === "failed" ||
          completion.status === "interrupted"
        ) {
          if (submittedRunId) {
            runtimeController.clearActiveRunId(submittedRunId);
            submittedRunId = undefined;
          }
          await reconcileRuntimeStatus();
        }
        return completion;
      } catch (error) {
        if (error instanceof RunFinalizationError) await projection.stop();
        else await projection.done.catch(() => undefined);
        const errorStatus = {
          ...(IrisError.isInstance(error) ? { code: error.code } : {}),
          kind: "error" as const,
          message: getErrorMessage(error),
          recoverable: true,
        };
        if (submittedRunId) {
          await updateActiveRunStatus(errorStatus, submittedRunId);
          runtimeController.clearActiveRunId(submittedRunId);
          submittedRunId = undefined;
        }
        await reconcileRuntimeStatus();
        throw error;
      }
    } finally {
      todoWorkScopeLease?.release();
      if (submittedSessionId && promptRuntime) {
        const projectionSessionId = submittedSessionId;
        await refreshTodoProjectionAfterRun(
          projectionSessionId,
          promptRuntime,
        ).catch((error: unknown) => {
          hideTodoAfterRun(projectionSessionId);
          publishNotice({
            key: `todo:projection:${projectionSessionId}:${getErrorMessage(error)}`,
            level: "warning",
            message: `Todo projection could not be refreshed: ${getErrorMessage(error)}`,
            source: "todo",
            title: "Todo projection warning",
          });
        });
      }
      if (submittedSessionId) {
        await syncSessionStatsBestEffort(submittedSessionId);
        if (stateStore.requiresServiceManagersForWrites) {
          try {
            const settledSession =
              await stateStore.getSession(submittedSessionId);
            if (settledSession) {
              // A model save can replace the UI snapshot while this run is
              // active. The live projection and stored transcript have
              // different message ids; restore the stored transcript once
              // the projection has finished, before the next prompt starts.
              publish({
                type: "session.updated",
                session: cloneSession(settledSession),
              });
            }
          } catch (error) {
            publishNotice({
              key: `session:projection:${submittedSessionId}:${getErrorMessage(error)}`,
              level: "warning",
              message: `Session view could not be refreshed: ${getErrorMessage(error)}`,
              source: "session",
              title: "Session view warning",
            });
          }
        }
      }
      if (activePromptsBySession.get(promptSessionId) === activePrompt) {
        activePromptsBySession.delete(promptSessionId);
      }
      if (submittedRunId) {
        runtimeController.clearActiveRunId(submittedRunId);
      }
      try {
        await options.afterPromptSubmitSettled?.();
      } finally {
        notifyPromptIdle(promptSessionId);
        admission.release();
      }
    }
  }

  function notifyPromptIdle(sessionId: string): void {
    const waiters = [...(promptIdleWaiters.get(sessionId) ?? [])];
    promptIdleWaiters.delete(sessionId);
    for (const resolve of waiters) {
      resolve();
    }
  }

  function notifyPromptRunReady(sessionId: string): void {
    const waiters = [...(promptRunReadyWaiters.get(sessionId) ?? [])];
    promptRunReadyWaiters.delete(sessionId);
    for (const resolve of waiters) {
      resolve();
    }
  }

  async function waitForPromptSlot(
    owner: PromptOwner,
    sessionId: string,
  ): Promise<void> {
    for (;;) {
      const active = activePromptsBySession.get(sessionId);
      if (!active) {
        return;
      }
      if (owner !== active.owner) {
        await waitForPromptIdle(sessionId);
        continue;
      }
      throw new Error(`A prompt is already running for session ${sessionId}`);
    }
  }

  async function interruptGoalExecution(
    input: GoalExecutionInterruptInput,
  ): Promise<void> {
    const runtime = await runtimeController.getRuntimeForPrompt();
    const sessionId = input.sessionId;
    await executeGoalExecutionInterrupt(input, {
      abortPromptRun: (runId) => runtimeController.abortPromptRun(runId),
      activeRunId: () => runtimeController.getActiveRunId(sessionId),
      interruptSubagentsByRootRun: (runId, reason) =>
        runtime.interruptSubagentsByRootRun(runId, reason),
      promptOwner: () => activePromptsBySession.get(sessionId)?.owner,
      promptSessionId: () => activePromptsBySession.get(sessionId)?.sessionId,
      waitForPromptRunReadyOrIdle: () => waitForPromptRunReadyOrIdle(sessionId),
    });
  }

  async function waitForPromptIdle(sessionId: string): Promise<void> {
    if (!activePromptsBySession.has(sessionId)) {
      return;
    }
    await new Promise<void>((resolve) => {
      const waiters = promptIdleWaiters.get(sessionId) ?? new Set();
      waiters.add(resolve);
      promptIdleWaiters.set(sessionId, waiters);
    });
  }

  async function waitForPromptRunReadyOrIdle(sessionId: string): Promise<void> {
    const active = activePromptsBySession.get(sessionId);
    if (!active || active.runReady) {
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const resolveOnce = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        promptRunReadyWaiters.get(sessionId)?.delete(resolveOnce);
        promptIdleWaiters.get(sessionId)?.delete(resolveOnce);
        resolve();
      };
      const readyWaiters = promptRunReadyWaiters.get(sessionId) ?? new Set();
      readyWaiters.add(resolveOnce);
      promptRunReadyWaiters.set(sessionId, readyWaiters);
      const idleWaiters = promptIdleWaiters.get(sessionId) ?? new Set();
      idleWaiters.add(resolveOnce);
      promptIdleWaiters.set(sessionId, idleWaiters);
    });
  }

  const pendingModelSaves = new Map<string, Promise<UiConnectModelResult>>();
  function connectModelInternal(
    input: UiConnectModelInput,
  ): Promise<UiConnectModelResult> {
    const key = JSON.stringify(input);
    const pending = pendingModelSaves.get(key);
    if (pending) return pending;
    const save = saveModelConfig(input).finally(() =>
      pendingModelSaves.delete(key),
    );
    pendingModelSaves.set(key, save);
    return save;
  }

  async function saveModelConfig(
    input: UiConnectModelInput,
  ): Promise<UiConnectModelResult> {
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

    try {
      const projectRoot = await resolveProjectRoot();
      const result = await applyActiveModelConfig({
        ...input,
        projectRoot,
        deferMetadata: true,
        onDiscovery: publishModelInvalidation,
      });
      let warning = result.warning;
      try {
        await publishModelInvalidation();
      } catch {
        warning = [
          warning,
          "Configuration saved, but the current view could not reload; new runs may be temporarily unavailable.",
        ]
          .filter(Boolean)
          .join(" ");
      }
      return {
        ...result,
        ...(warning === undefined ? {} : { warning }),
        interfaceProvider: input.interfaceProvider,
      };
    } finally {
      releaseSave();
    }
  }

  async function probeModelContextWindowInternal(
    input: Parameters<UiBackendClient["probeModelContextWindow"]>[0],
  ): ReturnType<UiBackendClient["probeModelContextWindow"]> {
    return probeActiveModelContextWindow({
      ...input,
      projectRoot: await resolveProjectRoot(),
      onDiscovery: publishModelInvalidation,
    });
  }

  async function setSearchApiKeyInternal(
    input: UiSetSearchApiKeyInput,
  ): Promise<UiSetSearchApiKeyResult> {
    const isPromptRunning = (): boolean => activePromptsBySession.size > 0;
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
    const usage = completion?.usage;
    const cachedInputTokens = usage?.inputBreakdown?.observed.cacheRead
      ? usage.inputBreakdown.cacheRead
      : usage?.cachedInputTokens;
    return {
      status:
        completion?.status === "succeeded" || completion?.status === "cancelled"
          ? completion.status
          : "failed",
      ...(completion?.status === "succeeded" ||
      completion?.status === "cancelled"
        ? {}
        : {
            error: completion?.error ?? `Run ${completion?.status ?? "failed"}`,
          }),
      usage: {
        // An incomplete zero aggregate has no observed subtotal; do not turn
        // missing provider usage into a persisted zero.
        ...(usage && (usage.usageComplete || usage.totalTokens > 0)
          ? { totalTokens: usage.totalTokens }
          : {}),
        ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
        usageComplete:
          usage?.usageComplete === true &&
          usage.inputBreakdown?.observed.cacheRead === true,
      },
    };
  }

  async function resolveGoalSessionId(
    explicit?: string,
  ): Promise<string | undefined> {
    const explicitSessionId = explicit?.trim();
    if (explicitSessionId) {
      await ready;
      await assertCanUseAsPrimarySession(explicitSessionId);
      await initializeSessionView(explicitSessionId);
      return explicitSessionId;
    }
    const snapshot = await stateStore.readSnapshot();
    if (!snapshot.activeSessionId) {
      return undefined;
    }
    await assertCanUseAsPrimarySession(snapshot.activeSessionId);
    // Goal state controls remain available while execution finalization is blocked.
    await initializeSessionView(snapshot.activeSessionId);
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
      });
    },
    async pause(sessionId) {
      return (await goalService()).pauseGoal(sessionId);
    },
    async replace(sessionId, objective) {
      return (await goalService()).replaceGoal(sessionId, objective);
    },
    resolveSessionId: resolveGoalSessionId,
    async resume(sessionId, limits) {
      return (await goalService()).resumeGoal(sessionId, limits);
    },
    status(sessionId): Promise<GoalSnapshot | null> {
      const snapshot = sharedGoalService.peekSnapshot(sessionId) ?? null;
      publishGoalUpdated(sessionId, snapshot);
      return Promise.resolve(snapshot);
    },
  };

  const diagnosticsFilePath = options.diagnosticsFilePath;
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
        await ready;
        await assertCanUseAsPrimarySession(sessionId, "view");
        await initializeSessionView(sessionId);
        const session = await stateStore.getSession(sessionId);
        if (!session) {
          throw new Error(`Session not found: ${sessionId}`);
        }
        await setActiveSessionAndReconcileStatus(sessionId);
        await publishSessionIndexInvalidation();
      },
    },
    compact: {
      compactSession: compactSessionInternal,
    },
    skills: {
      async listUserInvocable() {
        const registry = await getSkillRegistry();
        await registry.refresh();
        return registry.listUserInvocable();
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
    submitPromptAccepted(text, submitOptions) {
      return submitPromptAcceptedInternal(text, {
        ...submitOptions,
        namingSource: expandedSkillNamingSource(submitOptions?.namingSource),
      });
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
    getStatus(): string {
      return activePromptsBySession.size > 0 ? "running" : "idle";
    },
    getContextWindowUsage(input) {
      return getContextWindowUsageInternal(input);
    },
    getPromptCacheUsage(input) {
      return getPromptCacheUsageInternal(input);
    },
    getProjectRoot: resolveProjectRoot,
    ...(diagnosticsFilePath === undefined
      ? {}
      : { getDiagnosticsFilePath: (): string => diagnosticsFilePath }),
  });

  eventRouter.addSubscriptions(
    subscribeAppEventProjectors({
      bus,
      target(projected) {
        publish(projected.uiEvent);
      },
    }),
    startPermissionEventProjection({ bus, currentPermissionState, publish }),
    permissionProjection.subscribe((event) => {
      publish(event);
      void reconcileRuntimeStatus().catch(() => {
        /* Chat status does not control approvals. */
      });
    }),
  );
  async function validateSessionRead(input: UiSessionScope): Promise<void> {
    await ready;
    input.signal?.throwIfAborted();
    if (
      input.runtimeEpoch &&
      input.runtimeEpoch !== permissionProjection.permissionEpoch
    )
      throw permissionError("SESSION_SCOPE_CHANGED", "Backend runtime changed");
    await validatePermissionRoot(input.sessionId);
    input.signal?.throwIfAborted();
  }
  async function subagentViews(): Promise<
    ReturnType<typeof createSubagentViewReader>
  > {
    const runtime = await runtimeController.getRuntimeIfStarted();
    return createSubagentViewReader({
      executions: subagentExecutionStore,
      source: sourceProjection,
      rootExists: async (id): Promise<boolean> => {
        await validatePermissionRoot(id);
        return true;
      },
      activeRootRun: (id): Promise<string | undefined> =>
        Promise.resolve(runtimeController.getActiveRunId(id)),
      waitState: (id) =>
        runtime?.getSubagentWaitState(id) ?? {
          waiting: false,
          approvalBlocked: false,
        },
      budget: (id) => runtime?.getSubagentExecutionBudget(id),
    });
  }
  let closingRuntime: Promise<UiRuntimeComposition> | undefined;
  let disposed = false;
  let disposal: Promise<CleanupResult> | undefined;
  function closeAdmission(): void {
    if (disposed) return;
    disposed = true;
    sharedGoalService.dispose();
    acceptsPromptCacheUsage = false;
    closingRuntime = runtimeController.getRuntimeIfStarted();
    runtimeController.close();
    promptScheduler.close();
    sessionExecution.close();
    interactionBroker.abortAll("service-shutdown");
  }
  const ready = Promise.resolve(options.startupReady).then(async () => {
    if (disposed) return;
    const selected = await stateStore.getActiveSessionId();
    if (selected)
      void enterSession(selected).catch((error: unknown) => {
        publishNotice({
          key: `session:initialize:${selected}`,
          level: "error",
          title: "Session unavailable",
          message: getErrorMessage(error),
        });
      });
    await promptScheduler.init();
  });
  // The eager startup promise remains observable through initialize and writes.
  void ready.catch(() => undefined);
  return {
    async notifySettingsChanged(domains): Promise<void> {
      publish({ type: "settings.changed", domains });
      if (domains.includes("model")) await publishModelInvalidation();
    },
    async reconnectSettingsMcp(): ReturnType<
      InstanceSettingsReader["getSettingsMcpStatus"]
    > {
      const projectRoot = await resolveProjectRoot();
      const manager = McpManager.getInstance(projectRoot);
      let status: Awaited<
        ReturnType<InstanceSettingsReader["getSettingsMcpStatus"]>
      > = [];
      await runtimeController.reconnectMcp(async () => {
        // Snapshot first: a later edit only leaves an older version recorded.
        const version = (await settingsConfigVersion(projectRoot)).mcp;
        await manager.reload();
        status = await readSettingsMcpStatus(manager);
        appliedMcpVersion = version;
        return version;
      });
      return status;
    },
    async getSettingsMcpStatus(): ReturnType<
      InstanceSettingsReader["getSettingsMcpStatus"]
    > {
      const projectRoot = await resolveProjectRoot();
      // Claim the first initialization's version before waiting for connections.
      // A concurrent runtime must not label these connections with a newer hash.
      await coordinateModelConfig(undefined, async () => {
        appliedMcpVersion ??= (await settingsConfigVersion(projectRoot)).mcp;
      });
      return readSettingsMcpStatus(McpManager.getInstance(projectRoot));
    },
    getSettingsSkills(): ReturnType<
      InstanceSettingsReader["getSettingsSkills"]
    > {
      return coordinateModelConfig(undefined, async () => {
        const registry = await getSkillRegistry();
        const directories = await loadConfiguredSkillDirectories({
          projectDirectory: await resolveProjectRoot(),
          onNotice: publishNotice,
        });
        const signature = JSON.stringify(directories);
        if (signature !== skillDirectoriesSignature) {
          await registry.reload(directories);
          skillDirectoriesSignature = signature;
        }
        return readSettingsSkills(registry);
      });
    },
    getSettingsAgents(): ReturnType<
      InstanceSettingsReader["getSettingsAgents"]
    > {
      return coordinateModelConfig(undefined, async () => {
        const projectDirectory = await resolveProjectRoot();
        const manager =
          options.agentManager ??
          new AgentManager({
            registry: new AgentRegistry({
              configLoader: (): ReturnType<typeof loadAgentConfigWithOrigins> =>
                loadAgentConfigWithOrigins({ projectDirectory }),
            }),
          });
        if (!options.agentManager || !runtimeController.getRuntimeIfStarted())
          await manager.initialize();
        return readSettingsAgents(manager);
      });
    },
    initialize: () => ready,
    initializeSession: (sessionId) => enterSession(sessionId, true),
    getSubagentConversationView: (input) => subagentConversations.read(input),
    retainSubagentConversation: (input) => subagentConversations.retain(input),
    releaseSubagentConversation: (input) =>
      subagentConversations.release(input),
    async listSubagentExecutions(input) {
      return (await subagentViews()).list(input);
    },
    async getSubagentExecutionView(input) {
      return (await subagentViews()).view(input);
    },
    async getSessionView(input): Promise<UiSessionView> {
      await validateSessionRead(input);
      const entry = sessionEntries.get(input.sessionId);
      if (entry) {
        try {
          await entry;
        } catch (error) {
          // Return the blocked view when its history was readable; otherwise
          // preserve the original entry error instead of rebuilding in a loop.
          try {
            return {
              ...sourceProjection.owner.read(input.sessionId),
              serverNow: Date.now(),
            };
          } catch {
            throw error;
          }
        }
      }
      try {
        await sourceProjection.owner.ready(input.sessionId);
        return {
          ...sourceProjection.owner.read(input.sessionId),
          serverNow: Date.now(),
        };
      } catch (error) {
        if (!sourceProjection.owner.hasViewOrPendingSeed(input.sessionId))
          throw error;
        await sourceProjection.owner.rebuild(input.sessionId);
        return {
          ...sourceProjection.owner.read(input.sessionId),
          serverNow: Date.now(),
        };
      }
    },
    async getSessionHistory(input): Promise<UiSessionHistory> {
      await validateSessionRead(input);
      await sessionEntries.get(input.sessionId)?.catch(() => undefined);
      await sourceProjection.owner.ready(input.sessionId);
      return sourceProjection.history(
        input.sessionId,
        input.before,
        input.limit,
      );
    },
    async getSessionControl(input): Promise<UiSessionControl> {
      await validateSessionRead(input);
      await sessionEntries.get(input.sessionId)?.catch(() => undefined);
      const executionRecovery = executionRecoveryFor(input.sessionId);
      if (
        sharedGoalService.peekSnapshot(input.sessionId) === undefined &&
        executionRecovery.status !== "blocked"
      )
        throw permissionError(
          "SESSION_CONTROL_UNAVAILABLE",
          "Session execution control has not initialized",
        );
      const active = activePromptsBySession.get(input.sessionId);
      const indexedRunId = runtimeController.getActiveRunId(input.sessionId);
      const runtime = await runtimeController.getRuntimeIfStarted();
      const run = indexedRunId
        ? runtime?.runManager.get(indexedRunId)
        : undefined;
      // Terminal publication can precede the adapter's finally/index cleanup.
      // Control reads follow the Run's current fact, not that stale index.
      const activeRunId =
        run && (run.status === "pending" || run.status === "running")
          ? indexedRunId
          : undefined;
      return {
        runtimeEpoch: permissionProjection.permissionEpoch,
        sessionId: input.sessionId,
        rootSessionId: input.sessionId,
        executionRecovery,
        runId: activeRunId ?? null,
        driver: activeRunId ? (active?.owner ?? null) : null,
      };
    },
    async getPromptReceipt(input): Promise<UiPromptReceiptResult> {
      await ready;
      input.signal?.throwIfAborted();
      if (
        input.runtimeEpoch &&
        input.runtimeEpoch !== permissionProjection.permissionEpoch
      )
        throw permissionError(
          "SESSION_SCOPE_CHANGED",
          "Backend runtime changed",
        );
      const prompt = await promptScheduler.getByClientRequestId(
        input.clientRequestId,
      );
      if (prompt) {
        await validatePermissionRoot(prompt.sessionId);
        if (input.sessionId && input.sessionId !== prompt.sessionId)
          throw permissionError(
            "SESSION_SCOPE_CHANGED",
            "Prompt scope changed",
          );
      }
      return {
        runtimeEpoch: permissionProjection.permissionEpoch,
        clientRequestId: input.clientRequestId,
        receipt: prompt
          ? {
              promptId: prompt.promptId,
              clientRequestId: prompt.clientRequestId,
              userMessageId: prompt.userMessageId,
              sessionId: prompt.sessionId,
              status: prompt.status,
              createdAt: new Date(prompt.createdAt).toISOString(),
              steer:
                prompt.status === "steered" && prompt.steerReceipt
                  ? { status: "steered", receipt: prompt.steerReceipt }
                  : { status: "existing", promptId: prompt.promptId },
            }
          : null,
      };
    },
    getActiveGoalRunForSteer,
    wakePromptQueue(): void {
      promptScheduler.wake();
    },
    assertSessionRoutable,
    closeAdmission,
    dispose(
      shutdown: ShutdownOptions = createShutdownOptions(),
    ): Promise<CleanupResult> {
      closeAdmission();
      if (disposal) return disposal;
      permission.dispose();
      disposal = collectCleanup(shutdown, {
        runtime: () => runtimeController.resetRuntime(shutdown),
        prompts: async () => {
          // Goal settlement can register recovery after the runtime has finished.
          await sharedGoalService.whenIdle();
          await promptScheduler.settleShutdown();
        },
      }).then((result) => {
        eventRouter.dispose();
        unsubscribePromptCacheUsageSessionRemoved();
        promptCacheUsage.clear();
        retiredPromptCacheSessionIds.clear();
        subagentConversations.dispose();
        sourceProjection.reasoning.dispose();
        sourceProjection.owner.dispose();
        return result;
      });
      return disposal;
    },

    getSessionIndex,
    getSelectedSessionId: () => stateStore.getActiveSessionId(),
    createSession: createSessionMetadata,
    selectSession: selectSessionMetadata,
    subscribePermissionEvents: permissionProjection.subscribe,
    async getPermissionSnapshot(
      input,
    ): ReturnType<UiBackendClient["getPermissionSnapshot"]> {
      input.signal?.throwIfAborted();
      if (
        input.permissionEpoch &&
        input.permissionEpoch !== permissionProjection.permissionEpoch
      )
        throw permissionError(
          "PERMISSION_SCOPE_CHANGED",
          "Permission runtime changed",
        );
      if (input.rootSessionId !== null) {
        await validatePermissionRoot(input.rootSessionId);
        if (!permission.isHealthy(input.rootSessionId))
          throw new PermissionUnavailableError(input.rootSessionId);
      }
      input.signal?.throwIfAborted();
      return permissionProjection.getSnapshot(input.rootSessionId);
    },
    async getSnapshot(): Promise<UiSnapshot> {
      return { ...(await readSnapshotWithPermission()), serverNow: Date.now() };
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

    submitPromptAndWait(
      text: string,
      submitOptions?: UiSubmitPromptAndWaitOptions,
    ): Promise<UiPromptCompletion> {
      return submitPromptAndWaitInternal(text, {
        ...submitOptions,
        namingSource: publicNamingSource(submitOptions?.namingSource),
      });
    },

    submitPromptAccepted(
      text: string,
      submitOptions?: SubmitPromptOptions,
    ): Promise<UiPromptReceipt> {
      // Public naming hints are not evidence that the backend loaded a skill.
      return submitPromptAcceptedInternal(text, {
        ...submitOptions,
        namingSource: publicNamingSource(submitOptions?.namingSource),
      });
    },

    async steerQueuedPrompt(
      input: UiSteerQueuedPromptInput,
    ): Promise<UiSteerQueuedPromptResult> {
      return this.steerQueuedPromptForOwner(input, promptQueueOwnerClientId);
    },
    async steerQueuedPromptForOwner(
      input: UiSteerQueuedPromptInput,
      _trustedOwnerClientId: string,
    ): Promise<UiSteerQueuedPromptResult> {
      await ready;
      const prompt = await promptScheduler.get(input.promptId);
      if (!prompt)
        throw Object.assign(new Error("Prompt not found"), {
          code: "PROMPT_NOT_FOUND",
        });
      await validatePermissionRoot(prompt.sessionId);
      const result = await promptScheduler.steerQueued({
        ...input,
        sessionId: prompt.sessionId,
        scopeKey: promptScopeKey,
      });
      return result.status === "steered"
        ? { status: "steered", receipt: result.receipt }
        : { status: "not-steered", reason: result.reason };
    },

    resendSteerInput(input): Promise<UiPromptReceipt> {
      return this.resendSteerInputForOwner(input, promptQueueOwnerClientId);
    },
    resendSteerInputForOwner(
      input,
      _trustedOwnerClientId,
      expectedSessionId,
    ): Promise<UiPromptReceipt> {
      return withSessionAdmission("read", async () => {
        await ready;
        if (!input.operationId.trim())
          throw permissionError(
            "INVALID_OPERATION_ID",
            "Resend operationId must not be empty",
          );
        const source = await currentRunInputStore?.getInput(input.inputId);
        if (
          source?.source !== "user-steer" ||
          source.contextScopeId !== undefined
        )
          throw permissionError(
            "STEER_INPUT_NOT_FOUND",
            "Steered input not found",
          );
        await validatePermissionRoot(source.sessionId);
        if (
          expectedSessionId !== undefined &&
          source.sessionId !== expectedSessionId
        )
          throw permissionError(
            "SESSION_SCOPE_CHANGED",
            "Steered input belongs to another session",
          );
        await enterSession(source.sessionId);
        const original = await promptScheduler.get(source.sourceId);
        if (
          original?.scopeKey !== promptScopeKey ||
          original.sessionId !== source.sessionId
        )
          throw permissionError(
            "STEER_INPUT_NOT_FOUND",
            "Original prompt not found",
          );
        const clientRequestId = `resend:${input.operationId}`;
        const existing =
          await promptScheduler.getByClientRequestId(clientRequestId);
        const current = await currentRunInputStore?.getInput(input.inputId);
        const run = await sourceLedger.get(source.runId);
        if (
          !existing &&
          (!current ||
            current.processedRequestId !== undefined ||
            (current.closedAt === undefined &&
              (!run || run.status === "pending" || run.status === "running")))
        )
          throw permissionError(
            "STEER_INPUT_NOT_RECOVERABLE",
            "Input has not closed or already has a successful processing record",
          );
        const message = (
          await messageManager.listByIds(source.sessionId, [source.messageId])
        ).at(0);
        if (
          message?.info.role !== "user" ||
          message.info.contextScopeId !== undefined
        )
          throw permissionError(
            "STEER_INPUT_NOT_FOUND",
            "Original input message unavailable",
          );
        const text = message.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
        return submitPromptAcceptedWork(
          text,
          {
            sessionId: source.sessionId,
            clientRequestId,
            ...(text === original.text &&
            message.parts.some(
              (part) =>
                part.type === "text" &&
                slashSkillName(part) === original.namingSource?.skillName,
            )
              ? { namingSource: original.namingSource }
              : {}),
          },
          source.sourceId,
        );
      });
    },

    resubmitRetainedPrompt(input): Promise<UiPromptResubmissionReceipt> {
      return this.resubmitRetainedPromptForOwner(
        input,
        promptQueueOwnerClientId,
      );
    },
    async resubmitRetainedPromptForOwner(
      input,
      trustedOwnerClientId,
    ): Promise<UiPromptResubmissionReceipt> {
      await ready;
      const prompt = await promptScheduler.get(input.promptId);
      if (!prompt)
        throw Object.assign(new Error("Prompt not found"), {
          code: "PROMPT_NOT_FOUND",
        });
      await validatePermissionRoot(prompt.sessionId);
      return promptScheduler.resubmitRetained({
        ...input,
        ownerClientId: trustedOwnerClientId,
      });
    },

    async editQueuedPrompt(
      input: UiEditQueuedPromptInput,
    ): Promise<UiPromptSubmission> {
      return this.editQueuedPromptForOwner(input, promptQueueOwnerClientId);
    },

    async editQueuedPromptForOwner(
      input: UiEditQueuedPromptInput,
      trustedOwnerClientId: string,
    ): Promise<UiPromptSubmission> {
      return promptRecordToUi(
        await promptScheduler.commitEdit(
          input.promptId,
          input.editLeaseId,
          input.text,
          trustedOwnerClientId,
        ),
      );
    },

    async cancelQueuedPrompt(
      input: UiCancelQueuedPromptInput,
    ): Promise<UiPromptSubmission> {
      return this.cancelQueuedPromptForOwner(input, promptQueueOwnerClientId);
    },

    async cancelQueuedPromptForOwner(
      input: UiCancelQueuedPromptInput,
      trustedOwnerClientId: string,
    ): Promise<UiPromptSubmission> {
      return promptRecordToUi(
        await promptScheduler.cancelQueued(
          input.promptId,
          input.editLeaseId,
          trustedOwnerClientId,
        ),
      );
    },

    async acquirePromptEditLease(input): Promise<UiPromptEditLease> {
      return this.acquirePromptEditLeaseForOwner(
        input,
        promptQueueOwnerClientId,
      );
    },

    async acquirePromptEditLeaseForOwner(
      input,
      trustedOwnerClientId,
    ): Promise<UiPromptEditLease> {
      const lease = await promptScheduler.acquireEditLease(
        input.promptId,
        trustedOwnerClientId,
      );
      return {
        editLeaseId: lease.editLeaseId,
        ownerClientId: lease.ownerClientId,
        expiresAt: new Date(lease.expiresAt).toISOString(),
        prompt: promptRecordToUi(lease.prompt),
      };
    },

    async renewPromptEditLease(input): Promise<UiPromptEditLease> {
      return this.renewPromptEditLeaseForOwner(input, promptQueueOwnerClientId);
    },

    async renewPromptEditLeaseForOwner(
      input,
      trustedOwnerClientId,
    ): Promise<UiPromptEditLease> {
      const lease = await promptScheduler.renewEditLease(
        input.promptId,
        input.editLeaseId,
        trustedOwnerClientId,
      );
      return {
        editLeaseId: lease.editLeaseId,
        ownerClientId: lease.ownerClientId,
        expiresAt: new Date(lease.expiresAt).toISOString(),
        prompt: promptRecordToUi(lease.prompt),
      };
    },

    async releasePromptEditLease(input): Promise<UiPromptSubmission> {
      return this.releasePromptEditLeaseForOwner(
        input,
        promptQueueOwnerClientId,
      );
    },

    async releasePromptEditLeaseForOwner(
      input,
      trustedOwnerClientId,
    ): Promise<UiPromptSubmission> {
      return promptRecordToUi(
        await promptScheduler.releaseEditLease(
          input.promptId,
          input.editLeaseId,
          trustedOwnerClientId,
        ),
      );
    },

    waitForPrompt(
      promptId: string,
      waitOptions?: UiWaitForPromptOptions,
    ): Promise<UiPromptCompletion> {
      return waitForPromptInternal(promptId, waitOptions);
    },

    compactSession(
      compactOptions?: UiCompactSessionOptions,
    ): Promise<UiCompactSessionResult> {
      return compactSessionInternal(compactOptions);
    },

    updateSessionReasoning: updateSessionReasoningInternal,
    updateSessionModel: updateSessionModelInternal,
    async selectDefaultModel(entryId) {
      const result = await selectModelEntry(entryId);
      await publishModelInvalidation();
      return { ...result, ok: true };
    },

    archiveSession(input: UiArchiveSessionInput): Promise<void> {
      return archiveSessionInternal(input);
    },

    async exportSession(input): ReturnType<UiBackendClient["exportSession"]> {
      if (!options.sessionManager) {
        throw new Error("Session storage is not available");
      }
      return exportSession(
        {
          sessionManager: options.sessionManager,
          messageManager,
          appVersion: getAgentPackageVersion(),
          now: options.now,
        },
        input,
      );
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

    getCurrentModel(input): Promise<UiCurrentModelConfig | null> {
      return currentConnectModelFromOptions(
        input?.sessionId,
        input?.modelEntryId,
      );
    },

    executeCommand(
      invocation: UiCommandInvocation,
      execution?: { readonly signal?: AbortSignal },
    ): ReturnType<UiBackendClient["executeCommand"]> {
      return commandService.executeCommand(invocation, execution);
    },

    respondPermission(
      requestId: string,
      response: UiPermissionResponse,
      context?: {
        readonly rootSessionId: string | null;
        readonly permissionEpoch: string;
        readonly bindingGeneration?: number;
      },
    ): Promise<void> {
      try {
        const choice = toCorePermissionResponse(response);
        const identity =
          permission.getPending(requestId) ?? permission.getTerminal(requestId);
        if (!identity)
          throw permissionError(
            "PERMISSION_NOT_PENDING",
            "Permission is no longer pending",
          );
        if (
          context &&
          (context.permissionEpoch !== permissionProjection.permissionEpoch ||
            context.rootSessionId !== identity.rootSessionId)
        ) {
          throw permissionError(
            "PERMISSION_SCOPE_CHANGED",
            "Permission scope changed",
          );
        }
        if (!permission.isHealthy(identity.rootSessionId))
          throw new PermissionUnavailableError(identity.rootSessionId);
        const result = permission.respond(
          identity.sessionId,
          requestId,
          choice,
        );
        if (result === "revoked" || result === "not-pending")
          throw permissionError(
            "PERMISSION_NOT_PENDING",
            "Permission is no longer pending",
          );
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },

    respondInteraction(
      interactionId: string,
      response: UiInteractionResponse,
    ): Promise<void> {
      return interactionBroker.respond(interactionId, response);
    },

    async abortRun(runId: string): Promise<void> {
      if (!(await runtimeController.abortPromptRun(runId)))
        throw Object.assign(new Error("The requested run has already ended"), {
          code: "SESSION_SCOPE_CHANGED",
        });
    },
  };
}
