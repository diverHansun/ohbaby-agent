import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { UiPromptCacheUsage } from "ohbaby-sdk";
import { createPromptCacheUsageTracker } from "../../../packages/ohbaby-agent/src/adapters/ui-inprocess/prompt-cache-usage.js";
import { createBus } from "../../../packages/ohbaby-agent/src/bus/index.js";
import {
  createContextManager,
  type ContextLLMClient,
  type PreparedTurn,
} from "../../../packages/ohbaby-agent/src/core/context/index.js";
import {
  Lifecycle,
  type LifecycleResult,
  type StepUsageObservation,
} from "../../../packages/ohbaby-agent/src/core/lifecycle/index.js";
import type {
  LLMClientInstance,
  TokenUsage,
} from "../../../packages/ohbaby-agent/src/core/llm-client/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
  readTokenUsageMetadata,
} from "../../../packages/ohbaby-agent/src/core/message/index.js";
import {
  createToolScheduler,
  type ToolSchedulerInstance,
} from "../../../packages/ohbaby-agent/src/core/tool-scheduler/index.js";
import { createPermissionState } from "../../../packages/ohbaby-agent/src/permission/index.js";
import {
  createInterfaceProvider,
  type InterfaceProviderKind,
} from "../../../packages/ohbaby-agent/src/services/interface-providers/index.js";

