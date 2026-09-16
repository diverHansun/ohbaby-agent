import { afterEach, describe, expect, it, vi } from "vitest";
import { createBus } from "../../bus/index.js";
import { createContextManager } from "../../core/context/index.js";
import { Lifecycle } from "../../core/lifecycle/index.js";
import type { LLMClientInstance } from "../../core/llm-client/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
  readTokenUsageMetadata,
} from "../../core/message/index.js";
import type { ToolSchedulerInstance } from "../../core/tool-scheduler/index.js";
import { createAnthropicProvider } from "../../services/interface-providers/anthropic.js";
import { createOpenAICompatibleProvider } from "../../services/interface-providers/openai-compatible.js";
import { createOpenAIResponsesProvider } from "../../services/interface-providers/openai-responses.js";
import type { InterfaceProviderStreamEvent } from "../../services/interface-providers/types.js";
import { RunManager } from "../../runtime/run-manager/index.js";
import { createInMemoryRunLedger } from "../../runtime/run-ledger/index.js";
import {
  createInMemoryStreamBridge,
  END_SENTINEL,
  HEARTBEAT_SENTINEL,
  type StreamBridgeEvent,
} from "../../runtime/stream-bridge/index.js";
import { createInMemoryUiStateStore } from "../ui-state/index.js";
import { createHostLocalSandboxManager } from "./host-local-environment.js";
import { startRunStreamProjection } from "./run-stream-adapter.js";

type Protocol = "openai-compatible" | "openai-responses" | "anthropic";
type Finish = "length" | "content_filter";
const body = "Visible unfinished model answer";
const usage = { inputTokens: 12, outputTokens: 5, totalTokens: 17 };

