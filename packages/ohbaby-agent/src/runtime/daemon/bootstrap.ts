import { Bus } from "../../bus/index.js";
import { createInMemoryRunLedger } from "../run-ledger/index.js";
import type { RunLedger } from "../run-ledger/index.js";
import {
  RunManager,
  type ProfileRegistry,
  type RunDefaultsPolicy,
} from "../run-manager/index.js";
import { createInMemoryStreamBridge } from "../stream-bridge/index.js";
import type { StreamBridge } from "../stream-bridge/index.js";
import { startAppEventAdapter } from "./app-events.js";
import { startCommandEventAdapter } from "./command-events.js";
import { DaemonBootstrapError } from "./errors.js";
import type {
  BootstrappedRuntime,
  DaemonDatabase,
  DaemonEventAdapter,
  DaemonInteractionBroker,
  DaemonLifecycleComponent,
  DaemonRunManager,
  DaemonTaskManager,
  RuntimeBootstrapOptions,
} from "./types.js";

const STOP_REASON = "daemon-stopping";

const DEFAULT_POLICY: RunDefaultsPolicy = {
  defaults: {
    user: {
      permissionProfileId: "interactive",
      multitaskStrategy: "reject",
      disconnectMode: "continue",
    },
    scheduler: {
      permissionProfileId: "read-only",
      multitaskStrategy: "reject",
      disconnectMode: "continue",
    },
    heartbeat: {
      permissionProfileId: "notify-only",
      multitaskStrategy: "reject",
      disconnectMode: "continue",
    },
    channel: {
      permissionProfileId: "notify-only",
      multitaskStrategy: "reject",
      disconnectMode: "continue",
    },
    "follow-up": {
      permissionProfileId: "full-auto",
      multitaskStrategy: "reject",
      disconnectMode: "continue",
    },
  },
};

const DEFAULT_PROFILE_REGISTRY: ProfileRegistry = {
  getProfile(id: string) {
    return { id };
  },
};

const NOOP_LIFECYCLE_COMPONENT: DaemonLifecycleComponent = {};
const NOOP_INTERACTION_BROKER: DaemonInteractionBroker = {
  abortAll(): void {
    return undefined;
  },
};
const NOOP_TASK_MANAGER: DaemonTaskManager = {
  stopAll(): void {
    return undefined;
  },
};

function createRunManager(
  options: RuntimeBootstrapOptions,
  runLedger: RunLedger,
  streamBridge: StreamBridge,
): DaemonRunManager {
  if (options.runManager) {
    return options.runManager;
  }
  if (!options.lifecycle) {
    throw new DaemonBootstrapError(
      "runtime daemon bootstrap requires lifecycle when runManager is not provided",
    );
  }

  return new RunManager({
    lifecycle: options.lifecycle,
    runLedger,
    streamBridge,
    hookExecutor: options.hookExecutor,
    sandboxManager: options.sandboxManager,
    profileRegistry: options.profileRegistry ?? DEFAULT_PROFILE_REGISTRY,
    policy: options.policy ?? DEFAULT_POLICY,
    now: options.now,
    createRunId: options.createRunId,
  });
}

async function startComponent(
  component: DaemonLifecycleComponent,
): Promise<void> {
  await component.start?.();
}

async function stopComponent(
  component: DaemonLifecycleComponent,
): Promise<void> {
  await component.stop?.();
}

async function disposeAdapter(
  adapter: DaemonEventAdapter | undefined,
): Promise<void> {
  await adapter?.dispose();
}

async function closeStreamBridge(streamBridge: StreamBridge): Promise<void> {
  const maybeClosable = streamBridge as StreamBridge & {
    close?: () => Promise<void> | void;
  };

  if (typeof maybeClosable.close === "function") {
    await maybeClosable.close();
    return;
  }

  streamBridge.end("app");
}

async function closeDatabase(
  database: DaemonDatabase | undefined,
): Promise<void> {
  await database?.close();
}

async function runCleanupSteps(
  steps: readonly (() => Promise<void>)[],
): Promise<void> {
  let firstError: unknown;

  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      firstError ??= error;
    }
  }

  if (firstError !== undefined) {
    if (firstError instanceof Error) {
      throw firstError;
    }
    throw new Error("Daemon cleanup failed", { cause: firstError });
  }
}

export function bootstrapRuntime(
  options: RuntimeBootstrapOptions,
): BootstrappedRuntime {
  const bus = options.bus ?? Bus;
  const runLedger = options.runLedger ?? createInMemoryRunLedger();
  const streamBridge = options.streamBridge ?? createInMemoryStreamBridge();
  const runManager = createRunManager(options, runLedger, streamBridge);
  const scheduler = options.scheduler ?? NOOP_LIFECYCLE_COMPONENT;
  const heartbeat = options.heartbeat ?? NOOP_LIFECYCLE_COMPONENT;
  const interactionBroker =
    options.interactionBroker ?? NOOP_INTERACTION_BROKER;
  const taskManager = options.taskManager ?? NOOP_TASK_MANAGER;
  let appEvents: DaemonEventAdapter | undefined;
  let commandEvents: DaemonEventAdapter | undefined;
  let started = false;
  let stopping: Promise<void> | undefined;

  async function start(): Promise<void> {
    if (started) {
      return;
    }

    started = true;
    try {
      await runManager.init();
      await startComponent(scheduler);
      await startComponent(heartbeat);
      appEvents = (options.startAppEventAdapter ?? startAppEventAdapter)({
        bus,
        streamBridge,
        eventDefinitions: options.appEventDefinitions,
      });
      commandEvents = (
        options.startCommandEventAdapter ?? startCommandEventAdapter
      )({
        bus,
        streamBridge,
        eventDefinitions: options.commandEventDefinitions,
      });
    } catch (error) {
      await stop().catch(() => undefined);
      throw error;
    }
  }

  async function stop(): Promise<void> {
    if (stopping) {
      return stopping;
    }
    if (!started) {
      return;
    }

    stopping = (async (): Promise<void> => {
      try {
        await runCleanupSteps([
          (): Promise<void> => stopComponent(heartbeat),
          (): Promise<void> => stopComponent(scheduler),
          (): Promise<void> => runManager.cancelAll(STOP_REASON),
          (): Promise<void> =>
            Promise.resolve(interactionBroker.abortAll(STOP_REASON)),
          (): Promise<void> => Promise.resolve(taskManager.stopAll()),
          (): Promise<void> => disposeAdapter(commandEvents),
          (): Promise<void> => disposeAdapter(appEvents),
          (): Promise<void> => closeStreamBridge(streamBridge),
          (): Promise<void> => closeDatabase(options.database),
        ]);
      } finally {
        commandEvents = undefined;
        appEvents = undefined;
        started = false;
        stopping = undefined;
      }
    })();

    return stopping;
  }

  return {
    bus,
    runLedger,
    streamBridge,
    runManager,
    scheduler,
    heartbeat,
    interactionBroker,
    taskManager,
    database: options.database,
    start,
    stop,
  };
}