const protocols = [
  "openai-compatible",
  "openai-responses",
  "anthropic",
] as const;

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function nativeEvents(
  protocol: InterfaceProviderKind,
  secondScope = false,
  lateAnthropicReclassification = false,
): readonly Record<string, unknown>[] {
  if (protocol === "openai-compatible") {
    const chunk = (delta: unknown, finish: string | null = null) => ({
      id: "chat_usage",
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture-model",
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    return [
      chunk({ role: "assistant", content: "done" }),
      {
        ...chunk({}, "stop"),
        usage: {
          prompt_tokens: secondScope ? 240 : 120,
          completion_tokens: 7,
          total_tokens: secondScope ? 247 : 127,
          prompt_tokens_details: {
            cached_tokens: secondScope ? 90 : 40,
            cache_write_tokens: secondScope ? 30 : 10,
          },
        },
      },
    ];
  }
  if (protocol === "anthropic") {
    return [
      {
        type: "message_start",
        message: {
          id: "msg_usage",
          type: "message",
          role: "assistant",
          model: "fixture-model",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: lateAnthropicReclassification
            ? {
                input_tokens: 5_341,
                output_tokens: 0,
              }
            : {
                input_tokens: secondScope ? 120 : 70,
                output_tokens: 0,
                cache_creation_input_tokens: secondScope ? 30 : 20,
                cache_read_input_tokens: secondScope ? 90 : 30,
              },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "done" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: lateAnthropicReclassification
          ? {
              input_tokens: 402,
              cache_read_input_tokens: 4_992,
              cache_creation_input_tokens: 0,
              output_tokens: 121,
            }
          : { output_tokens: 7 },
      },
      { type: "message_stop" },
    ];
  }
  const part = {
    type: "output_text",
    text: "done",
    annotations: [],
    logprobs: [],
  };
  const item = {
    id: "msg_usage",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [part],
  };
  const ref = { item_id: "msg_usage", output_index: 0, content_index: 0 };
  return [
    {
      type: "response.output_item.added",
      ...ref,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      ...ref,
      part: { ...part, text: "" },
    },
    { type: "response.output_text.delta", ...ref, delta: "done", logprobs: [] },
    { type: "response.output_text.done", ...ref, text: "done", logprobs: [] },
    { type: "response.content_part.done", ...ref, part },
    {
      type: "response.output_item.done",
      item_id: "msg_usage",
      output_index: 0,
      item,
    },
    {
      type: "response.completed",
      response: {
        id: "resp_usage",
        status: "completed",
        output: [item],
        usage: {
          input_tokens: secondScope ? 240 : 120,
          output_tokens: 7,
          total_tokens: secondScope ? 247 : 127,
          input_tokens_details: {
            cached_tokens: secondScope ? 90 : 40,
            cache_write_tokens: secondScope ? 30 : 10,
          },
        },
        previous_response_id: null,
        store: false,
      },
    },
  ];
}

async function runProtocol(
  protocol: InterfaceProviderKind,
  isSubagent = false,
  lateAnthropicReclassification = false,
): Promise<{
  readonly calibrationCalls: readonly unknown[][];
  readonly prepared: readonly PreparedTurn[];
  readonly recalibratedCurrentTokens: number;
  readonly repeatedSentHeuristic: number;
  readonly result: LifecycleResult;
  readonly usagePartCount: number;
  readonly persistedUsages: readonly (TokenUsage | undefined)[];
  readonly observations: readonly StepUsageObservation[];
  readonly cacheTotals: UiPromptCacheUsage;
  readonly requestPaths: readonly (string | undefined)[];
}> {
  const sessionId = `session_${protocol}`;
  const scope = isSubagent
    ? { contextScopeId: "scope_a", isSubagent: true }
    : {};
  const tracker = createPromptCacheUsageTracker();
  const observations: StepUsageObservation[] = [];
  const requestPaths: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      for await (const _chunk of request) {
        /* drain native SDK request */
      }
      requestPaths.push(request.url);
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      for (const event of nativeEvents(
        protocol,
        isSubagent && requestPaths.length === 2,
        lateAnthropicReclassification,
      )) {
        if (protocol !== "openai-compatible")
          response.write(`event: ${String(event.type)}\n`);
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      if (protocol === "openai-compatible") response.write("data: [DONE]\n\n");
      response.end();
    })().catch((error: unknown) =>
      response.destroy(error instanceof Error ? error : undefined),
    );
  });
  await listen(server);
  try {
    const bus = createBus();
    const messageManager = createMessageManager({
      bus,
      store: createInMemoryMessageStore(),
    });
    const user = await messageManager.createMessage({
      agent: "build",
      role: "user",
      sessionId,
      ...scope,
    });
    await messageManager.appendPart(user.id, {
      type: "text",
      text: "fixed input",
    });
    const contextManager = createContextManager({
      bus,
      llmClient: {
        generateSummary: vi
          .fn<ContextLLMClient["generateSummary"]>()
          .mockResolvedValue("unused"),
      },
      memory: {
        load: () => Promise.resolve({ global: "", project: "", merged: "" }),
      },
      messageManager,
      systemPromptProvider: { build: () => Promise.resolve("stable system") },
      tokenCounter: {
        estimateTokens: (value) => value.length,
        getLimit: () => 100_000,
      },
    });
    const prepared: PreparedTurn[] = [];
    const originalPrepare = contextManager.prepareTurn.bind(contextManager);
    const isolatedInputs = isSubagent
      ? [
          { sessionId, contextScopeId: "scope_b", isSubagent: true },
          { sessionId: "parent_session" },
        ]
      : [];
    for (const identity of isolatedInputs) {
      const isolatedUser = await messageManager.createMessage({
        ...identity,
        agent: "build",
        role: "user",
      });
      await messageManager.appendPart(isolatedUser.id, {
        type: "text",
        text: "fixed input",
      });
    }
    const prepareIsolated = () =>
      Promise.all(
        isolatedInputs.map((identity) =>
          originalPrepare({
            ...identity,
            directory: "/repo",
            modelId: "fixture-model",
            toolNames: [],
            tools: [],
          }),
        ),
      );
    const isolatedBefore = await prepareIsolated();
    const originalUpdate =
      contextManager.updateCalibrationFactor.bind(contextManager);
    const prepareSpy = vi
      .spyOn(contextManager, "prepareTurn")
      .mockImplementation(async (input) => {
        const turn = await originalPrepare(input);
        prepared.push(turn);
        return turn;
      });
    const updateSpy = vi
      .spyOn(contextManager, "updateCalibrationFactor")
      .mockImplementation((...args) => originalUpdate(...args));
    const address = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${String(address.port)}`;
    const provider = createInterfaceProvider({
      id: "fixture",
      interfaceProvider: protocol,
      apiKey: "fixture-key",
      baseUrl: protocol === "anthropic" ? origin : `${origin}/v1`,
    });
    (provider.client as { maxRetries: number }).maxRetries = 0;
    const llmClient: LLMClientInstance = {
      provider,
      config: {
        modelProfiles: [
          {
            model: "fixture-model",
            contextWindowTokens: 128000,
            reasoningCapabilities: {
              mode: "none",
              wire: "none",
              supportsDisabled: true,
            },
          },
        ],
        provider: "fixture",
        model: "fixture-model",
        baseUrl: origin,
        interfaceProvider: protocol,
        temperature: 0,
        maxTokens: 64,
      },
    };
    const lifecycle = new Lifecycle({
      contextManager,
      llmClient,
      messageManager,
      toolScheduler: {
        executeBatch: vi.fn(),
      } as unknown as ToolSchedulerInstance,
    });
    const loop = lifecycle.run({
      directory: "/repo",
      modelId: "fixture-model",
      sessionId,
      ...scope,
      onStepUsage: (observation) => {
        observations.push(observation);
        if (!isSubagent) tracker.record(sessionId, observation.tokenUsage);
      },
    });
    let next = await loop.next();
    while (!next.done) next = await loop.next();
    const isolatedAfter = await prepareIsolated();
    expect(
      isolatedAfter.map(({ request, usage, sentHeuristic }) => ({
        request,
        usage,
        sentHeuristic,
      })),
    ).toEqual(
      isolatedBefore.map(({ request, usage, sentHeuristic }) => ({
        request,
        usage,
        sentHeuristic,
      })),
    );
    for (const identity of isolatedInputs) {
      const isolatedParts = (
        await messageManager.listBySession(identity.sessionId, {
          contextScopeId: identity.contextScopeId,
        })
      ).flatMap((message) => message.parts);
      expect(
        isolatedParts.map((part) => readTokenUsageMetadata(part.metadata)),
      ).toEqual([undefined]);
    }
    if (isSubagent) {
      const scopeABefore = await originalPrepare({
        sessionId,
        ...scope,
        directory: "/repo",
        modelId: "fixture-model",
        toolNames: [],
        tools: [],
      });
      const secondObservations: StepUsageObservation[] = [];
      const secondLoop = lifecycle.run({
        sessionId,
        contextScopeId: "scope_b",
        isSubagent: true,
        directory: "/repo",
        modelId: "fixture-model",
        onStepUsage: (observation) => {
          secondObservations.push(observation);
        },
      });
      let second = await secondLoop.next();
      while (!second.done) second = await secondLoop.next();
      const secondUsage = {
        inputTokens: 240,
        outputTokens: 7,
        totalTokens: 247,
        inputBreakdown: {
          cacheRead: 90,
          cacheWrite: 30,
          uncached: 120,
          observed: { cacheRead: true, cacheWrite: true },
        },
      };
      expect(second.value.usage).toEqual({
        ...secondUsage,
        usageComplete: true,
      });
      expect(secondObservations).toEqual([
        { step: 1, tokenUsage: secondUsage },
      ]);
      const secondMessages = await messageManager.listBySession(sessionId, {
        contextScopeId: "scope_b",
      });
      expect(
        secondMessages
          .flatMap((message) => message.parts)
          .map((part) => readTokenUsageMetadata(part.metadata))
          .filter((usage) => usage !== undefined),
      ).toEqual([secondUsage]);
      const scopeAAfter = await originalPrepare({
        sessionId,
        ...scope,
        directory: "/repo",
        modelId: "fixture-model",
        toolNames: [],
        tools: [],
      });
      expect(scopeAAfter.request).toEqual(scopeABefore.request);
      expect(scopeAAfter.usage).toEqual(scopeABefore.usage);
      expect(scopeAAfter.sentHeuristic).toBe(scopeABefore.sentHeuristic);
      const parentAfter = (await prepareIsolated())[1];
      expect(parentAfter?.request).toEqual(isolatedBefore[1]?.request);
      expect(parentAfter?.usage).toEqual(isolatedBefore[1]?.usage);
      // Recreate only B's original input to measure its own calibrated budget.
      for (const message of secondMessages)
        await messageManager.removeMessage(message.info.id);
      const secondUser = await messageManager.createMessage({
        sessionId,
        contextScopeId: "scope_b",
        agent: "build",
        role: "user",
      });
      await messageManager.appendPart(secondUser.id, {
        type: "text",
        text: "fixed input",
      });
      const repeatedB = (await prepareIsolated())[0];
      expect(repeatedB?.sentHeuristic).toBe(83);
      expect(repeatedB?.usage.currentTokens).toBe(162);
    }
    const calibrationCalls = [...updateSpy.mock.calls];
    const usageParts = (
      await messageManager.listBySession(sessionId, {
        contextScopeId: scope.contextScopeId,
      })
    )
      .flatMap((message) => message.parts)
      .filter((part) => readTokenUsageMetadata(part.metadata) !== undefined);
    expect(
      usageParts.every((part) => part.contextScopeId === scope.contextScopeId),
    ).toBe(true);
    await messageManager.removeMessages(sessionId);
    const repeatedUser = await messageManager.createMessage({
      agent: "build",
      role: "user",
      sessionId,
      ...scope,
    });
    await messageManager.appendPart(repeatedUser.id, {
      type: "text",
      text: "fixed input",
    });
    const repeated = await contextManager.prepareTurn({
      directory: "/repo",
      modelId: "fixture-model",
      sessionId,
      ...scope,
      toolNames: [],
      tools: [],
    });
    prepareSpy.mockRestore();
    updateSpy.mockRestore();
    return {
      calibrationCalls,
      prepared,
      recalibratedCurrentTokens: repeated.usage.currentTokens,
      repeatedSentHeuristic: repeated.sentHeuristic,
      result: next.value,
      usagePartCount: usageParts.length,
      persistedUsages: usageParts.map((part) =>
        readTokenUsageMetadata(part.metadata),
      ),
      observations,
      cacheTotals: tracker.get(sessionId),
      requestPaths,
    };
  } finally {
    await close(server);
  }
}

describe("usage calibration across native provider streams", () => {
  it.each(protocols)(
    "normalizes %s cache usage through Lifecycle and calibrates its prepared request",
    async (protocol) => {
      const output = await runProtocol(protocol);
      expect(output.result.usage).toEqual({
        inputBreakdown: {
          cacheRead: protocol === "anthropic" ? 30 : 40,
          cacheWrite: protocol === "anthropic" ? 20 : 10,
          observed: { cacheRead: true, cacheWrite: true },
          uncached: 70,
        },
        inputTokens: 120,
        outputTokens: 7,
        totalTokens: 127,
        usageComplete: true,
      });
      expect(output.calibrationCalls).toEqual([
        [`session_${protocol}`, 120, 83],
      ]);
      expect(output.prepared[0]?.sentHeuristic).toBe(83);
      expect(output.repeatedSentHeuristic).toBe(83);
      expect(output.recalibratedCurrentTokens).toBe(102);
      expect(output.usagePartCount).toBe(1);
      const expectedUsage = { ...output.result.usage };
      delete expectedUsage.usageComplete;
      expect(output.persistedUsages).toEqual([expectedUsage]);
      expect(output.observations).toEqual([
        { step: 1, tokenUsage: expectedUsage },
      ]);
      expect(output.cacheTotals).toEqual({
        sessionId: `session_${protocol}`,
        accountedInputTokens: 120,
        cacheReadTokens: protocol === "anthropic" ? 30 : 40,
        cacheReadShare: (protocol === "anthropic" ? 30 : 40) / 120,
      });
      expect(output.requestPaths).toEqual([
        protocol === "anthropic"
          ? "/v1/messages"
          : protocol === "openai-responses"
            ? "/v1/responses"
            : "/v1/chat/completions",
      ]);
    },
  );

  it.each(protocols)(
    "retains silent child %s usage in its scoped Part and calibration",
    async (protocol) => {
      const output = await runProtocol(protocol, true);
      const expectedUsage = {
        inputBreakdown: {
          cacheRead: protocol === "anthropic" ? 30 : 40,
          cacheWrite: protocol === "anthropic" ? 20 : 10,
          observed: { cacheRead: true, cacheWrite: true },
          uncached: 70,
        },
        inputTokens: 120,
        outputTokens: 7,
        totalTokens: 127,
      };
      expect(output.result.usage).toEqual({
        ...expectedUsage,
        usageComplete: true,
      });
      expect(output.persistedUsages).toEqual([expectedUsage]);
      expect(output.observations).toEqual([
        { step: 1, tokenUsage: expectedUsage },
      ]);
      expect(output.calibrationCalls).toEqual([
        [`session_${protocol}`, 120, 83, "scope_a"],
        [`session_${protocol}`, 240, 83, "scope_b"],
      ]);
      expect(output.repeatedSentHeuristic).toBe(83);
      expect(output.recalibratedCurrentTokens).toBe(102);
      // This private observation does not create child-facing cache statistics.
      // Actual backend identity filtering is covered by the foreground subagent integration.
      expect(output.cacheTotals).toMatchObject({
        accountedInputTokens: 0,
        cacheReadTokens: 0,
        cacheReadShare: null,
      });
    },
  );

  it("reclassifies late Anthropic cache usage before accepted-step accounting", async () => {
    const output = await runProtocol("anthropic", false, true);
    const expectedUsage = {
      inputTokens: 5_394,
      outputTokens: 121,
      totalTokens: 5_515,
      inputBreakdown: {
        uncached: 402,
        cacheRead: 4_992,
        cacheWrite: 0,
        observed: { cacheRead: true, cacheWrite: true },
      },
    };
    expect(output.result.usage).toEqual({
      ...expectedUsage,
      usageComplete: true,
    });
    expect(output.observations).toEqual([
      { step: 1, tokenUsage: expectedUsage },
    ]);
    expect(output.persistedUsages).toEqual([expectedUsage]);
    expect(output.usagePartCount).toBe(1);
    expect(output.cacheTotals).toEqual({
      sessionId: "session_anthropic",
      accountedInputTokens: 5_394,
      cacheReadTokens: 4_992,
      cacheReadShare: 4_992 / 5_394,
    });
    expect(output.calibrationCalls).toEqual([["session_anthropic", 5_394, 83]]);
    expect(output.requestPaths).toEqual(["/v1/messages"]);
  });

  it("pairs two native Chat requests with their own estimates and usage", async () => {
    const requests: { path: string | undefined; body: unknown }[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        let raw = "";
        for await (const chunk of request) raw += String(chunk);
        requests.push({ path: request.url, body: JSON.parse(raw) as unknown });
        const first = requests.length === 1;
        const base = {
          id: first ? "chat_first" : "chat_second",
          object: "chat.completion.chunk",
          created: requests.length,
          model: "fixture-model",
        };
        const events = first
          ? [
              {
                ...base,
                choices: [
                  {
                    index: 0,
                    finish_reason: null,
                    delta: {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_lookup",
                          type: "function",
                          function: { name: "lookup", arguments: '{"q":"x"}' },
                        },
                      ],
                    },
                  },
                ],
              },
              {
                ...base,
                choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
                usage: {
                  prompt_tokens: 100,
                  completion_tokens: 5,
                  total_tokens: 105,
                  prompt_tokens_details: {
                    cached_tokens: 20,
                    cache_write_tokens: 10,
                  },
                },
              },
            ]
          : [
              {
                ...base,
                choices: [
                  {
                    index: 0,
                    delta: { role: "assistant", content: "done" },
                    finish_reason: null,
                  },
                ],
              },
              {
                ...base,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: {
                  prompt_tokens: 200,
                  completion_tokens: 7,
                  total_tokens: 207,
                  prompt_tokens_details: {
                    cached_tokens: 50,
                    cache_write_tokens: 20,
                  },
                },
              },
            ];
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        for (const event of events)
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        response.end("data: [DONE]\n\n");
      })().catch((error: unknown) =>
        response.destroy(error instanceof Error ? error : undefined),
      );
    });
    await listen(server);
    try {
      const bus = createBus();
      const messageManager = createMessageManager({
        bus,
        store: createInMemoryMessageStore(),
      });
      const user = await messageManager.createMessage({
        agent: "build",
        role: "user",
        sessionId: "session_two_step",
      });
      await messageManager.appendPart(user.id, {
        type: "text",
        text: "look up x",
      });
      const contextManager = createContextManager({
        bus,
        llmClient: { generateSummary: () => Promise.resolve("unused") },
        memory: {
          load: () => Promise.resolve({ global: "", project: "", merged: "" }),
        },
        messageManager,
        systemPromptProvider: { build: () => Promise.resolve("stable system") },
        tokenCounter: {
          estimateTokens: (value) => value.length,
          getLimit: () => 100_000,
        },
      });
      const prepared: PreparedTurn[] = [];
      const originalPrepare = contextManager.prepareTurn.bind(contextManager);
      const originalUpdate =
        contextManager.updateCalibrationFactor.bind(contextManager);
      vi.spyOn(contextManager, "prepareTurn").mockImplementation(
        async (input) => {
          const turn = await originalPrepare(input);
          prepared.push(turn);
          return turn;
        },
      );
      const update = vi
        .spyOn(contextManager, "updateCalibrationFactor")
        .mockImplementation((...args) => originalUpdate(...args));
      const scheduler = createToolScheduler({
        bus,
        permission: { ask: () => "once" },
        permissionState: createPermissionState({
          bus,
          initialLevel: "full-access",
        }),
      });
      const executeLookup = vi.fn(() => ({ output: "lookup result" }));
      scheduler.register({
        category: "readonly",
        source: "builtin",
        name: "lookup",
        description: "Lookup fixture",
        parametersJsonSchema: {
          type: "object",
          properties: { q: { type: "string" } },
        },
        execute: executeLookup,
      });
      const address = server.address() as AddressInfo;
      const provider = createInterfaceProvider({
        id: "fixture",
        interfaceProvider: "openai-compatible",
        apiKey: "fixture-key",
        baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
      });
      (provider.client as { maxRetries: number }).maxRetries = 0;
      const lifecycle = new Lifecycle({
        contextManager,
        messageManager,
        toolScheduler: scheduler,
        llmClient: {
          provider,
          config: {
            modelProfiles: [
              {
                model: "fixture-model",
                contextWindowTokens: 128000,
                reasoningCapabilities: {
                  mode: "none",
                  wire: "none",
                  supportsDisabled: true,
                },
              },
            ],
            provider: "fixture",
            model: "fixture-model",
            baseUrl: "loopback",
            interfaceProvider: "openai-compatible",
            temperature: 0,
            maxTokens: 64,
          },
        },
      });
      const loop = lifecycle.run({
        directory: "/repo",
        modelId: "fixture-model",
        sessionId: "session_two_step",
        tools: [
          {
            name: "lookup",
            description: "Lookup fixture",
            inputSchema: {
              type: "object",
              properties: { q: { type: "string" } },
            },
          },
        ],
      });
      let next = await loop.next();
      while (!next.done) next = await loop.next();

      expect((provider.client as { maxRetries: number }).maxRetries).toBe(0);
      expect(executeLookup).toHaveBeenCalledTimes(1);
      expect(requests).toHaveLength(2);
      expect(requests.map(({ path }) => path)).toEqual([
        "/v1/chat/completions",
        "/v1/chat/completions",
      ]);
      expect(requests.map(({ body }) => body)).toEqual([
        expect.objectContaining({
          stream: true,
          messages: expect.any(Array) as unknown[],
        }),
        expect.objectContaining({
          stream: true,
          messages: expect.any(Array) as unknown[],
        }),
      ]);
      expect(requests[0]?.body).toMatchObject({
        messages: [
          { role: "system", content: "stable system" },
          { role: "user", content: "look up x" },
        ],
      });
      expect(requests[1]?.body).toMatchObject({
        messages: [
          { role: "system", content: "stable system" },
          { role: "user", content: "look up x" },
          expect.objectContaining({ role: "assistant" }),
          {
            role: "tool",
            tool_call_id: "call_lookup",
            content: "lookup result",
          },
        ],
      });
      expect(prepared).toHaveLength(2);
      expect(prepared.map((turn) => turn.sentHeuristic)).toEqual([231, 449]);
      expect(prepared[0]?.sentHeuristic).not.toBe(prepared[1]?.sentHeuristic);
      expect(update.mock.calls).toEqual([
        ["session_two_step", 100, 231],
        ["session_two_step", 200, 449],
      ]);
      expect(next.value.usage).toEqual({
        inputBreakdown: {
          cacheRead: 70,
          cacheWrite: 30,
          observed: { cacheRead: true, cacheWrite: true },
          uncached: 200,
        },
        inputTokens: 300,
        outputTokens: 12,
        totalTokens: 312,
        usageComplete: true,
      });
      const persistedUsages = (
        await messageManager.listBySession("session_two_step")
      )
        .flatMap((message) => message.parts)
        .map((part) => readTokenUsageMetadata(part.metadata))
        .filter((usage) => usage !== undefined);
      expect(persistedUsages).toEqual([
        {
          inputBreakdown: {
            cacheRead: 20,
            cacheWrite: 10,
            observed: { cacheRead: true, cacheWrite: true },
            uncached: 70,
          },
          inputTokens: 100,
          outputTokens: 5,
          totalTokens: 105,
        },
        {
          inputBreakdown: {
            cacheRead: 50,
            cacheWrite: 20,
            observed: { cacheRead: true, cacheWrite: true },
            uncached: 130,
          },
          inputTokens: 200,
          outputTokens: 7,
          totalTokens: 207,
        },
      ]);
      await messageManager.removeMessages("session_two_step");
      const repeatedUser = await messageManager.createMessage({
        agent: "build",
        role: "user",
        sessionId: "session_two_step",
      });
      await messageManager.appendPart(repeatedUser.id, {
        type: "text",
        text: "look up x",
      });
      const repeated = await contextManager.prepareTurn({
        directory: "/repo",
        modelId: "fixture-model",
        sessionId: "session_two_step",
        toolNames: ["lookup"],
        tools: [
          {
            name: "lookup",
            description: "Lookup fixture",
            inputSchema: {
              type: "object",
              properties: { q: { type: "string" } },
            },
          },
        ],
      });
      expect(repeated.sentHeuristic).toBe(231);
      expect(repeated.usage.currentTokens).toBe(144);
    } finally {
      await close(server);
    }
  });
});
