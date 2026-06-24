import { describe, expect, it, vi } from "vitest";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
} from "../../services/interface-providers/index.js";
import { createBus } from "../../bus/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../message/index.js";
import type { MessageIdGenerator } from "../message/index.js";
import { DEFAULT_MAX_STEPS, Lifecycle } from "./index.js";
import type { LLMClientInstance } from "../llm-client/index.js";
import type { ToolSchedulerInstance } from "../tool-scheduler/index.js";
import type {
  ContextManager,
  ContextUsage,
  PreparedTurn,
} from "../context/index.js";
import type {
  LifecycleEvent,
  LifecycleResult,
  LifecycleSessionParams,
} from "./index.js";

interface FakeSdkClient {
  readonly kind: "fake";
}

function createProviderStream(
  events: readonly InterfaceProviderStreamEvent[],
): AsyncGenerator<InterfaceProviderStreamEvent, void, unknown> {
  return (async function* (): AsyncGenerator<
    InterfaceProviderStreamEvent,
    void,
    unknown
  > {
    for (const event of events) {
      yield await Promise.resolve(event);
    }
  })();
}

function createSequentialFakeLLMClient(
  eventBatches: readonly (readonly InterfaceProviderStreamEvent[])[],
  requests: InterfaceProviderRequest[],
): LLMClientInstance<FakeSdkClient> {
  let nextBatch = 0;

  return {
    provider: {
      id: "fake",
      kind: "openai-compatible",
      client: { kind: "fake" },
      streamChatCompletion(
        request: InterfaceProviderRequest,
      ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
        if (nextBatch >= eventBatches.length) {
          return Promise.reject(new Error("No fake LLM response configured"));
        }
        requests.push(request);
        const events = eventBatches[nextBatch];
        nextBatch += 1;
        return Promise.resolve(createProviderStream(events));
      },
      isAbortError(): boolean {
        return false;
      },
    },
    config: {
      provider: "fake",
      model: "fake-model",
      apiKeyEnv: "FAKE_API_KEY",
      baseUrl: "https://example.invalid/v1",
      interfaceProvider: "openai-compatible",
      temperature: 0,
      maxTokens: 128,
    },
  };
}

function createFailThenSucceedLLMClient(input: {
  readonly error: Error;
  readonly events: readonly InterfaceProviderStreamEvent[];
  readonly requests: InterfaceProviderRequest[];
}): LLMClientInstance<FakeSdkClient> {
  let callCount = 0;

  return {
    provider: {
      id: "fake",
      kind: "openai-compatible",
      client: { kind: "fake" },
      streamChatCompletion(
        request: InterfaceProviderRequest,
      ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
        input.requests.push(request);
        callCount += 1;
        if (callCount === 1) {
          return Promise.reject(input.error);
        }
        return Promise.resolve(createProviderStream(input.events));
      },
      isAbortError(): boolean {
        return false;
      },
    },
    config: {
      provider: "fake",
      model: "fake-model",
      apiKeyEnv: "FAKE_API_KEY",
      baseUrl: "https://example.invalid/v1",
      interfaceProvider: "openai-compatible",
      temperature: 0,
      maxTokens: 128,
    },
  };
}

function createRejectingSequenceLLMClient(input: {
  readonly errors: readonly Error[];
  readonly requests: InterfaceProviderRequest[];
}): LLMClientInstance<FakeSdkClient> {
  let nextError = 0;

  return {
    provider: {
      id: "fake",
      kind: "openai-compatible",
      client: { kind: "fake" },
      streamChatCompletion(
        request: InterfaceProviderRequest,
      ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
        input.requests.push(request);
        if (nextError >= input.errors.length) {
          return Promise.reject(new Error("No fake error configured"));
        }
        const error = input.errors[nextError];
        nextError += 1;
        return Promise.reject(error);
      },
      isAbortError(): boolean {
        return false;
      },
    },
    config: {
      provider: "fake",
      model: "fake-model",
      apiKeyEnv: "FAKE_API_KEY",
      baseUrl: "https://example.invalid/v1",
      interfaceProvider: "openai-compatible",
      temperature: 0,
      maxTokens: 128,
    },
  };
}

function createScriptedFakeLLMClient(
  steps: readonly (
    | { readonly error: Error }
    | { readonly events: readonly InterfaceProviderStreamEvent[] }
  )[],
  requests: InterfaceProviderRequest[],
): LLMClientInstance<FakeSdkClient> {
  let nextStep = 0;

  return {
    provider: {
      id: "fake",
      kind: "openai-compatible",
      client: { kind: "fake" },
      streamChatCompletion(
        request: InterfaceProviderRequest,
      ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
        if (nextStep >= steps.length) {
          return Promise.reject(new Error("No fake LLM response configured"));
        }
        requests.push(request);
        const step = steps[nextStep];
        nextStep += 1;
        if ("error" in step) {
          return Promise.reject(step.error);
        }
        return Promise.resolve(createProviderStream(step.events));
      },
      isAbortError(): boolean {
        return false;
      },
    },
    config: {
      provider: "fake",
      model: "fake-model",
      apiKeyEnv: "FAKE_API_KEY",
      baseUrl: "https://example.invalid/v1",
      interfaceProvider: "openai-compatible",
      temperature: 0,
      maxTokens: 128,
    },
  };
}

