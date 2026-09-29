import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createBus } from "../../../packages/ohbaby-agent/src/bus/index.js";
import {
  type ContextManager,
  type ContextUsage,
  type PreparedModelRequest,
  type PreparedTurn,
} from "../../../packages/ohbaby-agent/src/core/context/index.js";
import { Lifecycle } from "../../../packages/ohbaby-agent/src/core/lifecycle/index.js";
import type { LLMClientInstance } from "../../../packages/ohbaby-agent/src/core/llm-client/index.js";
import {
  createDatabaseMessageStore,
  createInMemoryMessageStore,
  createMessageManager,
} from "../../../packages/ohbaby-agent/src/core/message/index.js";
import type { MessageIdGenerator } from "../../../packages/ohbaby-agent/src/core/message/index.js";
import { createToolScheduler } from "../../../packages/ohbaby-agent/src/core/tool-scheduler/index.js";
import { createPermissionState } from "../../../packages/ohbaby-agent/src/permission/index.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
  schema,
} from "../../../packages/ohbaby-agent/src/services/database/index.js";
import { SourceSessionProjection } from "../../../packages/ohbaby-agent/src/adapters/ui-state/source-session-projection.js";
import type {
  InterfaceProviderRequest as ProviderRequest,
  InterfaceProviderStreamEvent as ProviderStreamEvent,
} from "../../../packages/ohbaby-agent/src/services/interface-providers/index.js";

interface FakeSdkClient {
  readonly kind: "fake";
}

const SESSION_USAGE: ContextUsage = {
  contextLimit: 100_000,
  currentTokens: 120,
  modelId: "fake-model",
  remainingTokens: 99_880,
  usageRatio: 0.0012,
};

function preparedTurn(
  messages: PreparedModelRequest["messages"],
): PreparedTurn {
  return {
    assembledAt: 1_700_000_000_000,
    hasSummary: false,
    request: { messages, tools: undefined },
    sentHeuristic: messages.map((message) => JSON.stringify(message)).join("\n")
      .length,
    usage: SESSION_USAGE,
  };
}

