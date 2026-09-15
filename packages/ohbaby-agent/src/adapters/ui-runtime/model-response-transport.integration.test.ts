import { describe, expect, it } from "vitest";
import { createBus } from "../../bus/index.js";
import { createContextManager } from "../../core/context/index.js";
import {
  Lifecycle,
  type LifecycleEvent,
  type LifecycleResult,
} from "../../core/lifecycle/index.js";
import type { LLMClientInstance } from "../../core/llm-client/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../../core/message/index.js";
import { createToolScheduler } from "../../core/tool-scheduler/index.js";
import { createPermissionState } from "../../permission/index.js";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
} from "../../services/interface-providers/index.js";
import type { RunContext, RunRecord } from "../../runtime/run-manager/index.js";
import { RunWorker } from "../../runtime/run-manager/worker.js";
import {
  createInMemoryStreamBridge,
  END_SENTINEL,
  HEARTBEAT_SENTINEL,
  type StreamBridgeEvent,
} from "../../runtime/stream-bridge/index.js";
import { createStreamBridgeRunEventSource } from "./stream-bridge-run-event-source.js";

const tokenUsage = {
  inputBreakdown: {
    cacheRead: 70,
    cacheWrite: 10,
    observed: { cacheRead: true, cacheWrite: true },
    uncached: 20,
  },
  inputTokens: 100,
  outputTokens: 25,
  totalTokens: 125,
} as const;

interface TransportResult {
  readonly executions: number;
  readonly observations: LifecycleEvent[];
  readonly producerEvents: LifecycleEvent[];
  readonly requests: InterfaceProviderRequest[];
  readonly result: Awaited<ReturnType<RunWorker["start"]>>;
  readonly wireEvents: StreamBridgeEvent[];
}

async function runThroughTransport(
  events: readonly InterfaceProviderStreamEvent[],
  abortAfterEvents = false,
): Promise<TransportResult> {
  const bus = createBus();
  const messageManager = createMessageManager({
    bus,
    store: createInMemoryMessageStore(),
  });
  const user = await messageManager.createMessage({
    agent: "build",
    contextScopeId: "subagent_1",
    role: "user",
    sessionId: "child_session",
  });
  await messageManager.appendPart(user.id, { type: "text", text: "continue" });
  const contextManager = createContextManager({
    bus,
    messageManager,
    llmClient: { generateSummary: () => Promise.resolve("unused") },
    memory: {
      load: () => Promise.resolve({ global: "", project: "", merged: "" }),
    },
    systemPromptProvider: { build: () => Promise.resolve("system") },
    tokenCounter: {
      estimateTokens: (text) => Math.ceil(text.length / 4),
      getLimit: () => 100_000,
    },
  });
  let executions = 0;
  const toolScheduler = createToolScheduler({
    bus,
    permission: { ask: () => "once" },
    permissionState: createPermissionState({
      bus,
      initialLevel: "full-access",
    }),
  });
  toolScheduler.register({
    category: "readonly",
    description: "Count executions without external side effects",
    execute: () => {
      executions += 1;
      return { output: "done" };
    },
    name: "lookup",
    parametersJsonSchema: { type: "object", properties: {} },
    source: "builtin",
  });
  const abortController = new AbortController();
  const requests: InterfaceProviderRequest[] = [];
  const llmClient: LLMClientInstance = {
    config: {
      baseUrl: "https://example.invalid/v1",
      interfaceProvider: "openai-compatible",
      maxTokens: 128,
      model: "fake-model",
      modelProfiles: [
        {
          model: "fake-model",
          contextWindowTokens: 128000,
          reasoningCapabilities: {
            mode: "none",
            wire: "none",
            supportsDisabled: true,
          },
        },
      ],
      provider: "fake",
      temperature: 0,
    },
    provider: {
      client: {},
      id: "fake",
      kind: "openai-compatible",
      isAbortError: (error) =>
        error instanceof Error && error.name === "AbortError",
      streamResponse(
        request,
      ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
        requests.push(request);
        if (requests.length > 1)
          throw new Error("Unexpected retry or tool step");
        return Promise.resolve(
          (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
            for (const event of events) yield await Promise.resolve(event);
            if (abortAfterEvents) {
              abortController.abort();
              const error = new Error("cancelled");
              error.name = "AbortError";
              throw error;
            }
          })(),
        );
      },
    },
  };
  const lifecycle = new Lifecycle({
    contextManager,
    llmClient,
    messageManager,
    toolScheduler,
  });
  const producerEvents: LifecycleEvent[] = [];
  const streamBridge = createInMemoryStreamBridge({ heartbeatIntervalMs: 0 });
  const source = createStreamBridgeRunEventSource(streamBridge);
  const observations: LifecycleEvent[] = [];
  const wireEvents: StreamBridgeEvent[] = [];
  const collectObservations = (async (): Promise<void> => {
    for await (const event of source.subscribeRunEvents("run_1"))
      observations.push(event);
  })();
  const collectWire = (async (): Promise<void> => {
    for await (const event of streamBridge.subscribe("run/run_1", 0)) {
      if (event !== END_SENTINEL && event !== HEARTBEAT_SENTINEL)
        wireEvents.push(event);
    }
  })();
  const context: RunContext = {
    abortSignal: abortController.signal,
    contextScopeId: "subagent_1",
    directory: "/workspace",
    initiatingUserMessageId: user.id,
    isSubagent: true,
    modelId: "fake-model",
    permissionProfileId: "interactive",
    runId: "run_1",
    sandboxLease: {} as RunContext["sandboxLease"],
    sessionId: "child_session",
    triggerSource: "user",
  };
  const run: RunRecord = {
    createdAt: 1,
    disconnectMode: "continue",
    multitaskStrategy: "reject",
    permissionProfileId: "interactive",
    runId: "run_1",
    sessionId: "child_session",
    status: "pending",
    triggerSource: "user",
  };
  const worker = new RunWorker(context, {
    lifecycle: {
      async *run(
        params,
      ): AsyncGenerator<LifecycleEvent, LifecycleResult, void> {
        const loop = lifecycle.run(params);
        let next = await loop.next();
        while (!next.done) {
          producerEvents.push(next.value);
          yield next.value;
          next = await loop.next();
        }
        return next.value;
      },
    },
    streamBridge,
  });
  try {
    const result = await worker.start({
      onRunning: () => Promise.resolve(),
      run,
    });
    return {
      executions,
      observations,
      producerEvents,
      requests,
      result,
      wireEvents,
    };
  } finally {
    streamBridge.end("run/run_1");
    await Promise.all([collectObservations, collectWire]);
  }
}

