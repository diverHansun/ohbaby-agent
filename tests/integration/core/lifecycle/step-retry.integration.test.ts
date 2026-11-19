import { listRetriedAttemptIds } from "ohbaby-sdk";
import { messageToUiMessage } from "../../../../packages/ohbaby-agent/src/adapters/ui-state/persistent-store.js";
import { isInterruptionFactPart } from "../../../../packages/ohbaby-agent/src/core/message/interruption.js";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAnthropicProvider,
  createOpenAICompatibleProvider,
} from "ohbaby-llm";
import {
  createTestContextManager as createContextManager,
  TestLifecycle as Lifecycle,
  type TestLifecycleSessionParams,
} from "../../../fixtures/model-fixtures.js";
import { createBus } from "../../../../packages/ohbaby-agent/src/bus/index.js";
import type {
  LifecycleEvent,
  LifecycleResult,
} from "../../../../packages/ohbaby-agent/src/core/lifecycle/types.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../../../../packages/ohbaby-agent/src/core/message/index.js";
import { MessageEvent } from "../../../../packages/ohbaby-agent/src/core/message/events.js";
import type { Message } from "../../../../packages/ohbaby-agent/src/core/message/types.js";
import { serializeHistoryMessages } from "../../../../packages/ohbaby-agent/src/core/context/serializer.js";
import { serializeHistory } from "../../../../packages/ohbaby-agent/src/core/context/serialization.js";
import { createToolScheduler } from "../../../../packages/ohbaby-agent/src/core/tool-scheduler/index.js";
import { createPermissionState } from "../../../../packages/ohbaby-agent/src/permission/index.js";

import { createInMemoryRunLedger } from "../../../../packages/ohbaby-agent/src/runtime/run-ledger/in-memory.js";
import { InMemoryCurrentRunInputStore } from "../../../../packages/ohbaby-agent/src/runtime/prompt-scheduler/current-run-inputs.js";
import { InMemoryPromptSubmissionStore } from "../../../../packages/ohbaby-agent/src/runtime/prompt-scheduler/in-memory-store.js";
import { createRunInputCoordinator } from "../../../../packages/ohbaby-agent/src/runtime/prompt-scheduler/run-input-coordinator.js";

const sessionId = "session";
const runId = "run";
const model = "fixture";

