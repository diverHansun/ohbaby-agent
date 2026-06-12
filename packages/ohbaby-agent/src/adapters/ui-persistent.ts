import { randomUUID } from "node:crypto";
import path from "node:path";
import type { UiBackendClient } from "ohbaby-sdk";
import { createBus, type BusInstance } from "../bus/index.js";
import {
  createDatabaseMessageStore,
  createMessageManager,
} from "../core/message/index.js";
import { Project } from "../project/index.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
  schema,
  type DatabaseConnection,
} from "../services/database/index.js";
import {
  createDatabaseSessionStore,
  createSessionManager,
} from "../services/session/index.js";
import {
  createDatabaseRunLedger,
  SessionRunBusyError,
} from "../runtime/run-ledger/index.js";
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

export interface PersistentUiBackendClient extends UiBackendClient {
  dispose(): Promise<void> | void;
}

function numericNow(now?: () => Date): () => number {
  return () => (now?.() ?? new Date()).getTime();
}

const BACKEND_LEASE_SCOPE = "global";
const BACKEND_LEASE_KEY = "persistentUiBackendLease";

interface BackendLease {
  readonly ownerId: string;
  readonly pid: number;
  readonly state?: "idle" | "preparing";
  readonly updatedAt: number;
}

interface BackendLeaseRow {
  readonly value: string;
}

interface ActiveRunCountRow {
  readonly count: number;
}

interface ActiveRunRow {
  readonly runId: string;
}

function createBackendOwnerId(): string {
  return `backend_${String(process.pid)}_${randomUUID()}`;
}

function isBackendLease(value: unknown): value is BackendLease {
  return (
    typeof value === "object" &&
    value !== null &&
    "ownerId" in value &&
    typeof value.ownerId === "string" &&
    "pid" in value &&
    typeof value.pid === "number" &&
    "updatedAt" in value &&
    typeof value.updatedAt === "number"
  );
}

function parseBackendLease(value: string): BackendLease | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isBackendLease(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EPERM"
    );
  }
}

function readBackendLease(db: DatabaseConnection): BackendLease | undefined {
  const row = db
    .prepare<BackendLeaseRow>(
      `SELECT value FROM ${schema.appState.tableName}
       WHERE scope = ? AND key = ?`,
    )
    .get(BACKEND_LEASE_SCOPE, BACKEND_LEASE_KEY);
  return row ? parseBackendLease(row.value) : undefined;
}

