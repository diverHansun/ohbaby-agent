import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createBus } from "../../../packages/ohbaby-agent/src/bus/index.js";
import { createPromptCacheUsageTracker } from "../../../packages/ohbaby-agent/src/adapters/ui-inprocess/prompt-cache-usage.js";
import { toModelTools } from "../../../packages/ohbaby-agent/src/core/agents/index.js";
import { createContextManager } from "../../../packages/ohbaby-agent/src/core/context/index.js";
import {
  Lifecycle,
  type LifecycleResult,
} from "../../../packages/ohbaby-agent/src/core/lifecycle/index.js";
import type {
  LLMClientInstance,
  TokenUsage,
} from "../../../packages/ohbaby-agent/src/core/llm-client/index.js";
import {
  createDatabaseMessageStore,
  createMessageManager,
  readTokenUsageMetadata,
} from "../../../packages/ohbaby-agent/src/core/message/index.js";
import { createToolScheduler } from "../../../packages/ohbaby-agent/src/core/tool-scheduler/index.js";
import { createPermissionState } from "../../../packages/ohbaby-agent/src/permission/index.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
  schema,
} from "../../../packages/ohbaby-agent/src/services/database/index.js";
import { createInterfaceProvider } from "../../../packages/ohbaby-agent/src/services/interface-providers/index.js";
import type { NativeResponsesItem } from "../../../packages/ohbaby-agent/src/services/interface-providers/native-state.js";

const sessionId = "native-multistep";
const model = "responses-fixture";
const baseUrl = "https://native-multistep.invalid/v1";
const initialPrompt =
  "Read the first value, then the second value, then answer.";
const nextPrompt = "Continue from the completed native history.";
const finalText = "Both tools completed.";

function outputForStep(step: number): NativeResponsesItem[] {
  const output: NativeResponsesItem[] = [
    {
      type: "reasoning",
      id: `reason-${String(step)}`,
      status: "completed",
      summary: [],
      encrypted_content: `opaque-${String(step)}`,
    },
    step <= 2
      ? {
          type: "function_call",
          id: `item-${String(step)}`,
          call_id: `call-${String(step)}`,
          name: `read_${String(step)}`,
          arguments: "{}",
          status: "completed",
        }
      : {
          type: "message",
          id: `message-${String(step)}`,
          role: "assistant",
          status: "completed",
          phase: "final_answer",
          content: [
            {
              type: "output_text",
              text: step === 3 ? finalText : "History continued.",
              annotations: [],
              logprobs: [],
            },
          ],
        },
  ];
  return step === 4
    ? output.filter((item) => item.type !== "reasoning")
    : output;
}

