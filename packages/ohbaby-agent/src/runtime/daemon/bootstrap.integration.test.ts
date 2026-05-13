import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BusEvent, createBus } from "../../bus/index.js";
import type {
  LifecycleEvent,
  LifecycleResult,
} from "../../core/lifecycle/index.js";
import { RunManager, type RunDefaultsPolicy } from "../run-manager/index.js";
import { createInMemoryRunLedger } from "../run-ledger/index.js";
import type { RunLedgerRecord } from "../run-ledger/index.js";
import type {
  StreamBridge,
  StreamBridgeYield,
  StreamScope,
} from "../stream-bridge/index.js";
import { bootstrapRuntime } from "./bootstrap.js";
import type {
  DaemonDatabase,
  DaemonEventAdapterStarter,
  DaemonInteractionBroker,
  DaemonLifecycleComponent,
  DaemonRunManager,
  DaemonTaskManager,
} from "./types.js";

const policy: RunDefaultsPolicy = {
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

class RecordingRunManager implements DaemonRunManager {
  constructor(private readonly calls: string[]) {}

  init(): Promise<{ readonly updatedCount: number }> {
    this.calls.push("runManager.init");
    return Promise.resolve({ updatedCount: 0 });
  }

  cancelAll(): Promise<void> {
    this.calls.push("runManager.cancelAll");
    return Promise.resolve();
  }
}

class RecordingLifecycleComponent implements DaemonLifecycleComponent {
  constructor(
    private readonly label: string,
    private readonly calls: string[],
  ) {}

  start(): Promise<void> {
    this.calls.push(`${this.label}.start`);
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.calls.push(`${this.label}.stop`);
    return Promise.resolve();
  }
}

class RecordingInteractionBroker implements DaemonInteractionBroker {
  constructor(private readonly calls: string[]) {}

  abortAll(reason: string): Promise<void> {
    this.calls.push(`interactionBroker.abortAll:${reason}`);
    return Promise.resolve();
  }
}

class RecordingTaskManager implements DaemonTaskManager {
  constructor(private readonly calls: string[]) {}

  stopAll(): Promise<void> {
    this.calls.push("taskManager.stopAll");
    return Promise.resolve();
  }
}

class RecordingDatabase implements DaemonDatabase {
  constructor(private readonly calls: string[]) {}

  close(): Promise<void> {
    this.calls.push("database.close");
    return Promise.resolve();
  }
}

class RecordingStreamBridge implements StreamBridge {
  readonly published: {
    readonly scope: StreamScope;
    readonly event: string;
    readonly data: unknown;
  }[] = [];

  constructor(private readonly calls: string[]) {}

  publish(_scope: StreamScope, _event: string, _data: unknown): number {
    this.published.push({
      scope: _scope,
      event: _event,
      data: _data,
    });
    return this.published.length;
  }

  subscribe(): AsyncIterable<StreamBridgeYield> {
    throw new Error("subscribe is not used by daemon bootstrap tests");
  }

  end(scope: StreamScope): void {
    this.calls.push(`streamBridge.end:${scope}`);
  }

  close(): Promise<void> {
    this.calls.push("streamBridge.close");
    return Promise.resolve();
  }
}

class CompletingLifecycle {
  async *run(): AsyncGenerator<LifecycleEvent, LifecycleResult, void> {
    await Promise.resolve();
    yield {
      type: "llm:start",
      sessionId: "session_1",
      timestamp: 1,
    };

    return {
      success: true,
      finishReason: "stop",
      finalResponse: "done",
    };
  }
}

class FailingStopComponent implements DaemonLifecycleComponent {
  constructor(private readonly calls: string[]) {}

  start(): Promise<void> {
    this.calls.push("scheduler.start");
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.calls.push("scheduler.stop");
    return Promise.reject(new Error("scheduler stop failed"));
  }
}

function createEventAdapterStarter(
  label: string,
  calls: string[],
): DaemonEventAdapterStarter {
  return () => {
    calls.push(`${label}.start`);
    return {
      dispose(): void {
        calls.push(`${label}.dispose`);
      },
    };
  };
}

describe("bootstrapRuntime", () => {
  it("starts and stops daemon-owned components in documented order", async () => {
    const calls: string[] = [];
    const runtime = bootstrapRuntime({
      runManager: new RecordingRunManager(calls),
      streamBridge: new RecordingStreamBridge(calls),
      scheduler: new RecordingLifecycleComponent("scheduler", calls),
      heartbeat: new RecordingLifecycleComponent("heartbeat", calls),
      interactionBroker: new RecordingInteractionBroker(calls),
      taskManager: new RecordingTaskManager(calls),
      database: new RecordingDatabase(calls),
      startAppEventAdapter: createEventAdapterStarter("appEvents", calls),
      startCommandEventAdapter: createEventAdapterStarter(
        "commandEvents",
        calls,
      ),
    });

    await runtime.start();
    await runtime.stop();

    expect(calls).toEqual([
      "runManager.init",
      "scheduler.start",
      "heartbeat.start",
      "appEvents.start",
      "commandEvents.start",
      "heartbeat.stop",
      "scheduler.stop",
      "runManager.cancelAll",
      "interactionBroker.abortAll:daemon-stopping",
      "taskManager.stopAll",
      "commandEvents.dispose",
      "appEvents.dispose",
      "streamBridge.close",
      "database.close",
    ]);
  });

  it("does not stop daemon-owned resources more than once", async () => {
    const calls: string[] = [];
    const runtime = bootstrapRuntime({
      runManager: new RecordingRunManager(calls),
      streamBridge: new RecordingStreamBridge(calls),
      scheduler: new RecordingLifecycleComponent("scheduler", calls),
      heartbeat: new RecordingLifecycleComponent("heartbeat", calls),
      interactionBroker: new RecordingInteractionBroker(calls),
      taskManager: new RecordingTaskManager(calls),
      database: new RecordingDatabase(calls),
      startAppEventAdapter: createEventAdapterStarter("appEvents", calls),
      startCommandEventAdapter: createEventAdapterStarter(
        "commandEvents",
        calls,
      ),
    });

    await runtime.start();
    await runtime.stop();
    await runtime.stop();

    expect(
      calls.filter((call) => call === "runManager.cancelAll"),
    ).toHaveLength(1);
    expect(calls.filter((call) => call === "streamBridge.close")).toHaveLength(
      1,
    );
    expect(calls.filter((call) => call === "database.close")).toHaveLength(1);
  });

  it("continues cleanup after a daemon-owned resource rejects during stop", async () => {
    const calls: string[] = [];
    const runtime = bootstrapRuntime({
      runManager: new RecordingRunManager(calls),
      streamBridge: new RecordingStreamBridge(calls),
      scheduler: new FailingStopComponent(calls),
      heartbeat: new RecordingLifecycleComponent("heartbeat", calls),
      interactionBroker: new RecordingInteractionBroker(calls),
      taskManager: new RecordingTaskManager(calls),
      database: new RecordingDatabase(calls),
      startAppEventAdapter: createEventAdapterStarter("appEvents", calls),
      startCommandEventAdapter: createEventAdapterStarter(
        "commandEvents",
        calls,
      ),
    });

    await runtime.start();

    await expect(runtime.stop()).rejects.toThrow("scheduler stop failed");

    expect(calls).toEqual([
      "runManager.init",
      "scheduler.start",
      "heartbeat.start",
      "appEvents.start",
      "commandEvents.start",
      "heartbeat.stop",
      "scheduler.stop",
      "runManager.cancelAll",
      "interactionBroker.abortAll:daemon-stopping",
      "taskManager.stopAll",
      "commandEvents.dispose",
      "appEvents.dispose",
      "streamBridge.close",
      "database.close",
    ]);
  });

  it("adapts configured bus events into the app stream and disposes subscriptions", async () => {
    const bus = createBus();
    const calls: string[] = [];
    const bridge = new RecordingStreamBridge(calls);
    const appEvent = BusEvent.define(
      "daemon.test.app",
      z.object({ value: z.string() }),
    );
    const commandEvent = BusEvent.define(
      "daemon.test.command",
      z.object({ id: z.string() }),
    );
    const runtime = bootstrapRuntime({
      bus,
      runManager: new RecordingRunManager(calls),
      streamBridge: bridge,
      appEventDefinitions: [appEvent],
      commandEventDefinitions: [commandEvent],
    });

    await runtime.start();

    bus.publish(appEvent, { value: "one" });
    bus.publish(commandEvent, { id: "cmd_1" });

    expect(bridge.published).toEqual([
      {
        scope: "app",
        event: "daemon.test.app",
        data: { value: "one" },
      },
      {
        scope: "app",
        event: "daemon.test.command",
        data: { id: "cmd_1" },
      },
    ]);

    await runtime.stop();
    bus.publish(appEvent, { value: "after-stop" });

    expect(bridge.published).toHaveLength(2);
  });

  it("wires the real in-memory ledger, stream bridge, and run manager", async () => {
    const runLedger = createInMemoryRunLedger({ now: () => 1_000 });
    await runLedger.createPending({
      runId: "pending_run",
      sessionId: "session_1",
      triggerSource: "user",
    });
    await runLedger.createPending({
      runId: "running_run",
      sessionId: "session_2",
      triggerSource: "scheduler",
    });
    await runLedger.markRunning("running_run");

    const runtime = bootstrapRuntime({
      lifecycle: new CompletingLifecycle(),
      runLedger,
      policy,
      profileRegistry: {
        getProfile(id: string): { readonly id: string } {
          return { id };
        },
      },
      now: () => 2_000,
      createRunId: () => "run_created_by_daemon",
    });

    await runtime.start();

    await expect(runLedger.get("pending_run")).resolves.toMatchObject({
      status: "interrupted",
    } satisfies Partial<RunLedgerRecord>);
    await expect(runLedger.get("running_run")).resolves.toMatchObject({
      status: "interrupted",
    } satisfies Partial<RunLedgerRecord>);
    expect(runtime.runManager).toBeInstanceOf(RunManager);
    if (!(runtime.runManager instanceof RunManager)) {
      throw new Error("Expected bootstrapRuntime to create RunManager");
    }

    const created = await runtime.runManager.create({
      sessionId: "session_1",
      triggerSource: "user",
      messages: [{ role: "user", content: "hello" }],
    });

    await expect(
      runtime.runManager.waitForCompletion(created.runId),
    ).resolves.toEqual({ status: "succeeded" });
    await expect(runLedger.get(created.runId)).resolves.toMatchObject({
      status: "succeeded",
    } satisfies Partial<RunLedgerRecord>);

    await runtime.stop();
  });
});