function writeBackendLease(input: {
  readonly db: DatabaseConnection;
  readonly now: () => number;
  readonly ownerId: string;
  readonly state?: BackendLease["state"];
}): void {
  const updatedAt = input.now();
  const lease: BackendLease = {
    ownerId: input.ownerId,
    pid: process.pid,
    state: input.state ?? "idle",
    updatedAt,
  };
  input.db
    .prepare(
      `INSERT INTO ${schema.appState.tableName} (scope, key, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(scope, key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    )
    .run(
      BACKEND_LEASE_SCOPE,
      BACKEND_LEASE_KEY,
      JSON.stringify(lease),
      updatedAt,
    );
}

function countActiveRuns(db: DatabaseConnection): number {
  return (
    db
      .prepare<ActiveRunCountRow>(
        `SELECT COUNT(*) as count FROM ${schema.runLedger.tableName}
         WHERE status IN ('pending', 'running')`,
      )
      .get()?.count ?? 0
  );
}

function listActiveRunIds(db: DatabaseConnection): readonly string[] {
  return db
    .prepare<ActiveRunRow>(
      `SELECT run_id as runId FROM ${schema.runLedger.tableName}
       WHERE status IN ('pending', 'running')
       ORDER BY created_at ASC, run_id ASC`,
    )
    .all()
    .map((row) => row.runId);
}

function refreshBackendLeaseIfSafe(input: {
  readonly db: DatabaseConnection;
  readonly now: () => number;
  readonly ownerId: string;
  readonly state?: BackendLease["state"];
}): {
  readonly activeRunCount: number;
  readonly activeRunIds: readonly string[];
  readonly acquired: boolean;
  readonly liveOwner: boolean;
} {
  input.db.exec("BEGIN IMMEDIATE");
  try {
    const activeRunCount = countActiveRuns(input.db);
    const previousLease = readBackendLease(input.db);
    const liveOwner = isProcessAlive(previousLease?.pid ?? -1);
    const preparingOwner =
      liveOwner &&
      previousLease?.state === "preparing" &&
      previousLease.ownerId !== input.ownerId;
    const acquired =
      !liveOwner ||
      (activeRunCount === 0 && !preparingOwner) ||
      previousLease?.ownerId === input.ownerId;
    if (acquired) {
      writeBackendLease(input);
    }
    const activeRunIds = acquired ? [] : listActiveRunIds(input.db);
    input.db.exec("COMMIT");
    return { activeRunCount, activeRunIds, acquired, liveOwner };
  } catch (error) {
    try {
      input.db.exec("ROLLBACK");
    } catch {
      // Keep the original startup recovery failure.
    }
    throw error;
  }
}

function shouldRecoverStartupRuns(input: {
  readonly db: DatabaseConnection;
  readonly now: () => number;
  readonly ownerId: string;
}): boolean {
  const leaseState = refreshBackendLeaseIfSafe(input);
  return leaseState.activeRunCount > 0 && !leaseState.liveOwner;
}

function releaseBackendLeasePreparation(input: {
  readonly db: DatabaseConnection;
  readonly now: () => number;
  readonly ownerId: string;
}): void {
  input.db.exec("BEGIN IMMEDIATE");
  try {
    const previousLease = readBackendLease(input.db);
    if (previousLease?.ownerId === input.ownerId) {
      writeBackendLease({ ...input, state: "idle" });
    }
    input.db.exec("COMMIT");
  } catch (error) {
    try {
      input.db.exec("ROLLBACK");
    } catch {
      // Keep the original lease release failure.
    }
    throw error;
  }
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
  async function ready(): Promise<void> {
    await recovery;
  }

  return {
    dispose(): ReturnType<InProcessUiBackendClient["dispose"]> {
      client.dispose();
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
    async submitPrompt(
      text,
      submitOptions,
    ): ReturnType<UiBackendClient["submitPrompt"]> {
      await ready();
      return client.submitPrompt(text, submitOptions);
    },
    async compactSession(
      compactOptions,
    ): ReturnType<UiBackendClient["compactSession"]> {
      await ready();
      return client.compactSession(compactOptions);
    },
    async connectModel(input): ReturnType<UiBackendClient["connectModel"]> {
      await ready();
      return client.connectModel(input);
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
    async respondPermission(
      requestId,
      response,
    ): ReturnType<UiBackendClient["respondPermission"]> {
      await ready();
      return client.respondPermission(requestId, response);
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

async function resolvePersistentStartupSession(input: {
  readonly mode: StartupSessionMode;
  readonly stateStore: ReturnType<typeof createPersistentUiStateStore>;
  readonly sessionManager: ReturnType<typeof createSessionManager>;
}): Promise<void> {
  if (input.mode.type === "fresh") {
    return;
  }
  const candidates = (await input.sessionManager.getRecent()).map(
    (session) => ({
      id: session.id,
      kind: session.isSubagent ? ("temporary" as const) : ("primary" as const),
      updatedAt: session.updatedAt,
    }),
  );
  const sessionId = resolveStartupSession(input.mode, candidates);
  if (sessionId === null) {
    return;
  }
  const session = await input.stateStore.getSession(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
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
  const runLedger = createDatabaseRunLedger({ db, now });
  const startupSessionMode = resolveStartupSessionMode(options);
  const stateStore = createPersistentUiStateStore({
    initialActiveSessionId: null,
    messageManager,
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
  const backendOwnerId = createBackendOwnerId();
  const startupRecovery = shouldRecoverStartupRuns({
    db,
    now,
    ownerId: backendOwnerId,
  })
    ? runLedger.markInterrupted({
        statuses: ["pending", "running"],
      })
    : Promise.resolve({ updatedCount: 0 });
  const startupReady = startupRecovery.then(async () => {
    await resolvePersistentStartupSession({
      mode: startupSessionMode,
      sessionManager,
      stateStore,
    });
  });

  return withStartupRecovery(
    createInProcessUiBackendClient({
      afterPromptSubmitSettled: () => {
        releaseBackendLeasePreparation({
          db,
          now,
          ownerId: backendOwnerId,
        });
      },
      agentManager: options.agentManager,
      beforePromptSubmit: async () => {
        const leaseState = refreshBackendLeaseIfSafe({
          db,
          now,
          ownerId: backendOwnerId,
          state: "preparing",
        });
        if (!leaseState.acquired) {
          throw new SessionRunBusyError(
            "persistent-backend",
            leaseState.activeRunIds,
          );
        }
        if (leaseState.activeRunCount > 0 && !leaseState.liveOwner) {
          await runLedger.markInterrupted({
            statuses: ["pending", "running"],
          });
        }
      },
      bus,
      ...(options.createAgentTaskId
        ? { createAgentTaskId: options.createAgentTaskId }
        : {}),
      createLLMClient: options.createLLMClient,
      createRunId: options.createRunId,
      hookExecutor,
      initialSnapshot: options.initialSnapshot,
      llmClient: options.llmClient,
      messageManager,
      now: options.now,
      projectDirectory: options.projectDirectory,
      runLedger,
      sessionManager,
      stateStore,
      streamBridge: options.streamBridge,
      workdir: options.workdir,
    }),
    startupReady,
  );
}

export { closeDatabase as closePersistentUiBackendDatabase };
