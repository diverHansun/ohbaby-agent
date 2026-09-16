import { expect, it, vi } from "vitest";
import { createBus } from "../../bus/index.js";
import { createContextManager, type PreparedTurn } from "../context/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../message/index.js";
import { createToolScheduler } from "../tool-scheduler/index.js";
import { createPermissionState } from "../../permission/index.js";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
} from "../../services/interface-providers/types.js";
import type { LLMClientInstance } from "../llm-client/index.js";
import { Lifecycle } from "./lifecycle.js";
import type { LifecycleEvent, ResolvedStepTools } from "./types.js";

it("measures and sends each changed toolset with ordered mixed tool results and permitted failure history", async () => {
  const bus = createBus();
  const messageManager = createMessageManager({
    bus,
    store: createInMemoryMessageStore(),
  });
  const prior = await messageManager.createMessage({
    sessionId: "session",
    role: "assistant",
    agent: "build",
  });
  await messageManager.appendPart(prior.id, {
    type: "text",
    text: "previous limited answer",
  });
  await messageManager.updateMessage(prior.id, {
    finish: "error",
    error: { name: "MessageOutputLengthError" },
  });
  const user = await messageManager.createMessage({
    sessionId: "session",
    role: "user",
    agent: "build",
  });
  await messageManager.appendPart(user.id, {
    type: "text",
    text: "Look up missing and present records, then summarize",
  });
  const countedPayloads: string[] = [];
  const contextManager = createContextManager({
    bus,
    messageManager,
    llmClient: { generateSummary: () => Promise.resolve("unused") },
    memory: {
      load: () => Promise.resolve({ global: "", project: "", merged: "" }),
    },
    systemPromptProvider: { build: () => Promise.resolve("system") },
    tokenCounter: {
      estimateTokens: (text) => {
        countedPayloads.push(text);
        return text.length;
      },
      getLimit: () => 100000,
    },
  });
  const prepared: { turn: PreparedTurn; payloads: string[] }[] = [];
  const prepare = contextManager.prepareTurn.bind(contextManager);
  vi.spyOn(contextManager, "prepareTurn").mockImplementation(async (input) => {
    const start = countedPayloads.length;
    const turn = await prepare(input);
    prepared.push({ turn, payloads: countedPayloads.slice(start) });
    return turn;
  });
  const scheduler = createToolScheduler({
    bus,
    permission: { ask: () => "once" },
    permissionState: createPermissionState({
      bus,
      initialLevel: "full-access",
    }),
  });
  const finished: string[] = [];
  const execute = vi.fn((params: Record<string, unknown>) => {
    const key = String(params.key);
    finished.push(key);
    if (key === "missing")
      throw new Error("Record missing: correct the key and continue");
    return { output: "present record value" };
  });
  const lookupSchema = {
    type: "object",
    properties: { key: { type: "string" } },
    required: ["key"],
  };
  scheduler.register({
    name: "lookup",
    source: "builtin",
    category: "readonly",
    description: "Lookup a record",
    parametersJsonSchema: lookupSchema,
    execute,
  });
  const firstTools = [{ name: "lookup", inputSchema: lookupSchema }];
  const secondTools = [
    {
      name: "summarize",
      inputSchema: {
        type: "object",
        properties: { concise: { type: "boolean" } },
      },
    },
  ];
  const requests: InterfaceProviderRequest[] = [];
  const llmClient: LLMClientInstance = {
    config: {
      provider: "fixture",
      model: "fixture",
      interfaceProvider: "openai-compatible",
      baseUrl: "https://fixture.invalid",
      maxTokens: 128,
      modelProfiles: [
        {
          model: "fixture",
          contextWindowTokens: 100000,
          reasoningCapabilities: {
            mode: "none",
            wire: "none",
            supportsDisabled: true,
          },
        },
      ],
    },
    provider: {
      id: "fixture",
      kind: "openai-compatible",
      client: {},
      isAbortError: () => false,
      streamResponse(
        request,
      ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
        requests.push(request);
        const step = requests.length;
        return Promise.resolve(
          (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
            if (step === 1)
              yield await Promise.resolve({
                toolCallDeltas: [
                  {
                    index: 0,
                    id: "call_missing",
                    name: "lookup",
                    argumentsDelta: '{"key":"missing"}',
                  },
                  {
                    index: 1,
                    id: "call_present",
                    name: "lookup",
                    argumentsDelta: '{"key":"present"}',
                  },
                ],
                finishReason: "tool_calls",
              });
            else
              yield await Promise.resolve({
                textDelta: "Recovered using the present record",
                finishReason: "stop",
              });
          })(),
        );
      },
    },
  };
  const resolvedSteps: number[] = [];
  const lifecycle = new Lifecycle({
    llmClient,
    messageManager,
    contextManager,
    toolScheduler: scheduler,
    resolveTools: ({ step }): ResolvedStepTools => {
      resolvedSteps.push(step);
      return {
        definitions: undefined,
        requestTools: step === 1 ? firstTools : secondTools,
      };
    },
  });
  const seen: LifecycleEvent[] = [];
  const iterator = lifecycle.run({
    sessionId: "session",
    modelId: "fixture",
    directory: process.cwd(),
  });
  let next = await iterator.next();
  while (!next.done) {
    seen.push(next.value);
    next = await iterator.next();
  }
  expect(next.value).toMatchObject({
    success: true,
    terminalReason: "completed",
    finalResponse: "Recovered using the present record",
  });
  expect(resolvedSteps).toEqual([1, 2]);
  expect(requests).toHaveLength(2);
  expect(prepared).toHaveLength(2);
  expect(
    requests.map((request) => request.tools?.map((tool) => tool.name)),
  ).toEqual([["lookup"], ["summarize"]]);
  for (const [index, request] of requests.entries()) {
    const { turn, payloads } = prepared[index];
    expect({ messages: request.messages, tools: request.tools }).toEqual(
      turn.request,
    );
    expect(request.tools).toBe(turn.request.tools);
    expect(Object.isFrozen(turn.request)).toBe(true);
    expect(Object.isFrozen(turn.request.messages)).toBe(true);
    expect(Object.isFrozen(turn.request.tools)).toBe(true);
    // Plain messages have no private state, so this is the exact visible request
    // material that must have reached the injected counting boundary.
    const sentText = [
      ...request.messages.map((message) => JSON.stringify(message)),
      JSON.stringify(request.tools),
    ].join("\n");
    expect(payloads).toContain(sentText);
    expect(turn.sentHeuristic).toBe(sentText.length);
    expect(turn.usage.currentTokens).toBe(sentText.length);
    expect(JSON.stringify(request.messages)).toContain(
      "[Response incomplete: output limit reached.]\\nprevious limited answer",
    );
  }
  expect(prepared[1].turn.sentHeuristic).not.toBe(
    prepared[0].turn.sentHeuristic,
  );
  expect(execute).toHaveBeenCalledTimes(2);
  expect(finished).toEqual(["missing", "present"]);
  const secondHistory = requests[1].messages;
  const call = secondHistory.find(
    (message) =>
      message.role === "assistant" && message.toolCalls?.length === 2,
  );
  expect(call).toMatchObject({
    toolCalls: [
      {
        callId: "call_missing",
        name: "lookup",
        argumentsJson: '{"key":"missing"}',
      },
      {
        callId: "call_present",
        name: "lookup",
        argumentsJson: '{"key":"present"}',
      },
    ],
  });
  const results = secondHistory.filter((message) => message.role === "tool");
  expect(results.map((message) => message.callId)).toEqual([
    "call_missing",
    "call_present",
  ]);
  expect(results[0].content).toContain(
    "Record missing: correct the key and continue",
  );
  expect(results[1].content).toBe("present record value");
  const parts = (await messageManager.listBySession("session"))
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "tool");
  expect(parts).toMatchObject([
    {
      callId: "call_missing",
      state: { status: "error", input: { key: "missing" } },
    },
    {
      callId: "call_present",
      state: {
        status: "completed",
        input: { key: "present" },
        output: "present record value",
      },
    },
  ]);
  const toolResults = seen.filter((event) => event.type === "tool:result");
  expect(
    toolResults.map((event) => [event.callId, event.result.status]),
  ).toEqual([
    ["call_missing", "error"],
    ["call_present", "success"],
  ]);
  expect(seen.filter((event) => event.type === "llm:complete")).toHaveLength(2);
});