function createContextManagerMock(
  prepareTurn: ContextManager["prepareTurn"],
): ContextManager {
  return {
    assemble: vi.fn(),
    compact: vi.fn(),
    createRunPromptSnapshot: vi.fn().mockResolvedValue({
      memory: { global: "", merged: "", project: "" },
      systemPrompt: "",
    }),
    disposeScope: vi.fn(),
    disposeSession: vi.fn(),
    getUsage: vi.fn(),
    prepareTurn,
    resetTurnCompactionCount: vi.fn(),
    updateCalibrationFactor: vi.fn(),
  };
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

function insertSession(sessionId: string): void {
  getDatabase()
    .prepare(
      `INSERT INTO ${schema.session.tableName}
        (id, project_id, project_root, agent, title, status, created_at, updated_at, message_count, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      "project_1",
      "D:/repo",
      "default",
      "Session",
      "active",
      1_700_000_000_000,
      1_700_000_000_000,
      0,
      "{}",
    );
}

function createProviderStream(
  events: readonly ProviderStreamEvent[],
): AsyncGenerator<ProviderStreamEvent, void, unknown> {
  return (async function* (): AsyncGenerator<
    ProviderStreamEvent,
    void,
    unknown
  > {
    for (const event of events) {
      yield await Promise.resolve(event);
    }
  })();
}

function createSequentialFakeLLMClient(
  eventBatches: readonly (readonly ProviderStreamEvent[])[],
  requests: ProviderRequest[],
): LLMClientInstance<FakeSdkClient> {
  let nextBatch = 0;

  return {
    provider: {
      id: "fake",
      kind: "openai-compatible",
      client: { kind: "fake" },
      streamResponse(
        request: ProviderRequest,
      ): Promise<AsyncIterable<ProviderStreamEvent>> {
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
      interfaceProvider: "openai-compatible",
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
      model: "fake-model",
      baseUrl: "https://example.invalid/v1",
      temperature: 0,
      maxTokens: 128,
    },
  };
}

it.each([
  ["memory", 4],
  ["memory", 1026],
  ["sqlite", 4],
  ["sqlite", 1026],
] as const)(
  "keeps timers responsive through real %s projection of %i tool calls",
  async (kind, count) => {
    const directory = await mkdtemp(join(tmpdir(), "batch-fairness-"));
    const bus = createBus();
    if (kind === "sqlite") {
      initDatabase({ dbPath: join(directory, "batch.db") });
      insertSession("session_1");
    }
    const manager = createMessageManager({
      bus,
      store:
        kind === "sqlite"
          ? createDatabaseMessageStore()
          : createInMemoryMessageStore(),
      idGenerator: createDeterministicIds(),
    });
    let publications = 0;
    let bytes = 0;
    const source = new SourceSessionProjection({
      runtimeEpoch: "fairness",
      messageManager: manager,
      metadata: async (id) => ({
        id,
        title: "fixture",
        createdAt: "2026-09-26",
        updatedAt: "2026-09-26",
      }),
      runs: async () => [],
      prompts: async () => [],
      publish: (event) => {
        publications++;
        bytes += Buffer.byteLength(JSON.stringify(event));
      },
    });
    const scheduler = createToolScheduler({
      bus,
      permissionState: createPermissionState({
        bus,
        initialLevel: "full-access",
      }),
    });
    const { withToolAdmission } =
      await import("../../../packages/ohbaby-agent/src/core/tool-scheduler/tool-admission.js");
    let invoked = 0;
    scheduler.register(
      withToolAdmission(
        {
          name: "fairness_fixture",
          source: "builtin",
          category: "readonly",
          description: "fixture",
          parametersJsonSchema: { type: "object" },
          execute: async () => {
            invoked++;
            return { output: "ok" };
          },
        },
        { plan: () => [] },
      ),
    );
    const requests: ProviderRequest[] = [];
    const lifecycle = new Lifecycle({
      messageManager: manager,
      toolScheduler: scheduler,
      contextManager: createContextManagerMock(async () =>
        preparedTurn([{ role: "user", content: "work" }]),
      ),
      llmClient: createSequentialFakeLLMClient(
        [
          [
            {
              toolCallDeltas: Array.from({ length: count }, (_, index) => ({
                id: `call_${index}`,
                index,
                name: "fairness_fixture",
                argumentsDelta: "{}",
              })),
              finishReason: "tool_calls",
            },
          ],
          [{ textDelta: "done", finishReason: "stop" }],
        ],
        requests,
      ),
    });
    await source.owner.initialize("session_1");
    const started = performance.now();
    let lastTick = started;
    let maxGap = 0;
    let ticks = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - lastTick);
      lastTick = now;
      ticks++;
    }, 10);
    const results: string[] = [];
    try {
      for await (const event of lifecycle.run({
        sessionId: "session_1",
        runId: "fairness",
        directory,
        modelId: "fake-model",
      })) {
        if (event.type === "tool:result") results.push(event.callId);
        if (event.type === "step:complete" && event.toolResults)
          expect(event.toolResults.map((r) => r.callId)).toEqual(
            Array.from({ length: count }, (_, i) => `call_${i}`),
          );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 15));
      const elapsed = performance.now() - started;
      console.log(
        "BATCH_FAIRNESS",
        JSON.stringify({
          kind,
          count,
          elapsed,
          maxGap,
          ticks,
          publications,
          bytes,
        }),
      );
      expect(invoked).toBe(count);
      expect(new Set(results).size).toBe(count);
      expect(results).toHaveLength(count);
      expect(requests).toHaveLength(2);
      expect(maxGap).toBeLessThan(1000);
    } finally {
      clearInterval(timer);
      source.reasoning.dispose();
      source.owner.dispose();
      closeDatabase();
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