describe("model result transport", () => {
  it("keeps producer snapshots and reasoning separate while preserving exact worker wire and canonical usage", async () => {
    const result = await runThroughTransport([
      { reasoningTextDelta: "think" },
      { textDelta: "Hello" },
      { textDelta: " world", finishReason: "stop", tokenUsage },
    ]);
    expect(result.result).toMatchObject({
      status: "succeeded",
      result: {
        finalResponse: "Hello world",
        usage: { ...tokenUsage, usageComplete: true },
      },
    });
    const completion = result.producerEvents.find(
      (event) => event.type === "llm:complete",
    );
    expect(completion?.messageSnapshot).toEqual({ content: "Hello world" });
    expect(completion?.tokenUsage).toEqual(tokenUsage);
    expect(Reflect.ownKeys(completion?.tokenUsage ?? {}).sort()).toEqual([
      "inputBreakdown",
      "inputTokens",
      "outputTokens",
      "totalTokens",
    ]);
    expect(
      result.wireEvents
        .filter((event) => event.event === "message.part.delta")
        .map((event) => event.data),
    ).toEqual([
      {
        content: "Hello",
        delta: "Hello",
        contextScopeId: "subagent_1",
        runId: "run_1",
        sessionId: "child_session",
        timestamp: expect.any(Number) as number,
      },
      {
        content: "Hello world",
        delta: " world",
        contextScopeId: "subagent_1",
        runId: "run_1",
        sessionId: "child_session",
        timestamp: expect.any(Number) as number,
      },
    ]);
    expect(
      result.wireEvents.find((event) => event.event === "run.llm.complete")
        ?.data,
    ).toEqual({
      contextScopeId: "subagent_1",
      finishReason: "stop",
      runId: "run_1",
      sessionId: "child_session",
      step: 1,
      timestamp: expect.any(Number) as number,
      tokenUsage,
    });
    expect(
      result.observations
        .filter((event) => event.type === "llm:delta")
        .map((event) => event.messageSnapshot),
    ).toEqual([{ content: "Hello" }, { content: "Hello world" }]);
    const observedCompletion = result.observations.find(
      (event) => event.type === "llm:complete",
    );
    expect(observedCompletion).toEqual({
      contextScopeId: "subagent_1",
      finishReason: "stop",
      sessionId: "child_session",
      step: 1,
      timestamp: expect.any(Number) as number,
      tokenUsage,
      type: "llm:complete",
    });
    expect(
      result.observations.filter(
        (event) => event.type === "llm:reasoning-delta",
      ),
    ).toMatchObject([{ content: "think", delta: "think" }]);
    expect(result.requests).toHaveLength(1);
    expect(result.executions).toBe(0);
  });

  it.each([
    { argumentsDelta: '{"q":', finishReason: undefined },
    { argumentsDelta: "{}", finishReason: "tool_calls" as const },
  ])(
    "does not authorize tools when aborted with $argumentsDelta and finishReason=$finishReason",
    async ({ argumentsDelta, finishReason }) => {
      const result = await runThroughTransport(
        [
          {
            toolCallDeltas: [
              { index: 3, id: "call_1", name: "lookup", argumentsDelta },
            ],
            finishReason,
            tokenUsage,
          },
        ],
        true,
      );
      expect(result.result.status).toBe("cancelled");
      expect(result.requests).toHaveLength(1);
      expect(result.executions).toBe(0);
      const completion = result.producerEvents
        .filter((event) => event.type === "llm:complete")
        .at(-1);
      expect(completion?.messageSnapshot).toEqual({
        content: null,
        toolCalls: [
          {
            index: 3,
            callId: "call_1",
            name: "lookup",
            argumentsJson: argumentsDelta,
          },
        ],
      });
      expect(completion?.parsedToolCalls).toBeUndefined();
      expect(completion?.tokenUsage).toEqual(tokenUsage);
      expect(Reflect.ownKeys(completion?.tokenUsage ?? {}).sort()).toEqual([
        "inputBreakdown",
        "inputTokens",
        "outputTokens",
        "totalTokens",
      ]);
      for (const event of result.observations) {
        if (event.type !== "llm:complete") continue;
        expect(event).not.toHaveProperty("messageSnapshot");
        expect(event).not.toHaveProperty("parsedToolCalls");
        expect(event.tokenUsage).toEqual(tokenUsage);
      }
      expect(
        result.observations.some((event) => event.type === "tool:start"),
      ).toBe(false);
    },
  );
});
