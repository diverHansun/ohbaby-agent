import { randomUUID } from "node:crypto";
import path from "node:path";
import type { UiBackendClient } from "ohbaby-sdk";
import { createBus, type BusInstance } from "../bus/index.js";
import {
  DatabaseSubagentExecutionStore,
  DatabaseSubagentInstanceStore,
} from "../agents/index.js";
import {
  createDatabaseMessageStore,
  createMessageManager,
} from "../core/message/index.js";
import { Project } from "../project/index.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
  type DatabaseConnection,
} from "../services/database/index.js";
import {
  createDatabaseSessionStore,
  createSessionManager,
} from "../services/session/index.js";
import { createSqliteGoalPersistence } from "../goals/index.js";
import { createDatabaseRunLedger } from "../runtime/run-ledger/index.js";
import {
  DatabaseCurrentRunInputStore,
  DatabasePromptSubmissionStore,
} from "../runtime/prompt-scheduler/index.js";
import type { HookExecutor } from "../runtime/run-manager/index.js";
import {
  createSnapshotHookExecutor,
  GitSnapshotEngine,
  SnapshotHookExecutionError,
  SnapshotService,
  SnapshotStore,
} from "../snapshot/index.js";
import type { SnapshotHookExecutorOptions } from "../snapshot/index.js";
import { createInProcessUiBackendClient } from "./ui-inprocess.js";
import type {
  InProcessUiBackendClient,
  InProcessUiBackendOptions,
  UiPromptQueueExecutionPort,
} from "./ui-inprocess.js";
import { createPersistentUiStateStore } from "./ui-state/index.js";
import {
  resolveStartupSession,
  type StartupSessionMode,
} from "./ui-startup-session.js";

export interface PersistentUiBackendOptions extends Omit<
  InProcessUiBackendOptions,
  | "afterPromptSubmitSettled"
  | "bus"
  | "beforePromptSubmit"
  | "goalPersistence"
  | "hookExecutor"
  | "messageManager"
  | "runLedger"
  | "sessionManager"
  | "stateStore"
> {
  readonly bus?: BusInstance;
  readonly dbPath?: string;
  readonly enableSnapshots?: boolean;
  readonly hookExecutor?: HookExecutor;
  readonly snapshotService?: SnapshotService;
  readonly storageRoot?: string;
  readonly resumeSessionId?: string;
  readonly startupSessionMode?: StartupSessionMode;
}

export interface PersistentUiBackendClient
  extends UiBackendClient, UiPromptQueueExecutionPort {
  listSubagentExecutions: NonNullable<UiBackendClient["listSubagentExecutions"]>;
  getSubagentExecutionView: NonNullable<UiBackendClient["getSubagentExecutionView"]>;
  initialize(): Promise<void>;
  initializeSession(sessionId: string): Promise<void>;
  dispose(): Promise<void> | void;
}

function numericNow(now?: () => Date): () => number {
  return () => (now?.() ?? new Date()).getTime();
}