// The installed SDK decodes these wire fixtures. Neither the adapter nor the
// Lifecycle/Worker result is mocked. Every response includes a tool candidate.
function events(protocol: Protocol, finish: Finish): Record<string, unknown>[] {
  if (protocol === "openai-compatible")
    return [
      {
        id: "chat",
        object: "chat.completion.chunk",
        created: 0,
        model: "fixture",
        choices: [
          {
            index: 0,
            delta: {
              content: body,
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "lookup", arguments: "{}" },
                },
              ],
            },
            finish_reason: finish,
          },
        ],
      },
      {
        id: "chat",
        object: "chat.completion.chunk",
        created: 0,
        model: "fixture",
        choices: [],
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
      },
    ];
  if (protocol === "anthropic")
    return [
      {
        type: "message_start",
        message: {
          id: "message",
          type: "message",
          role: "assistant",
          model: "fixture",
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
        delta: { type: "text_delta", text: body },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "call_1",
          name: "lookup",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: "{}" },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "message_delta",
        delta: {
          stop_reason: finish === "length" ? "max_tokens" : "refusal",
          stop_sequence: null,
        },
        usage: { output_tokens: 5 },
      },
      { type: "message_stop" },
    ];
  const part = {
    type: "output_text",
    text: body,
    annotations: [],
    logprobs: [],
  };
  const message = {
    id: "message",
    type: "message",
    role: "assistant",
    status: "incomplete",
    content: [part],
  };
  const call = {
    id: "item_1",
    type: "function_call",
    call_id: "call_1",
    name: "lookup",
    arguments: "{}",
    status: "completed",
  };
  const ref = { item_id: "message", output_index: 0, content_index: 0 };
  return [
    {
      type: "response.output_item.added",
      ...ref,
      item: { ...message, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      ...ref,
      part: { ...part, text: "" },
    },
    { type: "response.output_text.delta", ...ref, delta: body, logprobs: [] },
    { type: "response.output_text.done", ...ref, text: body, logprobs: [] },
    { type: "response.content_part.done", ...ref, part },
    { type: "response.output_item.done", ...ref, item: message },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { ...call, status: "in_progress", arguments: "" },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 1,
      item_id: "item_1",
      delta: "{}",
    },
    {
      type: "response.function_call_arguments.done",
      output_index: 1,
      item_id: "item_1",
      arguments: "{}",
    },
    { type: "response.output_item.done", output_index: 1, item: call },
    {
      type: "response.incomplete",
      response: {
        id: "response",
        status: "incomplete",
        output: [message, call],
        previous_response_id: null,
        store: false,
        incomplete_details: {
          reason: finish === "length" ? "max_output_tokens" : "content_filter",
        },
        usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
      },
    },
  ];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("three protocol terminal outcomes through RunManager, Worker and UI", () => {
  it.each(
    (["openai-compatible", "openai-responses", "anthropic"] as const).flatMap(
      (protocol) =>
        (["length", "content_filter"] as const).map((finish) => ({
          protocol,
          finish,
        })),
    ),
  )(
    "preserves $protocol $finish as one accepted failed step",
    async ({ protocol, finish }) => {
      const wire =
        events(protocol, finish)
          .map(
            (event) =>
              `${protocol === "openai-compatible" ? "" : `event: ${String(event.type)}\n`}data: ${JSON.stringify(event)}\n\n`,
          )
          .join("") +
        (protocol === "openai-compatible" ? "data: [DONE]\n\n" : "");
      const http = vi.fn(() =>
        Promise.resolve(
          new Response(wire, {
            headers: { "content-type": "text/event-stream" },
          }),
        ),
      );
      vi.stubGlobal("fetch", http);
      const options = {
        id: "fixture",
        apiKey: "fixture-only",
        baseUrl: "https://fixture.invalid/v1",
      };
      const provider =
        protocol === "anthropic"
          ? createAnthropicProvider(options)
          : protocol === "openai-responses"
            ? createOpenAIResponsesProvider(options)
            : createOpenAICompatibleProvider(options);
      const original = provider.streamResponse.bind(provider);
      let exhausted = false;
      const providerCalls = vi
        .spyOn(provider, "streamResponse")
        .mockImplementation(async (request) => {
          const stream = await original(request);
          return (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
            for await (const frame of stream) yield frame;
            exhausted = true;
          })();
        });
      const llmClient: LLMClientInstance = {
        provider,
        config: {
          provider: "fixture",
          model: "fixture",
          baseUrl: options.baseUrl,
          interfaceProvider: protocol,
          maxTokens: 128,
          promptCache: "disabled",
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
      };
      const bus = createBus();
      const messageManager = createMessageManager({
        bus,
        store: createInMemoryMessageStore(),
      });
      const user = await messageManager.createMessage({
        sessionId: "session",
        role: "user",
        agent: "build",
      });
      await messageManager.appendPart(user.id, {
        type: "text",
        text: "answer",
      });
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
          getLimit: () => 100000,
        },
      });
      const executeBatch = vi.fn<ToolSchedulerInstance["executeBatch"]>();
      const lifecycle = new Lifecycle({
        contextManager,
        llmClient,
        messageManager,
        toolScheduler: { executeBatch } as unknown as ToolSchedulerInstance,
      });
      const streamBridge = createInMemoryStreamBridge({
        heartbeatIntervalMs: 0,
      });
      const recorded: StreamBridgeEvent[] = [];
      const collecting = (async (): Promise<void> => {
        for await (const event of streamBridge.subscribe("run/terminal", 0))
          if (event !== END_SENTINEL && event !== HEARTBEAT_SENTINEL) {
            if (event.event === "run.llm.complete")
              expect(exhausted).toBe(true);
            recorded.push(event);
          }
      })();
      const ledger = createInMemoryRunLedger();
      const observer = vi.fn();
      const runManager = new RunManager({
        lifecycle,
        streamBridge,
        runLedger: ledger,
        sandboxManager: createHostLocalSandboxManager(process.cwd()),
        onStepUsage: observer,
        policy: {
          defaults: {
            user: {
              permissionProfileId: "interactive",
              multitaskStrategy: "reject",
              disconnectMode: "continue",
            },
          },
        },
      });
      const stateStore = createInMemoryUiStateStore({
        activeSessionId: "session",
        permissions: [],
        runs: [],
        sessions: [
          {
            id: "session",
            title: "test",
            messages: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        status: { kind: "idle" },
      });
      const publish = vi.fn();
      const projection = startRunStreamProjection({
        streamBridge,
        stateStore,
        runId: "terminal",
        sessionId: "session",
        assistantMessageId: "ui-assistant",
        nextMessageId: () => "ui-next",
        timestamp: () => "2026-01-01T00:00:01.000Z",
        publish,
      });
      const run = await runManager.create({
        runId: "terminal",
        sessionId: "session",
        directory: process.cwd(),
        modelId: "fixture",
        triggerSource: "user",
        initiatingUserMessageId: user.id,
        tools: [{ name: "lookup", inputSchema: { type: "object" } }],
      });
      const result = await runManager.waitForCompletion(run.runId);
      await Promise.all([collecting, projection.done]);
      expect(result).toMatchObject({
        status: "failed",
        terminalReason:
          finish === "length" ? "output_length" : "content_filter",
        usage: { ...usage, usageComplete: true },
        errorData: {
          code: finish === "length" ? "OUTPUT_LENGTH" : "CONTENT_FILTER",
          retryable: false,
        },
      });
      expect(await ledger.get(run.runId)).toMatchObject({
        status: "failed",
        errorData: { retryable: false, terminalReason: result.terminalReason },
      });
      expect(
        recorded.filter((event) => event.event === "run.llm.complete"),
      ).toHaveLength(1);
      expect(
        recorded.filter(
          (event) =>
            event.event === "run.llm.retrying" ||
            event.event === "run.tool.start",
        ),
      ).toEqual([]);
      expect(
        recorded.filter(
          (event) =>
            event.event === "run.updated" &&
            (event.data as { run?: { status?: string } }).run?.status ===
              "failed",
        ),
      ).toHaveLength(1);
      expect(providerCalls).toHaveBeenCalledTimes(1);
      expect(http).toHaveBeenCalledTimes(1);
      expect(executeBatch).not.toHaveBeenCalled();
      expect(observer).toHaveBeenCalledTimes(1);
      const history = await messageManager.listBySession("session");
      const assistant = history.find(
        (message) => message.info.role === "assistant",
      );
      expect(assistant?.info).toMatchObject({
        finish: "error",
        error: {
          name:
            finish === "length"
              ? "MessageOutputLengthError"
              : "MessageContentFilterError",
        },
      });
      expect(
        assistant?.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text),
      ).toEqual([body]);
      expect(
        assistant?.parts.filter(
          (part) => part.type === "tool" || part.type === "model-state",
        ),
      ).toEqual([]);
      expect(
        assistant?.parts
          .map((part) => readTokenUsageMetadata(part.metadata))
          .filter(Boolean),
      ).toEqual([usage]);
      const snapshot = await stateStore.readSnapshot();
      expect(snapshot.runs).toHaveLength(1);
      expect(snapshot.runs[0]).toMatchObject({
        id: run.runId,
        terminalReason: result.terminalReason,
        status: { kind: "error" },
      });
      expect(snapshot.sessions[0].messages).toHaveLength(1);
      expect(snapshot.sessions[0].messages[0]).toMatchObject({
        completedAt: expect.any(String) as string,
        status: "error",
        parts: [{ type: "text", text: body }],
      });
    },
  );
});