function chunk(delta: object, finish: string | null = null): object {
  return {
    id: "chat_fixture",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

function sse(...events: object[]): Response {
  return new Response(
    events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join(""),
    {
      headers: { "content-type": "text/event-stream", "retry-after": "0" },
    },
  );
}

function streamFailure(text?: string): Response {
  return sse(...(text === undefined ? [] : [chunk({ content: text })]), {
    error: { code: "server_error", message: "controlled stream failure" },
  });
}

function httpFailure(): Response {
  return Response.json(
    { error: { type: "server_error", message: "controlled HTTP failure" } },
    { status: 503, headers: { "retry-after": "0" } },
  );
}

function toolChunk(callId: string, value: string, finish?: string): object {
  return chunk(
    {
      tool_calls: [
        {
          index: 0,
          id: callId,
          type: "function",
          function: { name: "record", arguments: value },
        },
      ],
    },
    finish,
  );
}

async function fixture(
  replies: (() => Response | Promise<Response>)[],
  options: {
    protocol?: "openai-compatible" | "anthropic";
    execute?: (params: Record<string, unknown>) => Promise<{ output: string }>;
  } = {},
) {
  const bodies: string[] = [];
  vi.stubGlobal(
    "fetch",
    (_url: unknown, init?: RequestInit): Promise<Response> => {
      if (typeof init?.body !== "string")
        throw new Error("Expected JSON request");
      bodies.push(init.body);
      const reply = replies.at(bodies.length - 1);
      if (!reply) throw new Error("Unexpected request");
      return Promise.resolve(reply());
    },
  );
  const bus = createBus();
  const updates: Message[] = [];
  bus.subscribe(MessageEvent.Updated, ({ info }) => updates.push(info));
  const messageManager = createMessageManager({
    bus,
    store: createInMemoryMessageStore(),
  });
  const user = await messageManager.createMessage({
    sessionId,
    role: "user",
    agent: "primary",
  });
  await messageManager.appendPart(user.id, {
    type: "text",
    text: "do the task",
  });

  const generateSummary = vi.fn((input: { summaryMessageId: string }) =>
    Promise.resolve({
      text: "recent task checkpoint",
      summaryMessageId: input.summaryMessageId,
      requests: [],
    }),
  );
  const runLedger = createInMemoryRunLedger();
  const inputs = new InMemoryCurrentRunInputStore({
    runLedger,
    messageManager,
    promptStore: new InMemoryPromptSubmissionStore(),
  });
  const contextManager = createContextManager({
    bus,
    filterModelHistory: (history) => inputs.filterModelHistory(history),
    messageManager,
    llmClient: { generateSummary },
    systemPromptProvider: { build: () => Promise.resolve("") },
    tokenCounter: {
      estimateTokens: (value) => Math.ceil(value.length / 4),
      getLimit: () => 100_000,
    },
  });
  const toolScheduler = createToolScheduler({
    bus,
    permission: { ask: () => "once" },
    permissionState: createPermissionState({
      bus,
      initialLevel: "full-access",
    }),
  });
  const schema = { type: "object", properties: { value: { type: "string" } } };
  if (options.execute) {
    toolScheduler.register({
      category: "write",
      source: "builtin",
      name: "record",
      parametersJsonSchema: schema,
      description: "Record value",
      execute: options.execute,
    });
  }
  const baseUrl = "https://step-retry.invalid/v1";
  const protocol = options.protocol ?? "openai-compatible";
  const createProvider =
    protocol === "anthropic"
      ? createAnthropicProvider
      : createOpenAICompatibleProvider;
  const lifecycle = new Lifecycle({
    messageManager,
    contextManager,
    toolScheduler,
    llmClient: {
      provider: createProvider({
        id: "fixture",
        apiKey: "test",
        baseUrl,
      }),
      config: {
        model,
        provider: "fixture",
        baseUrl,
        interfaceProvider: protocol,
        maxTokens: 100,
        modelProfiles: [
          {
            model,
            contextWindowTokens: 100_000,
            reasoningCapabilities: {
              mode: "none",
              wire: "none",
              supportsDisabled: true,
            },
          },
        ],
      },
    },
  });
  const events: LifecycleEvent[] = [];
  return {
    bodies,
    updates,
    events,
    messageManager,
    generateSummary,
    inputs,
    runLedger,
    async run(
      input: Partial<TestLifecycleSessionParams> = {},
      onEvent?: (event: LifecycleEvent) => void,
    ): Promise<LifecycleResult> {
      const iterator = lifecycle.run({
        sessionId,
        runId,
        directory: "/workspace/test",
        modelId: model,
        parentMessageId: user.id,
        ...(options.execute
          ? { tools: [{ name: "record", inputSchema: schema }] }
          : {}),
        ...input,
      });
      for (;;) {
        const next = await iterator.next();
        if (next.done) return next.value;
        events.push(next.value);
        onEvent?.(next.value);
      }
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("lifecycle logical step retries", () => {
  it("replaces only the interrupted step and persists the retry schedule before its failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ohbaby-step-retry-"));
    const path = join(directory, "tool-results");
    try {
      const f = await fixture(
        [
          (): Response =>
            sse(toolChunk("before", '{"value":"prior"}', "tool_calls")),
          (): Response =>
            sse(
              chunk({ content: "first response fragment" }),
              toolChunk("partial", '{"value":'),
            ),
          (): Response =>
            sse(toolChunk("after", '{"value":"retried"}', "tool_calls")),
          (): Response => sse(chunk({ content: "finished" }, "stop")),
        ],
        {
          execute: async ({ value }) => {
            const text = typeof value === "string" ? value : "unexpected";
            await appendFile(path, text + "\n");
            return { output: "recorded " + text };
          },
        },
      );
      const result = await f.run({ directory });
      expect(result).toMatchObject({
        success: true,
        finalResponse: "finished",
      });
      expect(await readFile(path, "utf8")).toBe("prior\nretried\n");
      expect(f.bodies).toHaveLength(4);
      expect(f.bodies[2]).toContain("recorded prior");
      expect(f.bodies[2]).not.toMatch(
        /first response fragment|Response interrupted/,
      );

      const history = await f.messageManager.listBySession(sessionId);
      const dropped = history.find(
        ({ info }) => info.role === "assistant" && info.finish === "error",
      );
      expect(dropped?.parts).toEqual([
        expect.objectContaining({
          type: "text",
          text: "first response fragment",
        }),
      ]);
      expect(dropped?.info).toMatchObject({
        error: { name: "MessageStreamInterruptedError", retried: true },
        modelRequests: [
          {
            purpose: "agent-step",
            outcome: "error",
            step: 2,
            attempt: 1,
            retryScheduled: true,
          },
        ],
      });
      expect(
        serializeHistory(history, { includeToolContext: true }),
      ).not.toMatch(/first response fragment|Response interrupted/);

      const ended = f.events.filter(
        (event) => event.type === "llm:request-ended",
      );
      expect(
        ended.map(({ request }) => [request.step, request.attempt]),
      ).toEqual([
        [1, 1],
        [2, 1],
        [2, 2],
        [3, 1],
      ]);
      expect(ended[1].messageId).toBe(dropped?.info.id);
      expect(ended[2].messageId).not.toBe(ended[1].messageId);
      expect(ended[2].request.requestId).not.toBe(ended[1].request.requestId);
      const scheduleIndex = f.updates.findIndex(
        (message) =>
          message.role === "assistant" &&
          message.id === dropped?.info.id &&
          message.modelRequests?.at(-1)?.retryScheduled === true,
      );
      const failureIndex = f.updates.findIndex(
        (message) =>
          message.role === "assistant" &&
          message.id === dropped?.info.id &&
          message.finish === "error",
      );
      expect(scheduleIndex).toBeGreaterThanOrEqual(0);
      expect(failureIndex).toBeGreaterThan(scheduleIndex);
      expect(f.updates[failureIndex]).toMatchObject({
        error: { name: "MessageStreamInterruptedError", retried: true },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("adds no interruption note to a replaced reasoning-only attempt", async () => {
    const f = await fixture([
      (): Response =>
        sse(chunk({ reasoning_content: "half a thought" }), {
          error: { code: "server_error", message: "controlled stream failure" },
        }),
      (): Response => sse(chunk({ content: "finished" }, "stop")),
    ]);
    expect(await f.run()).toMatchObject({
      success: true,
      finalResponse: "finished",
    });
    const history = await f.messageManager.listBySession(sessionId);
    const dropped = history.find(
      ({ info }) => info.role === "assistant" && info.finish === "error",
    );
    expect(dropped?.info).toMatchObject({
      error: { name: "MessageStreamInterruptedError", retried: true },
    });
    expect(dropped?.parts.map((part) => part.type)).toEqual(["reasoning"]);
  });

  it.each(["backoff", "preparation", "input reconciliation"] as const)(
    "adds an interruption note if a reasoning-only retry is cancelled during %s",
    async (cancelDuring) => {
      const abort = new AbortController();
      const f = await fixture([
        (): Response =>
          sse(chunk({ reasoning_content: "half a thought" }), {
            error: {
              code: "server_error",
              message: "controlled stream failure",
            },
          }),
      ]);
      if (cancelDuring === "input reconciliation") {
        await f.runLedger.createPending({
          runId,
          sessionId,
          triggerSource: "user",
        });
        await f.runLedger.markRunning(runId);
      }
      let reconciliations = 0;
      const currentRunInputs =
        cancelDuring === "input reconciliation"
          ? createRunInputCoordinator({
              runId,
              inputs: f.inputs,
              sources: [
                {
                  reconcile: (signal): Promise<void> => {
                    if (++reconciliations === 2) {
                      abort.abort();
                      signal?.throwIfAborted();
                    }
                    return Promise.resolve();
                  },
                },
              ],
            })
          : undefined;
      let preparations = 0;
      const result = f.run(
        { signal: abort.signal, currentRunInputs },
        (event) => {
          if (
            (cancelDuring === "backoff" && event.type === "llm:retrying") ||
            (cancelDuring === "preparation" &&
              event.type === "context:prepared" &&
              ++preparations === 2)
          )
            abort.abort();
        },
      );
      if (cancelDuring === "input reconciliation") {
        await expect(result).rejects.toMatchObject({ name: "AbortError" });
      } else {
        await expect(result).resolves.toMatchObject({
          terminalReason: "cancelled",
        });
      }
      expect(f.bodies).toHaveLength(1);
      const saved = (await f.messageManager.listBySession(sessionId)).find(
        (record) => record.info.role === "assistant",
      );
      expect(saved?.info).toMatchObject({
        error: { name: "MessageStreamInterruptedError", retried: true },
      });
      expect(saved?.parts.filter(isInterruptionFactPart)).toMatchObject([
        {
          text: "[Response interrupted: the saved text below may be incomplete.]",
        },
      ]);
    },
  );

  it("keeps the partial answer if a retry's assistant exists but Stop prevents its request", async () => {
    const abort = new AbortController();
    const f = await fixture([
      (): Response => streamFailure("still the only partial"),
    ]);
    let assistantStarts = 0;
    const result = await f.run({ signal: abort.signal }, (event) => {
      if (event.type === "llm:start" && ++assistantStarts === 2) abort.abort();
    });
    expect(result.terminalReason).toBe("cancelled");
    expect(assistantStarts).toBe(2);
    expect(f.bodies).toHaveLength(1);
    const history = await f.messageManager.listBySession(sessionId);
    const assistants = history.flatMap((record) => {
      if (record.info.role !== "assistant") return [];
      const message = messageToUiMessage(record);
      return message ? [message] : [];
    });
    expect(assistants).toHaveLength(2);
    expect(assistants[0].modelRequests?.at(-1)?.retryScheduled).toBe(true);
    expect(assistants[1].modelRequests ?? []).toHaveLength(0);
    expect(listRetriedAttemptIds(assistants)).toEqual(new Set());
  });

  it("cancels during backoff after a partial response without opening another request", async () => {
    const controller = new AbortController();
    const f = await fixture([
      (): Response => sse(chunk({ content: "discarded" })),
    ]);
    let stop: NodeJS.Timeout | undefined;
    try {
      const result = await f.run({ signal: controller.signal }, (event) => {
        if (event.type === "llm:retrying")
          stop = setTimeout(() => {
            controller.abort();
          }, 10);
      });
      expect(result).toMatchObject({
        success: false,
        terminalReason: "cancelled",
      });
      expect(f.bodies).toHaveLength(1);
      expect(
        f.events.filter((event) => event.type === "turn:end"),
      ).toMatchObject([{ step: 1, finishReason: "error" }]);
      expect(
        f.events.find((event) => event.type === "llm:request-ended"),
      ).toMatchObject({
        request: { outcome: "error", retryScheduled: true },
      });
      const history = await f.messageManager.listBySession(sessionId);
      expect(serializeHistoryMessages(history)).toEqual([
        { role: "user", content: "do the task" },
      ]);
    } finally {
      if (stop) clearTimeout(stop);
    }
  });

  it.each([true, false])(
    "shares five retries across HTTP and partial-stream failures (final body=%s)",
    async (finalBody) => {
      const f = await fixture([
        httpFailure,
        (): Response => streamFailure("replaced one"),
        httpFailure,
        (): Response => streamFailure("replaced two"),
        httpFailure,
        (): Response =>
          finalBody
            ? sse(
                chunk({ content: "last fragment" }),
                chunk({ reasoning_content: "unsettled reasoning" }),
              )
            : sse(),
      ]);
      const result = await f.run();
      expect(result).toMatchObject({
        success: false,
        terminalReason: "provider_retry_exhausted",
      });
      expect(f.bodies).toHaveLength(6);
      expect(
        f.events
          .filter((event) => event.type === "llm:retrying")
          .map(({ attempt }) => attempt),
      ).toEqual([1, 2, 3, 4, 5]);
      const history = await f.messageManager.listBySession(sessionId);
      expect(serializeHistoryMessages(history)).toEqual([
        { role: "user", content: "do the task" },
        ...(finalBody
          ? [
              {
                role: "assistant",
                content:
                  "[Response interrupted: the saved text below may be incomplete.]\nlast fragment",
              },
            ]
          : []),
      ]);
      expect(history.at(-1)?.info).toMatchObject({
        error: {
          name: finalBody ? "MessageStreamInterruptedError" : "APIError",
        },
      });
      if (finalBody) {
        expect(
          f.events.findLast((event) => event.type === "llm:reasoning-end"),
        ).toMatchObject({
          content: "unsettled reasoning",
          endReason: "interrupted",
        });
      }
    },
  );

  it("keeps the retry budget across forced context compaction", async () => {
    const f = await fixture([
      httpFailure,
      (): Response =>
        Response.json(
          {
            error: {
              code: "context_length_exceeded",
              message: "context length exceeded",
            },
          },
          { status: 400 },
        ),
      (): Response => streamFailure("fragment after compaction"),
      httpFailure,
      httpFailure,
      httpFailure,
      httpFailure,
    ]);
    for (const [index, role] of (
      ["assistant", "user", "assistant", "user"] as const
    ).entries()) {
      const message = await f.messageManager.createMessage({
        sessionId,
        role,
        agent: "primary",
      });
      await f.messageManager.appendPart(message.id, {
        type: "text",
        text: "Older history " + String(index) + " " + "x".repeat(28_000),
      });
      if (role === "assistant")
        await f.messageManager.updateMessage(message.id, { finish: "stop" });
    }
    const result = await f.run();
    expect(result).toMatchObject({
      success: false,
      terminalReason: "provider_retry_exhausted",
    });
    expect(f.generateSummary).toHaveBeenCalledTimes(1);
    expect(f.bodies).toHaveLength(7);
    expect(f.bodies[3]).not.toContain("fragment after compaction");
    expect(
      f.events
        .filter((event) => event.type === "llm:retrying")
        .map(({ attempt }) => attempt),
    ).toEqual([1, 2, 3, 4, 5]);
    expect(
      f.events
        .filter((event) => event.type === "llm:request-ended")
        .map(({ request }) => [request.step, request.attempt]),
    ).toEqual([
      [1, 1],
      [1, 2],
      [1, 2],
      [1, 3],
      [1, 4],
      [1, 5],
      [1, 6],
    ]);
  });

  it("resends an admitted input once and acknowledges it only after success", async () => {
    const f = await fixture([
      (): Response => streamFailure("discarded"),
      async (): Promise<Response> => {
        const pending = await f.inputs.listPending(runId);
        if (pending.length !== 1)
          throw new Error("The first request consumed the pending input");
        return sse(chunk({ content: "finished" }, "stop"));
      },
    ]);
    await f.runLedger.createPending({
      runId,
      sessionId,
      triggerSource: "user",
    });
    await f.runLedger.markRunning(runId);
    await f.inputs.acceptRuntimeInput({
      inputId: "input",
      runId,
      sessionId,
      source: "subagent-message",
      sourceId: "child-message",
      message: {
        info: {
          role: "user",
          id: "child-message",
          sessionId,
          agent: "primary",
          time: { created: Date.now() },
        },
        parts: [
          {
            type: "text",
            id: "child-text",
            messageId: "child-message",
            sessionId,
            orderIndex: 0,
            text: "pending child update",
          },
        ],
      },
    });
    const confirmations = vi.fn((): Promise<void> => Promise.resolve());
    const currentRunInputs = createRunInputCoordinator({
      runId,
      inputs: f.inputs,
      sources: [
        {
          reconcile: (): Promise<void> => Promise.resolve(),
          confirmRequestSuccess: confirmations,
        },
      ],
    });
    const result = await f.run({ currentRunInputs });
    expect(result).toMatchObject({ success: true, finalResponse: "finished" });
    expect(f.bodies).toHaveLength(2);
    expect(
      f.bodies.map((body) => body.match(/pending child update/g)?.length),
    ).toEqual([1, 1]);
    const ended = f.events.filter(
      (event) => event.type === "llm:request-ended",
    );
    const history = await f.messageManager.listBySession(sessionId);
    const attempts = history.flatMap(({ info }) =>
      info.role === "assistant" ? (info.modelRequests ?? []) : [],
    );
    expect(attempts.map((request) => request.inputIds)).toEqual([
      ["input"],
      ["input"],
    ]);
    expect(await f.inputs.getInput("input")).toMatchObject({
      firstAttemptRequestId: ended[0].request.requestId,
      processedRequestId: ended[1].request.requestId,
    });
    expect(confirmations).toHaveBeenCalledTimes(1);
    expect(confirmations).toHaveBeenCalledWith(
      [expect.objectContaining({ inputId: "input" })],
      ended[1].request.requestId,
    );
  });

  it("restarts the step if Anthropic sends text and stop_reason without message_stop", async () => {
    function anthropicMessage(text: string, stopped: boolean): Response {
      const events = [
        {
          type: "message_start",
          message: {
            id: "msg_fixture",
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 12, output_tokens: 0 },
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
          delta: { type: "text_delta", text },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        },
        ...(stopped ? [{ type: "message_stop" }] : []),
      ];
      return new Response(
        events
          .map(
            (event) =>
              "event: " +
              event.type +
              "\ndata: " +
              JSON.stringify(event) +
              "\n\n",
          )
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    const f = await fixture(
      [
        (): Response => anthropicMessage("missing stop fragment", false),
        (): Response => anthropicMessage("done", true),
      ],
      { protocol: "anthropic" },
    );
    const result = await f.run();
    expect(result).toMatchObject({ success: true, finalResponse: "done" });
    expect(f.bodies).toHaveLength(2);
    expect(f.bodies[1]).not.toContain("missing stop fragment");
    expect(
      f.events.find((event) => event.type === "llm:retrying"),
    ).toMatchObject({
      reason: "stream_eof",
    });
  });
});