function createBackendOwnerId(): string {
  return `backend_${String(process.pid)}_${randomUUID()}`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function composeHookExecutors(
  executors: readonly (HookExecutor | undefined)[],
): HookExecutor | undefined {
  const active = executors.filter(
    (executor): executor is HookExecutor => executor !== undefined,
  );
  if (active.length === 0) {
    return undefined;
  }
  if (active.length === 1) {
    return active[0];
  }

  return {
    async execute(point, context): Promise<void> {
      let firstError: Error | undefined;
      let snapshotError: SnapshotHookExecutionError | undefined;
      for (const executor of active) {
        try {
          await executor.execute(point, context);
        } catch (error) {
          const normalized = toError(error);
          firstError ??= normalized;
          if (
            snapshotError === undefined &&
            normalized instanceof SnapshotHookExecutionError
          ) {
            snapshotError = normalized;
          }
        }
      }
      if (snapshotError !== undefined) {
        throw snapshotError;
      }
      if (firstError !== undefined) {
        throw firstError;
      }
    },
  };
}

function resolveSnapshotRoot(
  storageRoot: string | undefined,
): string | undefined {
  return storageRoot === undefined
    ? undefined
    : path.dirname(path.resolve(storageRoot));
}

function createDefaultSnapshotService(input: {
  readonly db: DatabaseConnection;
  readonly runLedger: ReturnType<typeof createDatabaseRunLedger>;
  readonly storageRoot?: string;
  readonly now: () => number;
}): SnapshotService {
  return new SnapshotService({
    activeWriterChecker: async ({ checkpoint }) =>
      (await input.runLedger.getActiveRuns(checkpoint.sessionId)).some(
        (run) => run.runId !== checkpoint.runId,
      ),
    diffEngine: new GitSnapshotEngine({
      snapshotRoot: resolveSnapshotRoot(input.storageRoot),
    }),
    now: input.now,
    store: new SnapshotStore({ db: input.db }),
  });
}

function createSnapshotExecutor(input: {
  readonly db: DatabaseConnection;
  readonly enabled: boolean;
  readonly now: () => number;
  readonly runLedger: ReturnType<typeof createDatabaseRunLedger>;
  readonly service?: SnapshotService;
  readonly storageRoot?: string;
}): HookExecutor | undefined {
  if (!input.enabled) {
    return undefined;
  }

  const service =
    input.service ??
    createDefaultSnapshotService({
      db: input.db,
      now: input.now,
      runLedger: input.runLedger,
      storageRoot: input.storageRoot,
    });
  const options: SnapshotHookExecutorOptions = {
    service,
    workspaceSource: "sandbox",
  };
  return createSnapshotHookExecutor(options);
}

function withStartupRecovery(
  client: InProcessUiBackendClient,
  recovery: Promise<unknown>,
): PersistentUiBackendClient {
  let recovered = false;
  let startupFailureReported = false;
  const startup = recovery.then(() => {
    recovered = true;
  });
  async function ready(): Promise<void> {
    try {
      await startup;
    } catch (error) {
      startupFailureReported = true;
      throw error;
    }
  }

  return {
    async listSubagentExecutions(input) {
      await ready();
      return client.listSubagentExecutions(input);
    },
    async getSubagentExecutionView(input) {
      await ready();
      return client.getSubagentExecutionView(input);
    },
    async getSessionView(
      input,
    ): ReturnType<InProcessUiBackendClient["getSessionView"]> {
      await ready();
      return client.getSessionView(input);
    },
    async getSessionHistory(
      input,
    ): ReturnType<InProcessUiBackendClient["getSessionHistory"]> {
      await ready();
      return client.getSessionHistory(input);
    },
    async getSessionControl(
      input,
    ): ReturnType<InProcessUiBackendClient["getSessionControl"]> {
      await ready();
      return client.getSessionControl(input);
    },
    async getPromptReceipt(
      input,
    ): ReturnType<InProcessUiBackendClient["getPromptReceipt"]> {
      await ready();
      return client.getPromptReceipt(input);
    },
    async initializeSession(sessionId): Promise<void> {
      await ready();
      await client.initializeSession(sessionId);
    },
    async initialize(): Promise<void> {
      await ready();
      await client.initialize();
    },
    async dispose(): Promise<void> {
      // Startup owns durable recovery writes even if no public read was made.
      // Drain that owner before callers are allowed to close its database.
      try {
        await startup;
      } catch (error) {
        // Preserve disposal after a failed public initialization/read, while
        // still surfacing startup failures that no caller has observed yet.
        if (!startupFailureReported) throw error;
      } finally {
        await client.dispose();
      }
    },
    async getSessionIndex(): ReturnType<UiBackendClient["getSessionIndex"]> {
      await ready();
      return client.getSessionIndex();
    },
    async getSelectedSessionId(): ReturnType<
      UiBackendClient["getSelectedSessionId"]
    > {
      await ready();
      return client.getSelectedSessionId();
    },
    async createSession(input): ReturnType<UiBackendClient["createSession"]> {
      await ready();
      return client.createSession(input);
    },
    async selectSession(
      sessionId,
    ): ReturnType<UiBackendClient["selectSession"]> {
      await ready();
      return client.selectSession(sessionId);
    },
    async getPermissionSnapshot(
      input,
    ): ReturnType<UiBackendClient["getPermissionSnapshot"]> {
      await ready();
      return client.getPermissionSnapshot(input);
    },
    subscribePermissionEvents(
      handler,
      onError,
    ): ReturnType<UiBackendClient["subscribePermissionEvents"]> {
      return client.subscribePermissionEvents(handler, onError);
    },
    async getSnapshot(): ReturnType<UiBackendClient["getSnapshot"]> {
      await ready();
      return client.getSnapshot();
    },
    async getContextWindowUsage(
      input,
    ): ReturnType<UiBackendClient["getContextWindowUsage"]> {
      await ready();
      return client.getContextWindowUsage(input);
    },
    subscribeEvents(handler): ReturnType<UiBackendClient["subscribeEvents"]> {
      return client.subscribeEvents(handler);
    },
    async listCommands(query): ReturnType<UiBackendClient["listCommands"]> {
      await ready();
      return client.listCommands(query);
    },
    async submitPromptAccepted(
      text,
      submitOptions,
    ): ReturnType<UiBackendClient["submitPromptAccepted"]> {
      await ready();
      return client.submitPromptAccepted(text, submitOptions);
    },
    async submitPromptAndWait(
      text,
      submitOptions,
    ): ReturnType<UiBackendClient["submitPromptAndWait"]> {
      await ready();
      return client.submitPromptAndWait(text, submitOptions);
    },
    async editQueuedPrompt(
      input,
    ): ReturnType<UiBackendClient["editQueuedPrompt"]> {
      await ready();
      return client.editQueuedPrompt(input);
    },
    async editQueuedPromptForOwner(
      input,
      trustedOwnerClientId,
    ): ReturnType<UiPromptQueueExecutionPort["editQueuedPromptForOwner"]> {
      await ready();
      return client.editQueuedPromptForOwner(input, trustedOwnerClientId);
    },
    async steerQueuedPrompt(
      input,
    ): ReturnType<UiBackendClient["steerQueuedPrompt"]> {
      await ready();
      return client.steerQueuedPrompt(input);
    },
    async steerQueuedPromptForOwner(
      input,
      trustedOwnerClientId,
    ): ReturnType<UiPromptQueueExecutionPort["steerQueuedPromptForOwner"]> {
      await ready();
      return client.steerQueuedPromptForOwner(input, trustedOwnerClientId);
    },
    async cancelQueuedPrompt(
      input,
    ): ReturnType<UiBackendClient["cancelQueuedPrompt"]> {
      await ready();
      return client.cancelQueuedPrompt(input);
    },
    async cancelQueuedPromptForOwner(
      input,
      trustedOwnerClientId,
    ): ReturnType<UiPromptQueueExecutionPort["cancelQueuedPromptForOwner"]> {
      await ready();
      return client.cancelQueuedPromptForOwner(input, trustedOwnerClientId);
    },
    async acquirePromptEditLease(
      input,
    ): ReturnType<UiBackendClient["acquirePromptEditLease"]> {
      await ready();
      return client.acquirePromptEditLease(input);
    },
    async acquirePromptEditLeaseForOwner(
      input,
      trustedOwnerClientId,
    ): ReturnType<
      UiPromptQueueExecutionPort["acquirePromptEditLeaseForOwner"]
    > {
      await ready();
      return client.acquirePromptEditLeaseForOwner(input, trustedOwnerClientId);
    },
    async renewPromptEditLease(
      input,
    ): ReturnType<UiBackendClient["renewPromptEditLease"]> {
      await ready();
      return client.renewPromptEditLease(input);
    },
    async renewPromptEditLeaseForOwner(
      input,
      trustedOwnerClientId,
    ): ReturnType<UiPromptQueueExecutionPort["renewPromptEditLeaseForOwner"]> {
      await ready();
      return client.renewPromptEditLeaseForOwner(input, trustedOwnerClientId);
    },
    async releasePromptEditLease(
      input,
    ): ReturnType<UiBackendClient["releasePromptEditLease"]> {
      await ready();
      return client.releasePromptEditLease(input);
    },
    async releasePromptEditLeaseForOwner(
      input,
      trustedOwnerClientId,
    ): ReturnType<
      UiPromptQueueExecutionPort["releasePromptEditLeaseForOwner"]
    > {
      await ready();
      return client.releasePromptEditLeaseForOwner(input, trustedOwnerClientId);
    },
    async waitForPrompt(
      promptId,
      waitOptions,
    ): ReturnType<UiBackendClient["waitForPrompt"]> {
      await ready();
      return client.waitForPrompt(promptId, waitOptions);
    },
    async compactSession(
      compactOptions,
    ): ReturnType<UiBackendClient["compactSession"]> {
      await ready();
      return client.compactSession(compactOptions);
    },
    async updateSessionReasoning(
      input,
    ): ReturnType<UiBackendClient["updateSessionReasoning"]> {
      await ready();
      return client.updateSessionReasoning(input);
    },
    async archiveSession(input): ReturnType<UiBackendClient["archiveSession"]> {
      await ready();
      return client.archiveSession(input);
    },
    async probeModelContextWindow(
      input,
    ): ReturnType<UiBackendClient["probeModelContextWindow"]> {
      await ready();
      return client.probeModelContextWindow(input);
    },
    async connectModel(input): ReturnType<UiBackendClient["connectModel"]> {
      await ready();
      return client.connectModel(input);
    },
    async setSearchApiKey(
      input,
    ): ReturnType<UiBackendClient["setSearchApiKey"]> {
      await ready();
      return client.setSearchApiKey(input);
    },
    async setPermission(input): ReturnType<UiBackendClient["setPermission"]> {
      await ready();
      return client.setPermission(input);
    },
    async getCurrentModel(): ReturnType<UiBackendClient["getCurrentModel"]> {
      await ready();
      return client.getCurrentModel();
    },
    async executeCommand(
      invocation,
    ): ReturnType<UiBackendClient["executeCommand"]> {
      await ready();
      return client.executeCommand(invocation);
    },
    respondPermission(
      requestId,
      response,
      context,
    ): ReturnType<UiBackendClient["respondPermission"]> {
      return recovered
        ? client.respondPermission(requestId, response, context)
        : ready().then(() =>
            client.respondPermission(requestId, response, context),
          );
    },
    async respondInteraction(
      interactionId,
      response,
    ): ReturnType<UiBackendClient["respondInteraction"]> {
      await ready();
      return client.respondInteraction(interactionId, response);
    },
    async abortRun(runId): ReturnType<UiBackendClient["abortRun"]> {
      await ready();
      return client.abortRun(runId);
    },
  };
}

function createPersistentProjectResolver(
  explicitDirectory: string | undefined,
): typeof Project {
  if (!explicitDirectory) {
    return Project;
  }
  const explicitRoot = path.resolve(explicitDirectory);

  return {
    ...Project,
    async fromDirectory(
      directory: string,
    ): ReturnType<typeof Project.fromDirectory> {
      const project = await Project.fromDirectory(directory);
      return path.resolve(directory) === explicitRoot
        ? {
            ...project,
            rootPath: explicitRoot,
          }
        : project;
    },
  };
}

function persistentProjectDirectory(
  options: PersistentUiBackendOptions,
): string {
  return options.workdir ?? options.projectDirectory ?? process.cwd();
}

async function resolvePersistentProjectRoot(
  options: PersistentUiBackendOptions,
): Promise<string> {
  const directory = persistentProjectDirectory(options);
  const project = await Project.fromDirectory(directory);

  return options.workdir || options.projectDirectory
    ? path.resolve(directory)
    : project.rootPath;
}

async function resolvePersistentStartupSession(input: {
  readonly mode: StartupSessionMode;
  readonly projectRoot: string;
  readonly stateStore: ReturnType<typeof createPersistentUiStateStore>;
  readonly sessionManager: ReturnType<typeof createSessionManager>;
}): Promise<void> {
  if (input.mode.type === "fresh") {
    return;
  }
  const candidates = (
    await input.sessionManager.listByProjectRoot(input.projectRoot, {
      status: "active",
    })
  ).map((session) => ({
    id: session.id,
    kind: session.isSubagent ? ("temporary" as const) : ("primary" as const),
    updatedAt: session.updatedAt,
  }));
  const sessionId = resolveStartupSession(input.mode, candidates);
  if (sessionId === null) {
    return;
  }
  const session = (await input.stateStore.getSessionIndex()).find(
    (item) => item.id === sessionId,
  );
  if (!session) {
    throw new Error(`Session not found: ${sessionId} in current project`);
  }
  await input.stateStore.setActiveSessionId(sessionId);
}

function resolveStartupSessionMode(
  options: PersistentUiBackendOptions,
): StartupSessionMode {
  if (options.startupSessionMode !== undefined) {
    return options.startupSessionMode;
  }
  if (options.resumeSessionId !== undefined) {
    return { type: "resume", sessionId: options.resumeSessionId };
  }
  return { type: "fresh" };
}

export function createPersistentUiBackendClient(
  options: PersistentUiBackendOptions = {},
): PersistentUiBackendClient {
  const now = numericNow(options.now);
  initDatabase({ dbPath: options.dbPath, now });
  const db = getDatabase();
  const bus = options.bus ?? createBus();
  const messageManager = createMessageManager({
    bus,
    now,
    store: createDatabaseMessageStore({ db }),
  });
  const sessionManager = createSessionManager({
    bus,
    messageCleaner: {
      removeMessages(sessionId: string): Promise<void> {
        return messageManager.removeMessages(sessionId);
      },
    },
    now,
    projectResolver: createPersistentProjectResolver(
      options.workdir ?? options.projectDirectory,
    ),
    store: createDatabaseSessionStore({ db }),
  });
  const backendOwnerId = createBackendOwnerId();
  const runLedger = createDatabaseRunLedger({
    db,
    now,
    ownerId: backendOwnerId,
    ownerPid: process.pid,
  });
  const subagentInstanceStore = new DatabaseSubagentInstanceStore({ db });
  const subagentExecutionStore = new DatabaseSubagentExecutionStore({ db });
  const startupSessionMode = resolveStartupSessionMode(options);
  const projectRoot = resolvePersistentProjectRoot(options);
  const stateStore = createPersistentUiStateStore({
    initialActiveSessionId: null,
    messageManager,
    projectRoot: () => projectRoot,
    runLedger,
    sessionManager,
  });
  const hookExecutor = composeHookExecutors([
    options.hookExecutor,
    createSnapshotExecutor({
      db,
      enabled: options.enableSnapshots === true,
      now,
      runLedger,
      service: options.snapshotService,
      storageRoot: options.storageRoot,
    }),
  ]);
  const startupRecovery = runLedger.recoverOrphanedRuns();
  const startupReady = startupRecovery.then(async () => {
    await resolvePersistentStartupSession({
      mode: startupSessionMode,
      projectRoot: await projectRoot,
      sessionManager,
      stateStore,
    });
  });

  return withStartupRecovery(
    createInProcessUiBackendClient({
      agentManager: options.agentManager,
      bus,
      ...(options.createSubagentId
        ? { createSubagentId: options.createSubagentId }
        : {}),
      createLLMClient: options.createLLMClient,
      createRunId: options.createRunId,
      createPromptUserMessageId: () => `message_${randomUUID()}`,
      goalPersistence: createSqliteGoalPersistence(db, now),
      hookExecutor,
      initialSnapshot: options.initialSnapshot,
      startupReady,
      llmClient: options.llmClient,
      logger: options.logger,
      diagnosticsFilePath: options.diagnosticsFilePath,
      messageManager,
      now: options.now,
      projectDirectory: options.projectDirectory,
      promptScopeKey: path.resolve(persistentProjectDirectory(options)),
      promptQueueOwnerClientId: backendOwnerId,
      currentRunInputStore: new DatabaseCurrentRunInputStore({ db, now }),
      promptSubmissionStore: new DatabasePromptSubmissionStore({
        db,
        now,
        ownerId: backendOwnerId,
        ownerPid: process.pid,
      }),
      runLedger,
      sessionManager,
      stateStore,
      streamBridge: options.streamBridge,
      subagentInstanceStore,
      subagentExecutionStore,
      subagentOwnerId: backendOwnerId,
      subagentOwnerPid: process.pid,
      workdir: options.workdir,
    }),
    startupReady,
  );
}

export { closeDatabase as closePersistentUiBackendDatabase };