const SESSION_USAGE: ContextUsage = {
  contextLimit: 100_000,
  currentTokens: 120,
  modelId: "fake-model",
  remainingTokens: 99_880,
  shouldCompress: false,
  usageRatio: 0.0012,
};

function preparedTurn(
  messages: PreparedTurn["messages"],
  usage: ContextUsage = SESSION_USAGE,
): PreparedTurn {
  return {
    assembledAt: 1_700_000_000_000,
    hasSummary: false,
    messages,
    usage,
  };
}

function createContextManagerMock(
  prepareTurn: ContextManager["prepareTurn"],
): ContextManager {
  return {
    assemble: vi.fn(),
    compact: vi.fn(),
    compress: vi.fn(),
    getUsage: vi.fn(),
    prepareTurn,
    prune: vi.fn(),
    shouldCompress: vi.fn(),
  };
}

describe("Lifecycle.run", () => {
  it("uses a Kimi-style generous default maxSteps", () => {
    expect(DEFAULT_MAX_STEPS).toBe(1000);
  });

  it("prepares context before every model step and uses prepared messages as the step source", async () => {
    const requests: InterfaceProviderRequest[] = [];
    const messageManager = createMessageManager({
      bus: createBus(),
      store: createInMemoryMessageStore(),
      idGenerator: createDeterministicIds(),
      now: () => 1_700_000_000_000,
    });
    const compressedUsage: ContextUsage = {
      ...SESSION_USAGE,
      remainingTokens: 8_000,
      shouldCompress: true,
      usageRatio: 0.92,
    };
    const firstTurnMessages: PreparedTurn["messages"] = [
      { role: "user", content: "Read README" },
    ];
    const secondStepMessages: PreparedTurn["messages"] = [
      { role: "user", content: "Read README" },
      {
        content: null,
        role: "assistant",
        tool_calls: [
          {
            function: {
              arguments: '{"path":"README.md"}',
              name: "read_file",
            },
            id: "call_read",
            type: "function",
          },
        ],
      },
      {
        content:
          'README contents\n\n<tool_metadata>\n{"mtimeMs":1700000000000}\n</tool_metadata>',
        role: "tool",
        tool_call_id: "call_read",
      },
    ];
    const prepareTurn = vi
      .fn<ContextManager["prepareTurn"]>()
      .mockResolvedValueOnce(preparedTurn(firstTurnMessages, compressedUsage))
      .mockResolvedValueOnce(preparedTurn(secondStepMessages));
    const toolScheduler = {
      executeBatch: vi
        .fn<ToolSchedulerInstance["executeBatch"]>()
        .mockResolvedValue([
          {
            callId: "call_read",
            metadata: { mtimeMs: 1_700_000_000_000 },
            output: "README contents",
            status: "success",
          },
        ]),
    } as unknown as ToolSchedulerInstance;
    const lifecycle = new Lifecycle({
      contextManager: createContextManagerMock(prepareTurn),
      llmClient: createSequentialFakeLLMClient(
        [
          [
            {
              toolCallDeltas: [
                {
                  argumentsDelta: '{"path":"README.md"}',
                  id: "call_read",
                  index: 0,
                  name: "read_file",
                },
              ],
              finishReason: "tool_calls",
            },
          ],
          [{ textDelta: "Done.", finishReason: "stop" }],
        ],
        requests,
      ),
      messageManager,
      toolScheduler,
    });

    const { events, result } = await consumeLifecycleEvents(
      lifecycle.run({
        directory: "D:/repo",
        modelId: "fake-model",
        sessionId: "session_test",
      }),
    );

    expect(prepareTurn).toHaveBeenNthCalledWith(1, {
      directory: "D:/repo",
      isSubagent: undefined,
      modelId: "fake-model",
      sessionId: "session_test",
    });
    expect(prepareTurn).toHaveBeenNthCalledWith(2, {
      directory: "D:/repo",
      isSubagent: undefined,
      modelId: "fake-model",
      sessionId: "session_test",
    });
    expect(prepareTurn).toHaveBeenCalledTimes(2);
    expect(requests[0]?.messages).toEqual(firstTurnMessages);
    expect(requests[1]?.messages).toEqual(secondStepMessages);
    expect(events).toEqual([
      "turn:start",
      "context:prepared",
      "llm:start",
      "llm:complete",
      "tool:start",
      "tool:result",
      "step:complete",
      "context:prepared",
      "llm:start",
      "llm:delta",
      "llm:complete",
      "turn:end",
    ]);
    expect(result).toMatchObject({
      finalResponse: "Done.",
      finishReason: "stop",
      success: true,
    });
  });

  it("emits reasoning events and passes active reasoning to the next tool-loop prepare", async () => {
    const requests: InterfaceProviderRequest[] = [];
    const messageManager = createMessageManager({
      bus: createBus(),
      store: createInMemoryMessageStore(),
      idGenerator: createDeterministicIds(),
      now: () => 1_700_000_000_000,
    });
    const prepareTurn = vi
      .fn<ContextManager["prepareTurn"]>()
      .mockResolvedValueOnce(
        preparedTurn([{ role: "user", content: "Read README" }]),
      )
      .mockResolvedValueOnce(
        preparedTurn([
          { role: "user", content: "Read README" },
          {
            content: null,
            role: "assistant",
            tool_calls: [
              {
                function: {
                  arguments: '{"path":"README.md"}',
                  name: "read_file",
                },
                id: "call_read",
                type: "function",
              },
            ],
          },
          {
            content: "README contents",
            role: "tool",
            tool_call_id: "call_read",
          },
        ]),
      );
    const appendPartSpy = vi.spyOn(messageManager, "appendPart");
    const lifecycle = new Lifecycle({
      contextManager: createContextManagerMock(prepareTurn),
      llmClient: createSequentialFakeLLMClient(
        [
          [
            { reasoningDelta: "think " },
            { reasoningDelta: "about README" },
            {
              toolCallDeltas: [
                {
                  argumentsDelta: '{"path":"README.md"}',
                  id: "call_read",
                  index: 0,
                  name: "read_file",
                },
              ],
              finishReason: "tool_calls",
            },
          ],
          [{ textDelta: "Done.", finishReason: "stop" }],
        ],
        requests,
      ),
      messageManager,
      toolScheduler: {
        executeBatch: vi.fn<ToolSchedulerInstance["executeBatch"]>(
          ({ calls }) =>
            Promise.resolve(
              calls.map((call) => ({
                callId: call.callId,
                output: "README contents",
                status: "success" as const,
              })),
            ),
        ),
      } as unknown as ToolSchedulerInstance,
    });

    const emitted: LifecycleEvent[] = [];
    const loop = lifecycle.run({
      directory: "D:/repo",
      modelId: "fake-model",
      sessionId: "session_test",
    });
    let next = await loop.next();
    while (!next.done) {
      emitted.push(next.value);
      next = await loop.next();
    }

    const reasoningEvents = emitted.filter(
      (
        event,
      ): event is Extract<
        LifecycleEvent,
        { type: "llm:reasoning-delta" | "llm:reasoning-end" }
      > =>
        event.type === "llm:reasoning-delta" ||
        event.type === "llm:reasoning-end",
    );
    expect(reasoningEvents).toEqual([
      {
        content: "think ",
        delta: "think ",
        messageId: "message_1",
        sessionId: "session_test",
        step: 1,
        timestamp: expect.any(Number) as number,
        type: "llm:reasoning-delta",
      },
      {
        content: "think about README",
        delta: "about README",
        messageId: "message_1",
        sessionId: "session_test",
        step: 1,
        timestamp: expect.any(Number) as number,
        type: "llm:reasoning-delta",
      },
      {
        content: "think about README",
        messageId: "message_1",
        sessionId: "session_test",
        step: 1,
        timestamp: expect.any(Number) as number,
        type: "llm:reasoning-end",
      },
    ]);
    expect(appendPartSpy).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ type: "reasoning" }),
    );
    expect(prepareTurn).toHaveBeenNthCalledWith(2, {
      activeReasoningByMessageId: new Map([
        ["message_1", "think about README"],
      ]),
      directory: "D:/repo",
      isSubagent: undefined,
      modelId: "fake-model",
      sessionId: "session_test",
    });
    expect(next.value).toMatchObject({
      finalResponse: "Done.",
      finishReason: "stop",
      success: true,
    });
  });

  it("does not persist the empty-response placeholder after a reasoning-only stop frame", async () => {
    const requests: InterfaceProviderRequest[] = [];
    const messageManager = createMessageManager({
      bus: createBus(),
      store: createInMemoryMessageStore(),
      idGenerator: createDeterministicIds(),
      now: () => 1_700_000_000_000,
    });
    const prepareTurn = vi
      .fn<ContextManager["prepareTurn"]>()
      .mockResolvedValue(preparedTurn([{ role: "user", content: "Think" }]));
    const appendPartSpy = vi.spyOn(messageManager, "appendPart");
    const lifecycle = new Lifecycle({
      contextManager: createContextManagerMock(prepareTurn),
      llmClient: createSequentialFakeLLMClient(
        [[{ reasoningDelta: "thinking" }, { finishReason: "stop" }]],
        requests,
      ),
      messageManager,
      toolScheduler: {
        executeBatch: vi.fn<ToolSchedulerInstance["executeBatch"]>(),
      } as unknown as ToolSchedulerInstance,
    });

    const emitted: LifecycleEvent[] = [];
    const loop = lifecycle.run({
      directory: "D:/repo",
      modelId: "fake-model",
      sessionId: "session_test",
    });
    let next = await loop.next();
    while (!next.done) {
      emitted.push(next.value);
      next = await loop.next();
    }

    expect(appendPartSpy).not.toHaveBeenCalled();
    const messages = await messageManager.listBySession("session_test");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.info.role).toBe("assistant");
    expect(messages[0]?.parts).toEqual([]);
    expect(next.value).toMatchObject({
      finalResponse: "",
      finishReason: "stop",
      success: true,
    });
    expect(
      emitted.some(
        (event) =>
          event.type === "llm:delta" && event.content === "(Empty response)",
      ),
    ).toBe(false);
  });

  it("stops after a turn through the injected turn policy", async () => {
    const requests: InterfaceProviderRequest[] = [];
    const messageManager = createMessageManager({
      bus: createBus(),
      store: createInMemoryMessageStore(),
      idGenerator: createDeterministicIds(),
      now: () => 1_700_000_000_000,
    });
    const prepareTurn = vi
      .fn<ContextManager["prepareTurn"]>()
      .mockResolvedValue(preparedTurn([{ role: "user", content: "Continue" }]));
    const lifecycle = new Lifecycle({
      contextManager: createContextManagerMock(prepareTurn),
      llmClient: createSequentialFakeLLMClient(
        [
          [
            {
              toolCallDeltas: [
                {
                  argumentsDelta: '{"value":1}',
                  id: "call_one",
                  index: 0,
                  name: "compute",
                },
              ],
              finishReason: "tool_calls",
            },
          ],
          [
            {
              toolCallDeltas: [
                {
                  argumentsDelta: '{"value":2}',
                  id: "call_two",
                  index: 0,
                  name: "compute",
                },
              ],
              finishReason: "tool_calls",
            },
          ],
        ],
        requests,
      ),
      messageManager,
      toolScheduler: {
        executeBatch: vi.fn<ToolSchedulerInstance["executeBatch"]>(
          ({ calls }) =>
            Promise.resolve(
              calls.map((call) => ({
                callId: call.callId,
                output: "ok",
                status: "success" as const,
              })),
            ),
        ),
      } as unknown as ToolSchedulerInstance,
    });
    const params: LifecycleSessionParams = {
      directory: "D:/repo",
      modelId: "fake-model",
      sessionId: "session_test",
    };

    const { events, result } = await consumeLifecycleEvents(
      lifecycle.run(params, {
        shouldStopAfterTurn: ({ step }) => step >= 2,
      }),
    );

    expect(requests).toHaveLength(2);
    expect(events.filter((event) => event === "turn:start")).toHaveLength(1);
    expect(events.filter((event) => event === "turn:end")).toHaveLength(1);
    expect(result).toMatchObject({
      finishReason: "tool_calls",
      success: true,
    });
  });

  it("uses the final maxSteps model step for text-only finalization", async () => {
    const requests: InterfaceProviderRequest[] = [];
    const messageManager = createMessageManager({
      bus: createBus(),
      store: createInMemoryMessageStore(),
      idGenerator: createDeterministicIds(),
      now: () => 1_700_000_000_000,
    });
    const prepareTurn = vi
      .fn<ContextManager["prepareTurn"]>()
      .mockResolvedValueOnce(
        preparedTurn([{ role: "user", content: "Do bounded work" }]),
      )
      .mockResolvedValueOnce(
        preparedTurn([
          { role: "user", content: "Do bounded work" },
          {
            content: null,
            role: "assistant",
            tool_calls: [
              {
                function: {
                  arguments: '{"path":"README.md"}',
                  name: "read_file",
                },
                id: "call_read",
                type: "function",
              },
            ],
          },
          {
            content: "README contents",
            role: "tool",
            tool_call_id: "call_read",
          },
        ]),
      );
    const lifecycle = new Lifecycle({
      contextManager: createContextManagerMock(prepareTurn),
      llmClient: createSequentialFakeLLMClient(
        [
          [
            {
              toolCallDeltas: [
                {
                  argumentsDelta: '{"path":"README.md"}',
                  id: "call_read",
                  index: 0,
                  name: "read_file",
                },
              ],
              finishReason: "tool_calls",
            },
          ],
          [{ textDelta: "Summary after limit.", finishReason: "stop" }],
        ],
        requests,
      ),
      messageManager,
      toolScheduler: {
        executeBatch: vi.fn<ToolSchedulerInstance["executeBatch"]>(
          ({ calls }) =>
            Promise.resolve(
              calls.map((call) => ({
                callId: call.callId,
                output: "README contents",
                status: "success" as const,
              })),
            ),
        ),
      } as unknown as ToolSchedulerInstance,
    });

    const { result } = await consumeLifecycleEvents(
      lifecycle.run({
        directory: "D:/repo",
        maxSteps: 2,
        modelId: "fake-model",
        sessionId: "session_test",
        tools: [
          {
            function: {
              name: "read_file",
              parameters: { type: "object" },
            },
            type: "function",
          },
        ],
      }),
    );

    expect(requests).toHaveLength(2);
    expect(requests[0]?.tools).toHaveLength(1);
    expect(requests[1]?.tools).toEqual([]);
    expect(requests[1]?.messages.at(-1)).toMatchObject({
      role: "system",
      content: expect.stringContaining(
        "Maximum lifecycle steps reached",
      ) as string,
    });
    expect(result).toMatchObject({
      finalResponse: "Summary after limit.",
      finishReason: "stop",
      success: true,
      terminalReason: "max_steps_finalized",
    });
  });

  it("fails when the final maxSteps finalization step still requests a tool", async () => {
    const requests: InterfaceProviderRequest[] = [];
    const messageManager = createMessageManager({
      bus: createBus(),
      store: createInMemoryMessageStore(),
      idGenerator: createDeterministicIds(),
      now: () => 1_700_000_000_000,
    });
    const prepareTurn = vi
      .fn<ContextManager["prepareTurn"]>()
      .mockResolvedValue(
        preparedTurn([{ role: "user", content: "Finish within one step" }]),
      );
    const lifecycle = new Lifecycle({
      contextManager: createContextManagerMock(prepareTurn),
      llmClient: createSequentialFakeLLMClient(
        [
          [
            {
              toolCallDeltas: [
                {
                  argumentsDelta: '{"path":"README.md"}',
                  id: "call_read",
                  index: 0,
                  name: "read_file",
                },
              ],
              finishReason: "tool_calls",
            },
          ],
        ],
        requests,
      ),
      messageManager,
      toolScheduler: {
        executeBatch: vi.fn<ToolSchedulerInstance["executeBatch"]>(),
      } as unknown as ToolSchedulerInstance,
    });

    const { result } = await consumeLifecycleEvents(
      lifecycle.run({
        directory: "D:/repo",
        maxSteps: 1,
        modelId: "fake-model",
        sessionId: "session_test",
        tools: [
          {
            function: {
              name: "read_file",
              parameters: { type: "object" },
            },
            type: "function",
          },
        ],
      }),
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.tools).toEqual([]);
    expect(result).toMatchObject({
      finishReason: "error",
      success: false,
      terminalReason: "max_steps_finalization_requested_tool",
    });
  });

  it("clamps non-positive maxSteps to a single finalization step", async () => {
    const requests: InterfaceProviderRequest[] = [];
    const messageManager = createMessageManager({
      bus: createBus(),
      store: createInMemoryMessageStore(),
      idGenerator: createDeterministicIds(),
      now: () => 1_700_000_000_000,
    });
    const prepareTurn = vi
      .fn<ContextManager["prepareTurn"]>()
      .mockResolvedValue(
        preparedTurn([{ role: "user", content: "Quick question" }]),
      );
    const lifecycle = new Lifecycle({
      contextManager: createContextManagerMock(prepareTurn),
      llmClient: createSequentialFakeLLMClient(
        [[{ textDelta: "Clamped summary.", finishReason: "stop" }]],
        requests,
      ),
      messageManager,
      toolScheduler: {
        executeBatch: vi.fn<ToolSchedulerInstance["executeBatch"]>(),
      } as unknown as ToolSchedulerInstance,
    });

    const { result } = await consumeLifecycleEvents(
      lifecycle.run({
        directory: "D:/repo",
        maxSteps: 0,
        modelId: "fake-model",
        sessionId: "session_test",
        tools: [
          {
            function: {
              name: "read_file",
              parameters: { type: "object" },
            },
            type: "function",
          },
        ],
      }),
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.tools).toEqual([]);
    expect(result).toMatchObject({
      finalResponse: "Clamped summary.",
      success: true,
      terminalReason: "max_steps_finalized",
    });
  });

  it("maps malformed tool call arguments to a tool_parse_failure terminal reason", async () => {
    const requests: InterfaceProviderRequest[] = [];
    const messageManager = createMessageManager({
      bus: createBus(),
      store: createInMemoryMessageStore(),
      idGenerator: createDeterministicIds(),
      now: () => 1_700_000_000_000,
    });
    const prepareTurn = vi
      .fn<ContextManager["prepareTurn"]>()
      .mockResolvedValue(
        preparedTurn([{ role: "user", content: "Read the file" }]),
      );
    const lifecycle = new Lifecycle({
      contextManager: createContextManagerMock(prepareTurn),
      llmClient: createSequentialFakeLLMClient(
        [
          [
            {
              toolCallDeltas: [
                {
                  argumentsDelta: '{"path": broken',
                  id: "call_bad",
                  index: 0,
                  name: "read_file",
                },
              ],
              finishReason: "tool_calls",
            },
          ],
        ],
        requests,
      ),
      messageManager,
      toolScheduler: {
        executeBatch: vi.fn<ToolSchedulerInstance["executeBatch"]>(),
      } as unknown as ToolSchedulerInstance,
    });

    const { result } = await consumeLifecycleEvents(
      lifecycle.run({
        directory: "D:/repo",
        modelId: "fake-model",
        sessionId: "session_test",
        tools: [
          {
            function: {
              name: "read_file",
              parameters: { type: "object" },
            },
            type: "function",
          },
        ],
      }),
    );

    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({
      finalResponse: expect.stringContaining(
        "malformed tool call arguments",
      ) as string,
      finishReason: "error",
      success: false,
      terminalReason: "tool_parse_failure",
    });
  });

  it("classifies tool-call finish events without parsed calls as tool parse failures", async () => {
    const requests: InterfaceProviderRequest[] = [];
    const messageManager = createMessageManager({
      bus: createBus(),
      store: createInMemoryMessageStore(),
      idGenerator: createDeterministicIds(),
      now: () => 1_700_000_000_000,
    });
    const prepareTurn = vi
      .fn<ContextManager["prepareTurn"]>()
      .mockResolvedValue(
        preparedTurn([{ role: "user", content: "Use a tool" }]),
      );
    const lifecycle = new Lifecycle({
      contextManager: createContextManagerMock(prepareTurn),
      llmClient: createSequentialFakeLLMClient(
        [[{ finishReason: "tool_calls" }]],
        requests,
      ),
      messageManager,
      toolScheduler: {
        executeBatch: vi.fn<ToolSchedulerInstance["executeBatch"]>(),
      } as unknown as ToolSchedulerInstance,
    });

    const { result } = await consumeLifecycleEvents(
      lifecycle.run({
        directory: "D:/repo",
        modelId: "fake-model",
        sessionId: "session_test",
      }),
    );

    expect(result).toMatchObject({
      finishReason: "error",
      success: false,
      terminalReason: "tool_parse_failure",
    });
  });

  it("stops before the model step when the signal aborts during prepareTurn", async () => {
    const requests: InterfaceProviderRequest[] = [];
    const abortController = new AbortController();
    const messageManager = createMessageManager({
      bus: createBus(),
      store: createInMemoryMessageStore(),
      idGenerator: createDeterministicIds(),
      now: () => 1_700_000_000_000,
    });
    const prepareTurn = vi
      .fn<ContextManager["prepareTurn"]>()
      .mockImplementation(() => {
        abortController.abort();
        return Promise.resolve(
          preparedTurn([{ role: "user", content: "Do not send this" }]),
        );
      });
    const lifecycle = new Lifecycle({
      contextManager: createContextManagerMock(prepareTurn),
      llmClient: createSequentialFakeLLMClient(
        [[{ textDelta: "Should not run.", finishReason: "stop" }]],
        requests,
      ),
      messageManager,
      toolScheduler: {
        executeBatch: vi.fn<ToolSchedulerInstance["executeBatch"]>(),
      } as unknown as ToolSchedulerInstance,
    });

    const { events, result } = await consumeLifecycleEvents(
      lifecycle.run({
        directory: "D:/repo",
        modelId: "fake-model",
        sessionId: "session_test",
        signal: abortController.signal,
      }),
    );

    expect(prepareTurn).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(0);
    expect(events).toEqual([]);
    expect(result).toMatchObject({
      finishReason: "error",
      success: false,
      terminalReason: "cancelled",
    });
    expect(result.usage).toBeUndefined();
  });

  it("persists partial tool output when a running tool is cancelled", async () => {
    const requests: InterfaceProviderRequest[] = [];
    const messageManager = createMessageManager({
      bus: createBus(),
      store: createInMemoryMessageStore(),
      idGenerator: createDeterministicIds(),
      now: () => 1_700_000_000_000,
    });
    const prepareTurn = vi
      .fn<ContextManager["prepareTurn"]>()
      .mockResolvedValue(preparedTurn([{ role: "user", content: "Run bash" }]));
    const lifecycle = new Lifecycle({
      contextManager: createContextManagerMock(prepareTurn),
      llmClient: createSequentialFakeLLMClient(
        [
          [
            {
              toolCallDeltas: [
                {
                  argumentsDelta: '{"command":"long-running-command"}',
                  id: "call_bash",
                  index: 0,
                  name: "bash",
                },
              ],
              finishReason: "tool_calls",
            },
          ],
        ],
        requests,
      ),
      messageManager,
      toolScheduler: {
        executeBatch: vi
          .fn<ToolSchedulerInstance["executeBatch"]>()
          .mockResolvedValue([
            {
              callId: "call_bash",
              output: "partial stdout before abort",
              status: "cancelled",
            },
          ]),
      } as unknown as ToolSchedulerInstance,
    });

    const { result } = await consumeLifecycleEvents(
      lifecycle.run(
        {
          directory: "D:/repo",
          modelId: "fake-model",
          sessionId: "session_test",
        },
        { shouldStopAfterTurn: () => true },
      ),
    );
    const messages = await messageManager.listBySession("session_test");
    const toolPart = messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === "tool" && part.callId === "call_bash");

    if (toolPart?.type !== "tool") {
      throw new Error("Expected persisted tool part");
    }
    expect(toolPart.state).toMatchObject({
      error: "Tool execution aborted by user",
      output: "partial stdout before abort",
      status: "aborted",
    });
    expect(result).toMatchObject({
      finishReason: "tool_calls",
      success: true,
    });
  });

  it("force prepares and retries once when the provider reports context overflow", async () => {
    const requests: InterfaceProviderRequest[] = [];
    const messageManager = createMessageManager({
      bus: createBus(),
      store: createInMemoryMessageStore(),
      idGenerator: createDeterministicIds(),
      now: () => 1_700_000_000_000,
    });
    const initialMessages: PreparedTurn["messages"] = [
      { role: "user", content: "Summarize a very large project" },
    ];
    const forcedMessages: PreparedTurn["messages"] = [
      { role: "user", content: "Summarize the compacted project state" },
    ];
    const prepareTurn = vi
      .fn<ContextManager["prepareTurn"]>()
      .mockResolvedValueOnce(preparedTurn(initialMessages))
      .mockResolvedValueOnce(preparedTurn(forcedMessages));
    const overflowError = Object.assign(
      new Error("maximum context length exceeded"),
      { code: "context_length_exceeded" },
    );
    const lifecycle = new Lifecycle({
      contextManager: createContextManagerMock(prepareTurn),
      llmClient: createFailThenSucceedLLMClient({
        error: overflowError,
        events: [{ textDelta: "Recovered.", finishReason: "stop" }],
        requests,
      }),
      messageManager,
      toolScheduler: {
        executeBatch: vi.fn<ToolSchedulerInstance["executeBatch"]>(),
      } as unknown as ToolSchedulerInstance,
    });

    const { events, result } = await consumeLifecycleEvents(
      lifecycle.run({
        directory: "D:/repo",
        modelId: "fake-model",
        sessionId: "session_test",
      }),
    );

    expect(prepareTurn).toHaveBeenNthCalledWith(1, {
      directory: "D:/repo",
      isSubagent: undefined,
      modelId: "fake-model",
      sessionId: "session_test",
    });
    expect(prepareTurn).toHaveBeenNthCalledWith(2, {
      directory: "D:/repo",
      force: true,
      isSubagent: undefined,
      modelId: "fake-model",
      sessionId: "session_test",
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.messages).toEqual(initialMessages);
    expect(requests[1]?.messages).toEqual(forcedMessages);
    expect(events).toEqual([
      "turn:start",
      "context:prepared",
      "llm:start",
      "context:prepared",
      "llm:start",
      "llm:delta",
      "llm:complete",
      "turn:end",
    ]);
    const persistedMessages =
      await messageManager.listBySession("session_test");
    expect(
      persistedMessages.some(
        (message) =>
          message.info.role === "assistant" && message.info.finish === "error",
      ),
    ).toBe(true);
    expect(result).toMatchObject({
      finalResponse: "Recovered.",
      finishReason: "stop",
      success: true,
    });
  });

  it("force prepares and retries when context overflow happens after multiple tool steps", async () => {
    const requests: InterfaceProviderRequest[] = [];
    const messageManager = createMessageManager({
      bus: createBus(),
      store: createInMemoryMessageStore(),
      idGenerator: createDeterministicIds(),
      now: () => 1_700_000_000_000,
    });
    const overflowError = Object.assign(
      new Error("maximum context length exceeded"),
      { code: "context_length_exceeded" },
    );
    const stepOneMessages: PreparedTurn["messages"] = [
      { role: "user", content: "Start a long tool chain" },
    ];
    const stepTwoMessages: PreparedTurn["messages"] = [
      { role: "user", content: "Continue after first tool" },
    ];
    const stepThreeMessages: PreparedTurn["messages"] = [
      { role: "user", content: "Continue after second tool" },
    ];
    const forcedMessages: PreparedTurn["messages"] = [
      { role: "user", content: "Continue after forced compaction" },
    ];
    const prepareTurn = vi
      .fn<ContextManager["prepareTurn"]>()
      .mockResolvedValueOnce(preparedTurn(stepOneMessages))
      .mockResolvedValueOnce(preparedTurn(stepTwoMessages))
      .mockResolvedValueOnce(preparedTurn(stepThreeMessages))
      .mockResolvedValueOnce(preparedTurn(forcedMessages));
    const lifecycle = new Lifecycle({
      contextManager: createContextManagerMock(prepareTurn),
      llmClient: createScriptedFakeLLMClient(
        [
          {
            events: [
              {
                toolCallDeltas: [
                  {
                    argumentsDelta: '{"value":1}',
                    id: "call_one",
                    index: 0,
                    name: "compute",
                  },
                ],
                finishReason: "tool_calls",
              },
            ],
          },
          {
            events: [
              {
                toolCallDeltas: [
                  {
                    argumentsDelta: '{"value":2}',
                    id: "call_two",
                    index: 0,
                    name: "compute",
                  },
                ],
                finishReason: "tool_calls",
              },
            ],
          },
          { error: overflowError },
          { events: [{ textDelta: "Recovered late.", finishReason: "stop" }] },
        ],
        requests,
      ),
      messageManager,
      toolScheduler: {
        executeBatch: vi.fn<ToolSchedulerInstance["executeBatch"]>(
          ({ calls }) =>
            Promise.resolve(
              calls.map((call) => ({
                callId: call.callId,
                output: "ok",
                status: "success" as const,
              })),
            ),
        ),
      } as unknown as ToolSchedulerInstance,
    });

    const { result } = await consumeLifecycleEvents(
      lifecycle.run({
        directory: "D:/repo",
        modelId: "fake-model",
        sessionId: "session_test",
      }),
    );

    expect(prepareTurn).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ force: true }),
    );
    expect(requests).toHaveLength(4);
    expect(requests[0]?.messages).toEqual(stepOneMessages);
    expect(requests[1]?.messages).toEqual(stepTwoMessages);
    expect(requests[2]?.messages).toEqual(stepThreeMessages);
    expect(requests[3]?.messages).toEqual(forcedMessages);
    expect(result).toMatchObject({
      finalResponse: "Recovered late.",
      finishReason: "stop",
      success: true,
    });
  });

  it("does not retry non-overflow provider errors", async () => {
    const requests: InterfaceProviderRequest[] = [];
    const messageManager = createMessageManager({
      bus: createBus(),
      store: createInMemoryMessageStore(),
      idGenerator: createDeterministicIds(),
      now: () => 1_700_000_000_000,
    });
    const prepareTurn = vi
      .fn<ContextManager["prepareTurn"]>()
      .mockResolvedValue(
        preparedTurn([{ role: "user", content: "Say hello" }]),
      );
    const lifecycle = new Lifecycle({
      contextManager: createContextManagerMock(prepareTurn),
      llmClient: createRejectingSequenceLLMClient({
        errors: [new Error("network down")],
        requests,
      }),
      messageManager,
      toolScheduler: {
        executeBatch: vi.fn<ToolSchedulerInstance["executeBatch"]>(),
      } as unknown as ToolSchedulerInstance,
    });

    await expect(
      consumeLifecycle(
        lifecycle.run({
          directory: "D:/repo",
          modelId: "fake-model",
          sessionId: "session_test",
        }),
      ),
    ).rejects.toThrow("network down");

    expect(prepareTurn).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
  });

  it("returns a structured result when retryable provider errors exhaust retries", async () => {
    const requests: InterfaceProviderRequest[] = [];
    const messageManager = createMessageManager({
      bus: createBus(),
      store: createInMemoryMessageStore(),
      idGenerator: createDeterministicIds(),
      now: () => 1_700_000_000_000,
    });
    const prepareTurn = vi
      .fn<ContextManager["prepareTurn"]>()
      .mockResolvedValue(
        preparedTurn([{ role: "user", content: "Say hello" }]),
      );
    const retryableErrors = Array.from({ length: 6 }, () =>
      Object.assign(new Error("provider unavailable"), {
        headers: { "retry-after-ms": "0" },
        status: 503,
      }),
    );
    const lifecycle = new Lifecycle({
      contextManager: createContextManagerMock(prepareTurn),
      llmClient: createRejectingSequenceLLMClient({
        errors: retryableErrors,
        requests,
      }),
      messageManager,
      toolScheduler: {
        executeBatch: vi.fn<ToolSchedulerInstance["executeBatch"]>(),
      } as unknown as ToolSchedulerInstance,
    });

    const { events, result } = await consumeLifecycleEvents(
      lifecycle.run({
        directory: "D:/repo",
        modelId: "fake-model",
        sessionId: "session_test",
      }),
    );

    expect(events.filter((event) => event === "llm:retrying")).toHaveLength(5);
    expect(requests).toHaveLength(6);
    expect(result).toMatchObject({
      finalResponse: expect.stringContaining("after 5 retries") as string,
      finishReason: "error",
      success: false,
      terminalReason: "provider_retry_exhausted",
    });
  });

  it("fails clearly when overflow retry also overflows", async () => {
    const requests: InterfaceProviderRequest[] = [];
    const messageManager = createMessageManager({
      bus: createBus(),
      store: createInMemoryMessageStore(),
      idGenerator: createDeterministicIds(),
      now: () => 1_700_000_000_000,
    });
    const overflowError = Object.assign(
      new Error("maximum context length exceeded"),
      { code: "context_length_exceeded" },
    );
    const prepareTurn = vi
      .fn<ContextManager["prepareTurn"]>()
      .mockResolvedValueOnce(
        preparedTurn([{ role: "user", content: "Huge input" }]),
      )
      .mockResolvedValueOnce(
        preparedTurn([{ role: "user", content: "Compacted huge input" }]),
      );
    const lifecycle = new Lifecycle({
      contextManager: createContextManagerMock(prepareTurn),
      llmClient: createRejectingSequenceLLMClient({
        errors: [overflowError, overflowError],
        requests,
      }),
      messageManager,
      toolScheduler: {
        executeBatch: vi.fn<ToolSchedulerInstance["executeBatch"]>(),
      } as unknown as ToolSchedulerInstance,
    });

    const { events, result } = await consumeLifecycleEvents(
      lifecycle.run({
        directory: "D:/repo",
        modelId: "fake-model",
        sessionId: "session_test",
      }),
    );

    expect(prepareTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ force: true }),
    );
    expect(requests).toHaveLength(2);
    expect(events).toEqual([
      "turn:start",
      "context:prepared",
      "llm:start",
      "context:prepared",
      "llm:start",
      "turn:end",
    ]);
    expect(result).toMatchObject({
      finalResponse: "Context overflow after forced compaction retry",
      finishReason: "error",
      success: false,
    });
  });
});

async function consumeLifecycle(
  loop: AsyncGenerator<unknown, unknown, void>,
): Promise<unknown> {
  let next = await loop.next();
  while (!next.done) {
    next = await loop.next();
  }
  return next.value;
}

async function consumeLifecycleEvents(
  loop: AsyncGenerator<LifecycleEvent, LifecycleResult, void>,
): Promise<{
  readonly events: string[];
  readonly result: LifecycleResult;
}> {
  const events: string[] = [];
  let next = await loop.next();
  while (!next.done) {
    events.push(next.value.type);
    next = await loop.next();
  }

  return { events, result: next.value };
}

function createDeterministicIds(): MessageIdGenerator {
  let nextMessageId = 1;
  let nextPartId = 1;

  return {
    messageId(): string {
      const id = `message_${String(nextMessageId)}`;
      nextMessageId += 1;
      return id;
    },
    partId(): string {
      const id = `part_${String(nextPartId)}`;
      nextPartId += 1;
      return id;
    },
  };
}
