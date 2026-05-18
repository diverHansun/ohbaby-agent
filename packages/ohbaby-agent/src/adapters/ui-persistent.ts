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
  type DatabaseConnection,
} from "../services/database/index.js";
import { createStorage } from "../services/storage/index.js";
import {
  createDatabaseSessionStore,
  createSessionManager,
} from "../services/session/index.js";
import { createDatabaseRunLedger } from "../runtime/run-ledger/index.js";
import type { HookExecutor } from "../runtime/run-manager/index.js";
import {
  createSnapshotHookExecutor,
  ShadowDiffEngine,
  SnapshotService,
  SnapshotStore,
} from "../snapshot/index.js";
import type { SnapshotHookExecutorOptions } from "../snapshot/index.js";
import { createInProcessUiBackendClient } from "./ui-inprocess.js";
import type { InProcessUiBackendOptions } from "./ui-inprocess.js";
import {
  createDatabaseUiAppStateStore,
  createPersistentUiStateStore,
} from "./ui-state/index.js";

export interface PersistentUiBackendOptions
  extends Omit<
    InProcessUiBackendOptions,
    "bus" | "hookExecutor" | "messageManager" | "runLedger" | "sessionManager" | "stateStore"
  > {
  readonly bus?: BusInstance;
  readonly dbPath?: string;
  readonly enableSnapshots?: boolean;
  readonly hookExecutor?: HookExecutor;
  readonly snapshotService?: SnapshotService;
  readonly storageRoot?: string;
}

function numericNow(now?: () => Date): () => number {
  return () => (now?.() ?? new Date()).getTime();
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
      for (const executor of active) {
        await executor.execute(point, context);
      }
    },
  };
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
    diffEngine: new ShadowDiffEngine(),
    now: input.now,
    store: new SnapshotStore({
      db: input.db,
      storage: createStorage({
        rootDir: input.storageRoot,
      }),
    }),
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

export function createPersistentUiBackendClient(
  options: PersistentUiBackendOptions = {},
): UiBackendClient {
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
    projectResolver: Project,
    store: createDatabaseSessionStore({ db }),
  });
  const runLedger = createDatabaseRunLedger({ db, now });
  const stateStore = createPersistentUiStateStore({
    appState: createDatabaseUiAppStateStore({ db, now }),
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

  return createInProcessUiBackendClient({
    agentManager: options.agentManager,
    bus,
    createLLMClient: options.createLLMClient,
    createRunId: options.createRunId,
    hookExecutor,
    llmClient: options.llmClient,
    messageManager,
    now: options.now,
    projectDirectory: options.projectDirectory,
    runLedger,
    sessionManager,
    stateStore,
    streamBridge: options.streamBridge,
    workdir: options.workdir,
  });
}

export { closeDatabase as closePersistentUiBackendDatabase };