/** Only HTTP is simulated; the installed Responses SDK consumes these SSE events. */
function responseForStep(step: number): Response {
  const output = outputForStep(step);
  const events = output.flatMap(
    (item, output_index): Record<string, unknown>[] => {
      const ref = { item_id: item.id, output_index };
      if (item.type === "reasoning")
        return [
          {
            type: "response.output_item.added",
            ...ref,
            item: { ...item, status: "in_progress", encrypted_content: null },
          },
          { type: "response.output_item.done", ...ref, item },
        ];
      if (item.type === "function_call")
        return [
          {
            type: "response.output_item.added",
            ...ref,
            item: { ...item, status: "in_progress", arguments: "" },
          },
          {
            type: "response.function_call_arguments.delta",
            ...ref,
            delta: item.arguments,
          },
          {
            type: "response.function_call_arguments.done",
            ...ref,
            arguments: item.arguments,
          },
          { type: "response.output_item.done", ...ref, item },
        ];
      const part = item.content[0];
      const partRef = { ...ref, content_index: 0 };
      return [
        {
          type: "response.output_item.added",
          ...ref,
          item: { ...item, status: "in_progress", content: [] },
        },
        {
          type: "response.content_part.added",
          ...partRef,
          part: { ...part, text: "" },
        },
        {
          type: "response.output_text.delta",
          ...partRef,
          delta: part.text,
          logprobs: [],
        },
        {
          type: "response.output_text.done",
          ...partRef,
          text: part.text,
          logprobs: [],
        },
        { type: "response.content_part.done", ...partRef, part },
        { type: "response.output_item.done", ...ref, item },
      ];
    },
  );
  events.push({
    type: "response.completed",
    response: {
      id: `response-${String(step)}`,
      status: "completed",
      output,
      store: false,
      previous_response_id: null,
      usage: {
        input_tokens: step * 100,
        output_tokens: 20,
        total_tokens: step * 100 + 20,
        input_tokens_details: {
          cached_tokens: [20, 100, 240, 160, 300][step - 1],
        },
        output_tokens_details: { reasoning_tokens: step === 4 ? 0 : 8 },
      },
    },
  });
  return new Response(
    events
      .map(
        (event) =>
          `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

it("replays two native tool roundtrips in one Run exactly once, then continues the next user Run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ohbaby-native-multistep-"));
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    (url: unknown, init: RequestInit): Promise<Response> => {
      expect(String(url)).toBe(`${baseUrl}/responses`);
      if (requests.length >= 5 || typeof init.body !== "string")
        throw new Error("Unexpected fixture HTTP request");
      requests.push(JSON.parse(init.body) as Record<string, unknown>);
      return Promise.resolve(responseForStep(requests.length));
    },
  );
  try {
    initDatabase({ dbPath: join(directory, "agent.db") });
    getDatabase()
      .prepare(
        `INSERT INTO ${schema.session.tableName} (id, project_id, project_root, agent, title, status, created_at, updated_at, message_count, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        "fixture-project",
        directory,
        "build",
        "Native multi-step",
        "active",
        1,
        1,
        0,
        "{}",
      );
    const bus = createBus();
    const messages = createMessageManager({
      bus,
      store: createDatabaseMessageStore(),
    });
    const scheduler = createToolScheduler({
      bus,
      permission: { ask: () => "once" },
      permissionState: createPermissionState({
        bus,
        initialLevel: "full-access",
      }),
    });
    const executed: number[] = [];
    for (const index of [1, 2])
      scheduler.register({
        name: `read_${String(index)}`,
        source: "builtin",
        category: "readonly",
        description: `Read synthetic value ${String(index)}`,
        parametersJsonSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        execute: async () => {
          // Execution must observe the committed state and its own pending descriptor.
          const history = await messages.listBySession(sessionId);
          const assistant = history.find((message) =>
            message.parts.some(
              (part) =>
                part.type === "tool" && part.callId === `call-${String(index)}`,
            ),
          );
          expect(assistant?.info.time.completed).toBeDefined();
          expect(
            assistant?.parts.filter((part) => part.type === "model-state"),
          ).toHaveLength(1);
          expect(
            assistant?.parts.filter((part) => part.type === "tool"),
          ).toHaveLength(1);
          executed.push(index);
          return { output: `result-${String(index)}` };
        },
      });
    const context = createContextManager({
      bus,
      messageManager: messages,
      memory: {
        load: () => Promise.resolve({ global: "", project: "", merged: "" }),
      },
      systemPromptProvider: {
        build: () =>
          Promise.resolve("Complete both tool calls before answering."),
      },
      tokenCounter: {
        estimateTokens: (text) => Math.ceil(text.length / 4),
        getLimit: () => 100000,
      },
      llmClient: {
        generateSummary: () =>
          Promise.reject(new Error("Unexpected compaction")),
      },
    });
    const client: LLMClientInstance = {
      provider: createInterfaceProvider({
        id: "fixture",
        interfaceProvider: "openai-responses",
        baseUrl,
        apiKey: "local-fixture-key",
      }),
      config: {
        provider: "fixture",
        model,
        interfaceProvider: "openai-responses",
        baseUrl,
        maxTokens: 512,
        reasoning: { enabled: true, effort: "medium" },
        modelProfiles: [
          {
            provider: "fixture",
            model,
            contextWindowTokens: 100000,
            reasoningCapabilities: {
              mode: "effort",
              wire: "openai",
              efforts: ["medium", "high"],
              supportsDisabled: true,
            },
          },
        ],
      },
    };
    const lifecycle = new Lifecycle({
      llmClient: client,
      contextManager: context,
      messageManager: messages,
      toolScheduler: scheduler,
    });
    const tracker = createPromptCacheUsageTracker();
    const acceptedSteps: { step: number; usage: TokenUsage | undefined }[] = [];
    const run = async (text: string): Promise<LifecycleResult> => {
      const user = await messages.createMessage({
        sessionId,
        agent: "build",
        role: "user",
      });
      await messages.appendPart(user.id, { type: "text", text });
      const loop = lifecycle.run({
        sessionId,
        directory,
        modelId: model,
        initiatingUserMessageId: user.id,
        maxSteps: 4,
        tools: toModelTools(await scheduler.getAvailableTools()),
        environment: {
          workdir: directory,
          resolvePath: (path) => join(directory, path),
          resolvePathForExisting: (path) =>
            Promise.resolve(join(directory, path)),
          resolvePathForWrite: (path) => Promise.resolve(join(directory, path)),
          resolveCommandContext: () => ({ cwd: directory, kind: "host-local" }),
        },
        onStepUsage: (observation) => {
          acceptedSteps.push({
            step: observation.step,
            usage: observation.tokenUsage,
          });
          tracker.record(sessionId, observation.tokenUsage);
        },
      });
      let next = await loop.next();
      while (!next.done) next = await loop.next();
      return next.value;
    };

    const result = await run(initialPrompt);
    expect(result).toMatchObject({
      success: true,
      finalResponse: finalText,
      usage: { inputTokens: 600, outputTokens: 60, totalTokens: 660 },
    });
    expect(executed).toEqual([1, 2]);
    expect(acceptedSteps.map((observation) => observation.step)).toEqual([
      1, 2, 3,
    ]);
    expect(
      acceptedSteps.map((observation) => observation.usage?.inputTokens),
    ).toEqual([100, 200, 300]);
    expect(tracker.get(sessionId)).toEqual({
      sessionId,
      accountedInputTokens: 600,
      cacheReadTokens: 360,
      cacheReadShare: 0.6,
    });
    expect(requests).toHaveLength(3);
    const history1 = [
      { role: "user", content: initialPrompt },
      ...outputForStep(1),
      { type: "function_call_output", call_id: "call-1", output: "result-1" },
    ];
    const history2 = [
      ...history1,
      ...outputForStep(2),
      { type: "function_call_output", call_id: "call-2", output: "result-2" },
    ];
    expect(requests.map((request) => request.input)).toEqual([
      [{ role: "user", content: initialPrompt }],
      history1,
      history2,
    ]);
    expect(
      requests.every(
        (request) =>
          JSON.stringify(request.reasoning) ===
          JSON.stringify({ effort: "medium" }),
      ),
    ).toBe(true);
    const firstHistory = await messages.listBySession(sessionId);
    const assistants = firstHistory.filter(
      (message) => message.info.role === "assistant",
    );
    expect(assistants).toHaveLength(3);
    expect(
      assistants.map(
        (message) =>
          message.parts.filter((part) => part.type === "model-state").length,
      ),
    ).toEqual([1, 1, 1]);
    expect(
      assistants.map(
        (message) =>
          message.parts.filter(
            (part) => readTokenUsageMetadata(part.metadata) !== undefined,
          ).length,
      ),
    ).toEqual([1, 1, 1]);
    expect(
      assistants
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "tool")
        .map((part) => part.state.status),
    ).toEqual(["completed", "completed"]);

    client.config.reasoning = { enabled: false, effort: "high" };
    const continued = await run(nextPrompt);
    expect(continued).toMatchObject({
      success: true,
      finalResponse: "History continued.",
      usage: { inputTokens: 400, outputTokens: 20, totalTokens: 420 },
    });
    expect(requests).toHaveLength(4);
    expect(requests[3].reasoning).toEqual({ effort: "none" });
    expect(requests[3].input).toEqual([
      ...history2,
      ...outputForStep(3),
      { role: "user", content: nextPrompt },
    ]);
    expect(executed).toEqual([1, 2]);
    expect(
      acceptedSteps.map((observation) => observation.usage?.inputTokens),
    ).toEqual([100, 200, 300, 400]);
    expect(tracker.get(sessionId)).toEqual({
      sessionId,
      accountedInputTokens: 1000,
      cacheReadTokens: 520,
      cacheReadShare: 0.52,
    });
    client.config.reasoning = { enabled: true, effort: "high" };
    const highPrompt = "Continue with high reasoning.";
    const high = await run(highPrompt);
    expect(high.success).toBe(true);
    expect(requests).toHaveLength(5);
    expect(requests[4].reasoning).toEqual({ effort: "high" });
    expect(requests[4].input).toEqual([
      ...history2,
      ...outputForStep(3),
      { role: "user", content: nextPrompt },
      ...outputForStep(4),
      { role: "user", content: highPrompt },
    ]);
    expect(executed).toEqual([1, 2]);
    expect(acceptedSteps.map((observation) => observation.step)).toEqual([
      1, 2, 3, 1, 1,
    ]);
    expect(tracker.get(sessionId)).toEqual({
      sessionId,
      accountedInputTokens: 1500,
      cacheReadTokens: 820,
      cacheReadShare: 820 / 1500,
    });
  } finally {
    closeDatabase();
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  }
});
