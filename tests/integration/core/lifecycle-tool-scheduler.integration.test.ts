import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createBus } from "../../../packages/ohbaby-agent/src/bus/index.js";
import {
  createContextManager,
  type ContextLLMClient,
  type ContextManager,
  type ContextUsage,
  type MemoryReader,
  type PreparedModelRequest,
  type PreparedTurn,
  type SystemPromptProvider,
  type TokenCounter,
} from "../../../packages/ohbaby-agent/src/core/context/index.js";
import { Lifecycle } from "../../../packages/ohbaby-agent/src/core/lifecycle/index.js";
import { serializeHistoryMessages } from "../../../packages/ohbaby-agent/src/core/context/serializer.js";
import { toModelTools } from "../../../packages/ohbaby-agent/src/core/agents/index.js";
import type { LLMClientInstance } from "../../../packages/ohbaby-agent/src/core/llm-client/index.js";
import {
  createDatabaseMessageStore,
  createInMemoryMessageStore,
  createMessageManager,
  readTokenUsageMetadata,
} from "../../../packages/ohbaby-agent/src/core/message/index.js";
import type {
  MessageIdGenerator,
  Part,
} from "../../../packages/ohbaby-agent/src/core/message/index.js";
import {
  createToolScheduler,
  ToolSchedulerEvent,
} from "../../../packages/ohbaby-agent/src/core/tool-scheduler/index.js";
import type {
  Tool,
  ToolExecutionEnvironment,
} from "../../../packages/ohbaby-agent/src/core/tool-scheduler/index.js";
import {
  createPermissionState,
  createPermissionManager,
  PermissionEvent,
  type PermissionInfo,
} from "../../../packages/ohbaby-agent/src/permission/index.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
  schema,
} from "../../../packages/ohbaby-agent/src/services/database/index.js";
import { ScopeToolSequence } from "../../../packages/ohbaby-agent/src/mcp/integration/tool-sequence.js";
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

function createTokenCounter(): TokenCounter {
  return {
    estimateTokens(content: string): number {
      return Math.ceil(content.length / 4);
    },
    getLimit(): number {
      return 100_000;
    },
  };
}

function createEmptyMemory(): MemoryReader {
  return {
    load: vi.fn().mockResolvedValue({ global: "", project: "", merged: "" }),
  };
}

function createEmptySystemPromptProvider(): SystemPromptProvider {
  return {
    build: vi.fn().mockResolvedValue(""),
  };
}

function createContextLLMClient(): ContextLLMClient {
  return {
    generateSummary: vi
      .fn()
      .mockResolvedValue("<state_snapshot>summary</state_snapshot>"),
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

function createEnvironment(workdir: string): ToolExecutionEnvironment {
  return {
    workdir,
    resolvePath(inputPath: string): string {
      return `${workdir}/${inputPath}`;
    },
    resolvePathForExisting(inputPath: string): Promise<string> {
      return Promise.resolve(`${workdir}/${inputPath}`);
    },
    resolvePathForWrite(inputPath: string): Promise<string> {
      return Promise.resolve(`${workdir}/${inputPath}`);
    },
    resolveCommandContext(): { readonly cwd: string; readonly kind: string } {
      return { cwd: workdir, kind: "host-local" };
    },
  };
}

async function consumeLifecycle(
  loop: ReturnType<Lifecycle["run"]>,
): Promise<Awaited<ReturnType<ReturnType<Lifecycle["run"]>["next"]>>["value"]> {
  let next = await loop.next();
  while (!next.done) {
    next = await loop.next();
  }
  return next.value;
}

describe("lifecycle tool scheduler integration", () => {
  it("executes a fake tool through the real scheduler and feeds results to the next LLM step", async () => {
    const requests: ProviderRequest[] = [];
    const bus = createBus();
    const scheduler = createToolScheduler({
      bus,
      permission: { ask: () => "once" },
      permissionState: createPermissionState({
        bus,
        initialLevel: "full-access",
      }),
    });
    const execute = vi.fn<Tool["execute"]>((params, context) => {
      return {
        output: JSON.stringify({
          params,
          workdir: context.environment?.workdir,
          commandCwd: context.environment?.resolveCommandContext().cwd,
        }),
      };
    });
    scheduler.register({
      category: "readonly",
      description: "Read a fake file",
      execute,
      name: "read_fake",
      parametersJsonSchema: {
        properties: { path: { type: "string" } },
        required: ["path"],
        type: "object",
      },
      source: "builtin",
    });
    const messageManager = createMessageManager({
      bus,
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
            role: "assistant",
            content: null,
            toolCalls: [
              {
                callId: "call_read",
                argumentsJson: '{"path":"README.md"}',
                name: "read_fake",
              },
            ],
          },
          {
            role: "tool",
            content:
              '{"params":{"path":"README.md"},"workdir":"D:/workspace/session_1","commandCwd":"D:/workspace/session_1"}',
            callId: "call_read",
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
                  name: "read_fake",
                },
              ],
              finishReason: "tool_calls",
            },
          ],
          [{ textDelta: "The fake file was read.", finishReason: "stop" }],
        ],
        requests,
      ),
      messageManager,
      toolScheduler: scheduler,
    });

    const result = await consumeLifecycle(
      lifecycle.run({
        directory: "D:/repo",
        environment: createEnvironment("D:/workspace/session_1"),
        modelId: "fake-model",
        sessionId: "session_1",
      }),
    );

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      { path: "README.md" },
      expect.objectContaining({
        callId: "call_read",
        environment: expect.objectContaining({
          workdir: "D:/workspace/session_1",
        }),
        messageId: "message_1",
        sessionId: "session_1",
      }),
    );
    expect(requests).toHaveLength(2);
    expect(requests[0]?.messages).toEqual([
      { role: "user", content: "Read README" },
    ]);
    expect(requests[1]?.messages).toEqual([
      { role: "user", content: "Read README" },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            callId: "call_read",
            argumentsJson: '{"path":"README.md"}',
            name: "read_fake",
          },
        ],
      },
      {
        role: "tool",
        content:
          '{"params":{"path":"README.md"},"workdir":"D:/workspace/session_1","commandCwd":"D:/workspace/session_1"}',
        callId: "call_read",
      },
    ]);
    expect(result).toMatchObject({
      finalResponse: "The fake file was read.",
      finishReason: "stop",
      success: true,
      toolCalls: [
        {
          arguments: { path: "README.md" },
          callId: "call_read",
          name: "read_fake",
        },
      ],
    });
  });

  it("persists tool metadata and rebuilds the next provider request through ContextManager", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ohbaby-lifecycle-db-"));
    const sessionId = "session_metadata";
    try {
      initDatabase({ dbPath: join(directory, "agent.db") });
      insertSession(sessionId);

      const requests: ProviderRequest[] = [];
      const measurements: PreparedModelRequest[] = [];
      const bus = createBus();
      const scheduler = createToolScheduler({
        bus,
        permission: { ask: () => "once" },
        permissionState: createPermissionState({
          bus,
          initialLevel: "full-access",
        }),
      });
      scheduler.register({
        category: "readonly",
        description: "Read file with metadata",
        execute: () => ({
          metadata: {
            internalSecret: "do-not-project",
            mtimeMs: 1_700_000_000_000,
            path: "D:/repo/README.md",
          },
          output: "README contents",
        }),
        name: "read",
        parametersJsonSchema: {
          properties: { path: { type: "string" } },
          required: ["path"],
          type: "object",
        },
        source: "builtin",
      });
      scheduler.register({
        category: "readonly",
        description: "Run bash with exit metadata",
        execute: () => ({
          metadata: {
            exitCode: 1,
            pid: 12345,
            signal: null,
          },
          output: "",
        }),
        name: "bash",
        parametersJsonSchema: {
          properties: { command: { type: "string" } },
          required: ["command"],
          type: "object",
        },
        source: "builtin",
      });
      scheduler.register({
        category: "network",
        description: "Fake MCP search",
        execute: () => ({
          metadata: {
            contentTypes: ["text"],
            internalSecret: "do-not-project",
            server: "server",
            source: "mcp",
            structuredContent: { total: 1 },
            tool: "search",
          },
          output: "search result",
        }),
        mcpServer: "server",
        mcpToolName: "search",
        name: "mcp_s6_server_t6_search",
        parametersJsonSchema: {
          properties: { query: { type: "string" } },
          required: ["query"],
          type: "object",
        },
        source: "mcp",
      });

      const messageManager = createMessageManager({
        bus,
        store: createDatabaseMessageStore(),
        idGenerator: createDeterministicIds(),
        now: () => 1_700_000_000_000,
      });
      const user = await messageManager.createMessage({
        agent: "default",
        sessionId,
        role: "user",
      });
      await messageManager.appendPart(user.id, {
        text: "Read README, run bash false, and search with MCP.",
        type: "text",
      });
      const contextManager = createContextManager({
        bus,
        llmClient: createContextLLMClient(),
        memory: createEmptyMemory(),
        messageManager,
        systemPromptProvider: createEmptySystemPromptProvider(),
        tokenCounter: createTokenCounter(),
        now: () => 1_700_000_000_000,
        onRequestMeasured: (request) => measurements.push(request),
      });

      const definitions = await scheduler.getAvailableTools();
      const tools = toModelTools(definitions);

      const lifecycle = new Lifecycle({
        contextManager,
        llmClient: createSequentialFakeLLMClient(
          [
            [
              {
                toolCallDeltas: [
                  {
                    argumentsDelta: '{"path":"README.md"}',
                    id: "call_read",
                    index: 0,
                    name: "read",
                  },
                  {
                    argumentsDelta: '{"command":"false"}',
                    id: "call_bash",
                    index: 1,
                    name: "bash",
                  },
                  {
                    argumentsDelta: '{"query":"ohbaby"}',
                    id: "call_mcp",
                    index: 2,
                    name: "mcp_s6_server_t6_search",
                  },
                ],
                finishReason: "tool_calls",
              },
            ],
            [
              {
                textDelta: "All metadata was available.",
                finishReason: "stop",
              },
            ],
          ],
          requests,
        ),
        messageManager,
        toolScheduler: scheduler,
      });

      const result = await consumeLifecycle(
        lifecycle.run({
          directory: "D:/repo",
          environment: createEnvironment("D:/workspace/session_metadata"),
          modelId: "fake-model",
          sessionId,
          tools,
        }),
      );

      expect(requests).toHaveLength(2);
      expect(requests[0]?.tools).toEqual(tools);
      expect(requests[1]?.tools).toEqual(tools);
      expect(
        requests[1]?.messages.slice(0, requests[0]?.messages.length),
      ).toEqual(requests[0]?.messages);
      expect(measurements.at(-1)).toEqual({
        messages: requests[1]?.messages,
        tools: requests[1]?.tools,
      });
      expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(
        definitions.map((tool) => tool.name),
      );
      const secondMessages = requests[1]?.messages ?? [];
      const readResult = secondMessages.find(
        (message) => message.role === "tool" && message.callId === "call_read",
      );
      const bashResult = secondMessages.find(
        (message) => message.role === "tool" && message.callId === "call_bash",
      );
      const mcpResult = secondMessages.find(
        (message) => message.role === "tool" && message.callId === "call_mcp",
      );
      expect(readResult?.content).toContain('"mtimeMs":1700000000000');
      expect(bashResult?.content).toContain('"exitCode":1');
      expect(mcpResult?.content).toContain('"structuredContent":{"total":1}');
      expect(readResult?.content).not.toContain("internalSecret");
      expect(bashResult?.content).not.toContain('"pid":12345');
      expect(mcpResult?.content).not.toContain("internalSecret");
      await expect(messageManager.listBySession(sessionId)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            info: expect.objectContaining({ role: "assistant" }),
            parts: expect.arrayContaining([
              expect.objectContaining({
                state: expect.objectContaining({
                  metadata: expect.objectContaining({
                    mtimeMs: 1_700_000_000_000,
                  }),
                  status: "completed",
                }),
                tool: "read",
                type: "tool",
              }),
              expect.objectContaining({
                state: expect.objectContaining({
                  metadata: expect.objectContaining({
                    exitCode: 1,
                    pid: 12345,
                  }),
                  status: "completed",
                }),
                tool: "bash",
                type: "tool",
              }),
              expect.objectContaining({
                state: expect.objectContaining({
                  metadata: expect.objectContaining({
                    source: "mcp",
                    structuredContent: { total: 1 },
                  }),
                  status: "completed",
                }),
                tool: "mcp_s6_server_t6_search",
                type: "tool",
              }),
            ]),
          }),
        ]),
      );
      expect(result).toMatchObject({
        finalResponse: "All metadata was available.",
        finishReason: "stop",
        success: true,
      });
    } finally {
      closeDatabase();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("resumes raw legacy SQLite history and persists new model steps in the existing schema across two reopens", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "ohbaby-lifecycle-migration-"),
    );
    const dbPath = join(directory, "agent.db");
    const sessionId = "session_migration";
    try {
      initDatabase({ dbPath });
      insertSession(sessionId);
      const legacyMessages = [
        {
          id: "legacy_user",
          role: "user",
          data: '{"id":"legacy_user","sessionId":"session_migration","role":"user","agent":"default","time":{"created":1000}}',
        },
        {
          id: "legacy_assistant",
          role: "assistant",
          data: '{"id":"legacy_assistant","sessionId":"session_migration","role":"assistant","agent":"default","finish":"tool_calls","time":{"created":2000,"completed":3000}}',
        },
      ] as const;
      const legacyParts = [
        {
          id: "legacy_text",
          messageId: "legacy_user",
          type: "text",
          order: 0,
          data: '{"id":"legacy_text","messageId":"legacy_user","sessionId":"session_migration","orderIndex":0,"type":"text","text":"Earlier request"}',
        },
        {
          id: "legacy_reasoning",
          messageId: "legacy_assistant",
          type: "reasoning",
          order: 0,
          data: '{"id":"legacy_reasoning","messageId":"legacy_assistant","sessionId":"session_migration","orderIndex":0,"type":"reasoning","text":"old reasoning must not replay"}',
        },
        {
          id: "legacy_tool",
          messageId: "legacy_assistant",
          type: "tool",
          order: 1,
          data: '{"id":"legacy_tool","messageId":"legacy_assistant","sessionId":"session_migration","orderIndex":1,"type":"tool","callId":"legacy_call","tool":"read","state":{"status":"completed","input":{"path":"README.md","offset":0},"output":"legacy contents","metadata":{"mtimeMs":123,"internalSecret":"keep-only-in-storage"}},"metadata":{"tokenUsage":{"promptTokens":10,"completionTokens":3,"totalTokens":999}}}',
        },
      ] as const;
      for (const [position, row] of legacyMessages.entries()) {
        getDatabase()
          .prepare(
            `INSERT INTO ${schema.message.tableName}
             (id, session_id, context_scope_id, role, agent, created_at, updated_at, data)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            row.id,
            sessionId,
            null,
            row.role,
            "default",
            (position + 1) * 1000,
            3000,
            row.data,
          );
      }
      for (const row of legacyParts) {
        getDatabase()
          .prepare(
            `INSERT INTO ${schema.part.tableName}
             (id, message_id, session_id, type, order_index, created_at, updated_at, data)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            row.id,
            row.messageId,
            sessionId,
            row.type,
            row.order,
            2000,
            3000,
            row.data,
          );
      }
      const readRows = (table: string): { id: string; data: string }[] =>
        getDatabase()
          .prepare<{
            id: string;
            data: string;
          }>(`SELECT id, data FROM ${table} WHERE session_id = ? ORDER BY id`)
          .all(sessionId);
      const expectLegacyBytes = (): void => {
        for (const [table, expected] of [
          [schema.message.tableName, legacyMessages],
          [schema.part.tableName, legacyParts],
        ] as const) {
          const actual = readRows(table);
          for (const row of expected) {
            expect(
              actual.find((candidate) => candidate.id === row.id)?.data,
            ).toBe(row.data);
          }
        }
      };

      closeDatabase();
      initDatabase({ dbPath });
      expectLegacyBytes();
      const store = createDatabaseMessageStore();
      const oldHistory = await store.listBySession(sessionId);
      const oldProjection = [
        { role: "user", content: "Earlier request" },
        {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              callId: "legacy_call",
              name: "read",
              argumentsJson: '{"path":"README.md","offset":0}',
            },
          ],
        },
        {
          role: "tool",
          callId: "legacy_call",
          content:
            'legacy contents\n\n<tool_metadata>\n{"mtimeMs":123}\n</tool_metadata>',
        },
      ];
      expect(serializeHistoryMessages(oldHistory)).toEqual(oldProjection);
      expect(readTokenUsageMetadata(oldHistory[1]?.parts[1]?.metadata)).toEqual(
        {
          inputTokens: 10,
          outputTokens: 3,
          totalTokens: 13,
        },
      );

      const bus = createBus();
      const messageManager = createMessageManager({
        bus,
        store,
        idGenerator: createDeterministicIds(),
        now: () => 1_700_000_000_000,
      });
      const user = await messageManager.createMessage({
        agent: "default",
        sessionId,
        role: "user",
      });
      await messageManager.appendPart(user.id, {
        type: "text",
        text: "Continue with two pairs of reads",
      });
      const execute = vi.fn<Tool["execute"]>(() => ({
        output: "new contents",
        metadata: { mtimeMs: 456, internalSecret: "new-storage-only" },
      }));
      const scheduler = createToolScheduler({
        bus,
        permission: { ask: () => "once" },
        permissionState: createPermissionState({
          bus,
          initialLevel: "full-access",
        }),
      });
      scheduler.register({
        category: "readonly",
        description: "Synthetic read",
        execute,
        name: "read",
        parametersJsonSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
        source: "builtin",
      });
      const contextManager = createContextManager({
        bus,
        llmClient: createContextLLMClient(),
        memory: createEmptyMemory(),
        messageManager,
        systemPromptProvider: createEmptySystemPromptProvider(),
        tokenCounter: createTokenCounter(),
        now: () => 1_700_000_000_000,
      });
      const toolUsage = {
        inputTokens: 50,
        outputTokens: 2,
        totalTokens: 52,
      } as const;
      const hybridUsage = {
        inputTokens: 100,
        outputTokens: 5,
        totalTokens: 105,
        inputBreakdown: {
          uncached: 20,
          cacheRead: 80,
          cacheWrite: 0,
          observed: { cacheRead: true, cacheWrite: false },
        },
      } as const;
      const finalUsage = {
        inputTokens: 120,
        outputTokens: 4,
        totalTokens: 124,
      } as const;
      const requests: ProviderRequest[] = [];
      const lifecycle = new Lifecycle({
        contextManager,
        messageManager,
        toolScheduler: scheduler,
        llmClient: createSequentialFakeLLMClient(
          [
            [
              {
                finishReason: "tool_calls",
                tokenUsage: toolUsage,
                toolCallDeltas: [
                  {
                    index: 0,
                    id: "call_first",
                    name: "read",
                    argumentsDelta: '{"path":"one"}',
                  },
                  {
                    index: 1,
                    id: "call_second",
                    name: "read",
                    argumentsDelta: '{"path":"two"}',
                  },
                ],
              },
            ],
            [
              {
                finishReason: "tool_calls",
                textDelta: "Read the next pair.",
                tokenUsage: hybridUsage,
                toolCallDeltas: [
                  {
                    index: 0,
                    id: "call_third",
                    name: "read",
                    argumentsDelta: '{"path":"three"}',
                  },
                  {
                    index: 1,
                    id: "call_fourth",
                    name: "read",
                    argumentsDelta: '{"path":"four"}',
                  },
                ],
              },
            ],
            [
              {
                finishReason: "stop",
                textDelta: "Migration roundtrip done.",
                tokenUsage: finalUsage,
              },
            ],
          ],
          requests,
        ),
      });
      const result = await consumeLifecycle(
        lifecycle.run({
          directory: "D:/repo",
          environment: createEnvironment("D:/workspace/session_migration"),
          modelId: "fake-model",
          sessionId,
          tools: toModelTools(await scheduler.getAvailableTools()),
        }),
      );
      expect(result).toMatchObject({
        success: true,
        finishReason: "stop",
        finalResponse: "Migration roundtrip done.",
      });
      expect(execute).toHaveBeenCalledTimes(4);
      expect(execute.mock.calls.map(([params]) => params)).toEqual([
        { path: "one" },
        { path: "two" },
        { path: "three" },
        { path: "four" },
      ]);
      expect(requests).toHaveLength(3);
      expect(requests[0]?.messages).toEqual(
        expect.arrayContaining(oldProjection),
      );
      expect(JSON.stringify(requests[0]?.messages)).not.toContain(
        "old reasoning must not replay",
      );
      expect(requests[1]?.messages).toEqual(
        expect.arrayContaining([
          {
            role: "assistant",
            content: null,
            toolCalls: [
              {
                callId: "call_first",
                name: "read",
                argumentsJson: '{"path":"one"}',
              },
              {
                callId: "call_second",
                name: "read",
                argumentsJson: '{"path":"two"}',
              },
            ],
          },
          {
            role: "tool",
            callId: "call_first",
            content:
              'new contents\n\n<tool_metadata>\n{"mtimeMs":456}\n</tool_metadata>',
          },
          {
            role: "tool",
            callId: "call_second",
            content:
              'new contents\n\n<tool_metadata>\n{"mtimeMs":456}\n</tool_metadata>',
          },
        ]),
      );
      expect(requests[2]?.messages).toEqual(
        expect.arrayContaining([
          {
            role: "assistant",
            content: "Read the next pair.",
            toolCalls: [
              {
                callId: "call_third",
                name: "read",
                argumentsJson: '{"path":"three"}',
              },
              {
                callId: "call_fourth",
                name: "read",
                argumentsJson: '{"path":"four"}',
              },
            ],
          },
        ]),
      );

      const assertStoredSteps = async (): Promise<void> => {
        const history =
          await createDatabaseMessageStore().listBySession(sessionId);
        expect(
          readTokenUsageMetadata(
            history
              .flatMap((message) => message.parts)
              .find((part) => part.id === "legacy_tool")?.metadata,
          ),
        ).toEqual({
          inputTokens: 10,
          outputTokens: 3,
          totalTokens: 13,
        });
        const replies = history.filter(
          (message) =>
            message.info.role === "assistant" &&
            !message.info.id.startsWith("legacy_"),
        );
        expect(replies).toHaveLength(3);
        const usageParts = replies.map((message) =>
          message.parts.filter(
            (part) => readTokenUsageMetadata(part.metadata) !== undefined,
          ),
        );
        expect(usageParts.map((parts) => parts.length)).toEqual([1, 1, 1]);
        expect(usageParts[0]?.[0]).toMatchObject({
          type: "tool",
          callId: "call_first",
        });
        expect(usageParts[1]?.[0]).toMatchObject({
          type: "text",
          text: "Read the next pair.",
        });
        expect(usageParts[2]?.[0]).toMatchObject({
          type: "text",
          text: "Migration roundtrip done.",
        });
        expect(
          usageParts.map((parts) => parts[0]?.metadata?.tokenUsage),
        ).toEqual([toolUsage, hybridUsage, finalUsage]);
        for (const parts of usageParts) {
          expect(parts[0]?.metadata?.tokenUsage).not.toHaveProperty(
            "promptTokens",
          );
          expect(parts[0]?.metadata?.tokenUsage).not.toHaveProperty(
            "completionTokens",
          );
          expect(parts[0]?.metadata?.tokenUsage).not.toHaveProperty(
            "prompt_tokens",
          );
        }
        expect(
          replies
            .flatMap((message) => message.parts)
            .filter((part) => part.type === "reasoning"),
        ).toHaveLength(0);
        const tools = replies
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "tool");
        expect(
          tools.map((part) => ({
            callId: part.callId,
            tool: part.tool,
            state: part.state,
          })),
        ).toEqual(
          ["one", "two", "three", "four"].map((path, index) => ({
            callId: ["call_first", "call_second", "call_third", "call_fourth"][
              index
            ],
            tool: "read",
            state: {
              status: "completed",
              input: { path },
              output: "new contents",
              metadata: {
                mtimeMs: 456,
                internalSecret: "new-storage-only",
                uiToolSource: "builtin",
              },
            },
          })),
        );
        const serialized = serializeHistoryMessages(history);
        expect(serialized).toEqual(
          expect.arrayContaining(oldProjection.slice(1)),
        );
        expect(serialized.at(-1)).toEqual({
          role: "assistant",
          content: "Migration roundtrip done.",
        });
      };
      await assertStoredSteps();
      expectLegacyBytes();
      const messagesBefore = readRows(schema.message.tableName);
      const partsBefore = readRows(schema.part.tableName);
      for (const row of messagesBefore) {
        const data = JSON.parse(row.data) as Record<string, unknown>;
        expect(
          Object.keys(data).filter(
            (key) =>
              ![
                "id",
                "sessionId",
                "contextScopeId",
                "role",
                "agent",
                "time",
                "model",
                "system",
                "tools",
                "parentId",
                "providerId",
                "modelId",
                "finish",
                "error",
                "kind",
              ].includes(key),
          ),
        ).toEqual([]);
      }
      for (const row of partsBefore) {
        const data = JSON.parse(row.data) as Part;
        expect(
          Object.keys(data).filter(
            (key) =>
              ![
                "id",
                "messageId",
                "sessionId",
                "contextScopeId",
                "orderIndex",
                "time",
                "type",
                "text",
                "synthetic",
                "ignored",
                "metadata",
                "callId",
                "tool",
                "state",
              ].includes(key),
          ),
        ).toEqual([]);
        if (data.type === "tool") {
          expect(
            Object.keys(data.state).filter(
              (key) => !["status", "input", "output", "metadata"].includes(key),
            ),
          ).toEqual([]);
        }
      }
      closeDatabase();
      initDatabase({ dbPath });
      expectLegacyBytes();
      expect(readRows(schema.message.tableName)).toEqual(messagesBefore);
      expect(readRows(schema.part.tableName)).toEqual(partsBefore);
      await assertStoredSteps();
    } finally {
      closeDatabase();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a prepared request immutable when a lazy tool loads before send and exposes it next step", async () => {
    const requests: ProviderRequest[] = [];
    const measurements: PreparedModelRequest[] = [];
    const epochs: number[] = [];
    const bus = createBus();
    const scheduler = createToolScheduler({
      bus,
      permission: { ask: () => "once" },
      permissionState: createPermissionState({
        bus,
        initialLevel: "full-access",
      }),
    });
    scheduler.register({
      category: "readonly",
      description: "Read a file",
      execute: () => ({ output: "contents" }),
      name: "read",
      parametersJsonSchema: {
        properties: { path: { type: "string" } },
        required: ["path"],
        type: "object",
      },
      source: "builtin",
    });
    scheduler.register({
      category: "readonly",
      description: "Lazy MCP search",
      execute: () => ({ output: "search" }),
      mcpServer: "server",
      mcpToolName: "search",
      name: "mcp_s6_server_t6_search",
      parametersJsonSchema: {
        properties: { query: { type: "string" } },
        type: "object",
      },
      source: "mcp",
    });
    const messageManager = createMessageManager({
      bus,
      store: createInMemoryMessageStore(),
      idGenerator: createDeterministicIds(),
      now: () => 1_700_000_000_000,
    });
    const user = await messageManager.createMessage({
      agent: "build",
      id: "initiating_user",
      role: "user",
      sessionId: "session_lazy",
    });
    await messageManager.appendPart(user.id, {
      text: "Read the fixture",
      type: "text",
    });
    const contextManager = createContextManager({
      bus,
      llmClient: createContextLLMClient(),
      memory: createEmptyMemory(),
      messageManager,
      onRequestMeasured: (request) => measurements.push(request),
      systemPromptProvider: createEmptySystemPromptProvider(),
      tokenCounter: createTokenCounter(),
    });
    const sequence = new ScopeToolSequence();
    let lazyLoaded = false;
    let firstPreparedRequest: PreparedModelRequest | undefined;
    let firstPreparedJson = "";
    const lifecycle = new Lifecycle({
      contextManager,
      llmClient: createSequentialFakeLLMClient(
        [
          [
            {
              finishReason: "tool_calls",
              toolCallDeltas: [
                {
                  argumentsDelta: '{"path":"README.md"}',
                  id: "call_read",
                  index: 0,
                  name: "read",
                },
              ],
            },
          ],
          [{ finishReason: "stop", textDelta: "done" }],
        ],
        requests,
      ),
      messageManager,
      resolveTools: async () => {
        const definitions = await scheduler.getAvailableTools();
        const visible = definitions.filter(
          (tool) => lazyLoaded || !tool.name.startsWith("mcp_"),
        );
        const snapshot = sequence.snapshot(
          { sessionId: "session_lazy" },
          visible,
        );
        epochs.push(snapshot.epoch);
        return {
          definitions: snapshot.tools,
          requestTools: toModelTools(snapshot.tools),
        };
      },
      toolScheduler: scheduler,
    });

    const loop = lifecycle.run({
      agent: "build",
      directory: "D:/repo",
      environment: createEnvironment("D:/repo"),
      initiatingUserMessageId: user.id,
      modelId: "fake-model",
      sessionId: "session_lazy",
    });
    let next = await loop.next();
    while (!next.done) {
      if (next.value.type === "context:prepared" && next.value.step === 1) {
        firstPreparedRequest = measurements.at(-1);
        expect(firstPreparedRequest).toBeDefined();
        firstPreparedJson = JSON.stringify(firstPreparedRequest);
        lazyLoaded = true;
      }
      next = await loop.next();
    }

    const firstNames = requests[0]?.tools?.map((tool) => tool.name) ?? [];
    const secondNames = requests[1]?.tools?.map((tool) => tool.name) ?? [];
    expect(firstNames).toEqual(["read"]);
    expect(secondNames).toEqual(["read", "mcp_s6_server_t6_search"]);
    expect(epochs).toEqual([0, 1]);
    expect(firstPreparedRequest).toEqual({
      messages: requests[0]?.messages,
      tools: requests[0]?.tools,
    });
    expect(measurements.at(-1)).toEqual({
      messages: requests[1]?.messages,
      tools: requests[1]?.tools,
    });
    expect(JSON.stringify(firstPreparedRequest)).toBe(firstPreparedJson);
    expect(Object.isFrozen(requests[0]?.tools?.[0])).toBe(true);
  });
});

it("delivers a fast result while a sibling still runs and preserves model result order", async () => {
  const bus = createBus();
  const scheduler = createToolScheduler({
    bus,
    permissionState: createPermissionState({
      bus,
      initialLevel: "full-access",
    }),
  });
  let release!: () => void;
  const slow = new Promise<void>((r) => {
    release = r;
  });
  const { withToolAdmission } =
    await import("../../../packages/ohbaby-agent/src/core/tool-scheduler/tool-admission.js");
  scheduler.register(
    withToolAdmission(
      {
        name: "independent",
        source: "builtin",
        category: "readonly",
        description: "test",
        parametersJsonSchema: { type: "object" },
        execute: async (params) => {
          if (params.slow) await slow;
          return { output: params.slow ? "A" : "B" };
        },
      },
      { plan: () => [] },
    ),
  );
  const messageManager = createMessageManager({
    bus,
    store: createInMemoryMessageStore(),
    idGenerator: createDeterministicIds(),
  });
  const requests: ProviderRequest[] = [];
  const lifecycle = new Lifecycle({
    messageManager,
    toolScheduler: scheduler,
    contextManager: createContextManagerMock(async () =>
      preparedTurn([{ role: "user", content: "work" }]),
    ),
    llmClient: createSequentialFakeLLMClient(
      [
        [
          {
            toolCallDeltas: [
              {
                id: "a",
                index: 0,
                name: "independent",
                argumentsDelta: '{"slow":true}',
              },
              { id: "b", index: 1, name: "independent", argumentsDelta: "{}" },
            ],
            finishReason: "tool_calls",
          },
        ],
        [{ textDelta: "done", finishReason: "stop" }],
      ],
      requests,
    ),
  });
  const loop = lifecycle.run({
    sessionId: "session_1",
    runId: "run_delivery",
    directory: "/tmp",
    modelId: "fake-model",
  });
  const seen: string[] = [];
  const consume = (async () => {
    for await (const event of loop) {
      if (event.type === "tool:result") {
        seen.push(event.callId);
        if (event.callId === "b") {
          expect(requests).toHaveLength(1);
          const messages = await messageManager.listBySession("session_1");
          const part = messages
            .flatMap((m) => m.parts)
            .find((p) => p.type === "tool" && p.callId === "b");
          expect(part).toMatchObject({
            state: { status: "completed", output: "B" },
            metadata: {
              execution: {
                phase: "ended",
                outcome: "success",
                runId: "run_delivery",
              },
            },
          });
          release();
        }
      }
      if (event.type === "step:complete" && event.toolResults)
        expect(event.toolResults.map((r) => r.callId)).toEqual(["a", "b"]);
    }
  })();
  try {
    await Promise.race([
      consume,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("fast result was withheld")), 500),
      ),
    ]);
  } finally {
    release();
    await consume;
  }
  expect(seen).toEqual(["b", "a"]);
  expect(requests).toHaveLength(2);
});

it.each(["preparing", "executing", "ended"])(
  "stops the lifecycle on %s persistence failure without a next model request",
  async (phase) => {
    const bus = createBus();
    const scheduler = createToolScheduler({
      bus,
      permissionState: createPermissionState({
        bus,
        initialLevel: "full-access",
      }),
    });
    let invocations = 0;
    scheduler.register({
      name: "work",
      description: "work",
      source: "builtin",
      category: "readonly",
      parametersJsonSchema: { type: "object" },
      execute: () => {
        invocations++;
        return { output: "ok" };
      },
    });
    const manager = createMessageManager({
      bus,
      store: createInMemoryMessageStore(),
      idGenerator: createDeterministicIds(),
    });
    const update = manager.updatePart.bind(manager);
    manager.updatePart = async (id, patch) => {
      if (patch.metadata?.execution?.phase === phase)
        throw new Error("injected disk failure");
      return update(id, patch);
    };
    const requests: ProviderRequest[] = [];
    const lifecycle = new Lifecycle({
      messageManager: manager,
      toolScheduler: scheduler,
      contextManager: createContextManagerMock(async () =>
        preparedTurn([{ role: "user", content: "go" }]),
      ),
      llmClient: createSequentialFakeLLMClient(
        [
          [
            {
              toolCallDeltas: [
                { id: "call", name: "work", index: 0, argumentsDelta: "{}" },
              ],
              finishReason: "tool_calls",
            },
          ],
          [{ textDelta: "must not run", finishReason: "stop" }],
        ],
        requests,
      ),
    });
    const events = [];
    const loop = lifecycle.run({
      sessionId: "session_1",
      runId: "failure",
      directory: "/tmp",
      modelId: "fake-model",
    });
    let next = await loop.next();
    while (!next.done) {
      events.push(next.value.type);
      next = await loop.next();
    }
    expect(next.value).toMatchObject({
      success: false,
      finishReason: "error",
      failureCause: { name: "ToolDeliveryError" },
    });
    expect(requests).toHaveLength(1);
    expect(events).not.toContain("tool:result");
    expect(invocations).toBe(phase === "preparing" ? 0 : 1);
  },
);

it("persists late cleanup after the lifecycle has finished without changing its timeout result", async () => {
  const bus = createBus();
  const scheduler = createToolScheduler({
    bus,
    permissionState: createPermissionState({
      bus,
      initialLevel: "full-access",
    }),
    config: { timeout: { defaultTimeout: 5 } },
    cleanupObservationMs: 100,
  });
  let resolve!: (result: { output: string }) => void;
  const pending = new Promise<{ output: string }>((r) => {
    resolve = r;
  });
  scheduler.register({
    name: "work",
    description: "work",
    source: "builtin",
    category: "readonly",
    parametersJsonSchema: { type: "object" },
    execute: () => pending,
  });
  const manager = createMessageManager({
    bus,
    store: createInMemoryMessageStore(),
    idGenerator: createDeterministicIds(),
  });
  const requests: ProviderRequest[] = [];
  const lifecycle = new Lifecycle({
    messageManager: manager,
    toolScheduler: scheduler,
    contextManager: createContextManagerMock(async () =>
      preparedTurn([{ role: "user", content: "go" }]),
    ),
    llmClient: createSequentialFakeLLMClient(
      [
        [
          {
            toolCallDeltas: [
              { id: "call", name: "work", index: 0, argumentsDelta: "{}" },
            ],
            finishReason: "tool_calls",
          },
        ],
        [{ textDelta: "done", finishReason: "stop" }],
      ],
      requests,
    ),
  });
  await consumeLifecycle(
    lifecycle.run({
      sessionId: "session_1",
      runId: "late-owner",
      directory: "/tmp",
      modelId: "fake-model",
    }),
  );
  const read = async () =>
    (await manager.listBySession("session_1"))
      .flatMap((m) => m.parts)
      .find((p) => p.type === "tool");
  const before = await read();
  expect(before).toMatchObject({
    metadata: {
      execution: {
        runId: "late-owner",
        phase: "ended",
        outcome: "timed-out",
        cleanup: "in-progress",
      },
    },
  });
  resolve({ output: "late success" });
  await vi.waitFor(async () => {
    expect(await read()).toMatchObject({
      metadata: {
        execution: {
          phase: "ended",
          outcome: "timed-out",
          cleanup: "confirmed",
        },
      },
    });
  });
  expect((await read())?.type === "tool" && (await read())).toMatchObject({
    state: (
      before as import("../../../packages/ohbaby-agent/src/core/message/index.js").ToolPart
    ).state,
  });
  expect(requests).toHaveLength(2);
});

it.each(["active", "finished"] as const)(
  "routes a late cleanup save failure to its %s original turn",
  async (originalState) => {
    const bus = createBus();
    const failedFacts: unknown[] = [];
    bus.subscribe(ToolSchedulerEvent.DeliveryFailed, (fact) => {
      failedFacts.push(fact);
    });
    const diagnostics: {
      error: unknown;
      fact: import("../../../packages/ohbaby-agent/src/core/tool-scheduler/types.js").ToolExecutionFact;
    }[] = [];
    const scheduler = createToolScheduler({
      bus,
      permissionState: createPermissionState({
        bus,
        initialLevel: "full-access",
      }),
      config: { timeout: { defaultTimeout: 5 } },
      cleanupObservationMs: 1000,
      onExecutionFactError: (error, fact) => {
        diagnostics.push({ error, fact });
      },
    });
    let finishOperation!: (value: { output: string }) => void;
    const operation = new Promise<{ output: string }>((resolve) => {
      finishOperation = resolve;
    });
    scheduler.register({
      name: "work",
      description: "work",
      source: "builtin",
      category: "readonly",
      parametersJsonSchema: { type: "object" },
      execute: () => operation,
    });
    const manager = createMessageManager({
      bus,
      store: createInMemoryMessageStore(),
      idGenerator: createDeterministicIds(),
    });
    const update = manager.updatePart.bind(manager);
    let lateSaveAttempted = false;
    manager.updatePart = async (id, patch) => {
      if (patch.metadata?.execution?.cleanup === "confirmed") {
        lateSaveAttempted = true;
        throw new Error("late cleanup save failed");
      }
      return update(id, patch);
    };
    const requests: ProviderRequest[] = [];
    const llm = createSequentialFakeLLMClient(
      [
        [
          {
            toolCallDeltas: [
              { id: "old-call", name: "work", index: 0, argumentsDelta: "{}" },
            ],
            finishReason: "tool_calls",
          },
        ],
        [{ textDelta: "done", finishReason: "stop" }],
        [{ textDelta: "healthy", finishReason: "stop" }],
      ],
      requests,
    );
    const stream = llm.provider.streamResponse.bind(llm.provider);
    let modelSignal: AbortSignal | undefined;
    let releaseModel!: () => void;
    let count = 0;
    llm.provider.streamResponse = async (request) => {
      count++;
      if (count === (originalState === "active" ? 2 : 3)) {
        modelSignal = request.signal;
        await new Promise<void>((resolve) => {
          releaseModel = resolve;
        });
      }
      return stream(request);
    };
    const lifecycle = new Lifecycle({
      messageManager: manager,
      toolScheduler: scheduler,
      contextManager: createContextManagerMock(async () =>
        preparedTurn([{ role: "user", content: "go" }]),
      ),
      llmClient: llm,
    });
    let releaseRequestEnd!: () => void;
    const requestEndGate = new Promise<void>((resolve) => {
      releaseRequestEnd = resolve;
    });
    const updateMessage = manager.updateMessage.bind(manager);
    manager.updateMessage = async (id, patch) => {
      if (
        originalState === "active" &&
        patch.modelRequests?.some((request) => request.outcome === "aborted")
      )
        await requestEndGate;
      return updateMessage(id, patch);
    };
    let originalResult: unknown;
    const original = consumeLifecycle(
      lifecycle.run({
        sessionId: "session_1",
        runId: "old-run",
        signal: new AbortController().signal,
        directory: "/tmp",
        modelId: "fake-model",
      }),
    ).then((result) => {
      originalResult = result;
      return result;
    });
    let healthy: ReturnType<typeof consumeLifecycle> | undefined;
    if (originalState === "finished") {
      await original;
      healthy = consumeLifecycle(
        lifecycle.run({
          sessionId: "session_1",
          runId: "new-run",
          signal: new AbortController().signal,
          directory: "/tmp",
          modelId: "fake-model",
        }),
      );
    }
    await vi.waitFor(() => {
      expect(modelSignal).toBeDefined();
    });
    finishOperation({ output: "late success" });
    try {
      await vi.waitFor(() => {
        expect(lateSaveAttempted).toBe(true);
        expect(diagnostics).toHaveLength(1);
        expect(failedFacts).toHaveLength(1);
      });
      expect(failedFacts[0]).toMatchObject({
        runId: "old-run",
        callId: "old-call",
        cleanup: "confirmed",
      });
      expect(diagnostics[0]).toMatchObject({
        error: { name: "ToolDeliveryError" },
        fact: {
          owner: { runId: "old-run", callId: "old-call" },
          phase: "cleanup",
          cleanup: "confirmed",
        },
      });
      if (originalState === "active") {
        await vi.waitFor(() => {
          expect(modelSignal?.aborted).toBe(true);
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(originalResult).toBeUndefined();
        releaseRequestEnd();
        expect(await original).toMatchObject({
          success: false,
          terminalReason: "tool_persistence_failure",
          failureCause: { name: "ToolDeliveryError" },
        });
        expect(count).toBe(2);
        const records = (await manager.listBySession("session_1")).flatMap(
          (message) =>
            message.info.role === "assistant"
              ? [...(message.info.modelRequests ?? [])]
              : [],
        );
        expect(records).toHaveLength(2);
        expect(records.every((request) => request.endedAt !== undefined)).toBe(
          true,
        );
        expect(records[1].outcome).toBe("aborted");
      } else {
        expect(modelSignal?.aborted).toBe(false);
        expect(originalResult).toMatchObject({ success: true });
        releaseModel();
        expect(await healthy).toMatchObject({ success: true });
      }
      const part = (await manager.listBySession("session_1"))
        .flatMap((m) => m.parts)
        .find((p) => p.type === "tool");
      expect(part).toMatchObject({
        metadata: {
          execution: {
            runId: "old-run",
            phase: "ended",
            outcome: "timed-out",
            cleanup: "in-progress",
          },
        },
      });
    } finally {
      releaseRequestEnd();
      releaseModel();
      await original;
      await healthy;
    }
  },
);

it.each(["once", "reject"] as const)(
  "persists and publishes independent B before answering A with %s, including SQLite refresh",
  async (answer) => {
    const directory = await mkdtemp(join(tmpdir(), "durable-independent-"));
    initDatabase({ dbPath: join(directory, "fixture.db") });
    insertSession("session_1");
    const bus = createBus();
    const state = createPermissionState({ bus });
    const permissions = createPermissionManager({ bus, state });
    const scheduler = createToolScheduler({
      bus,
      permissionState: state,
      permission: {
        ask: (input) =>
          permissions.ask({
            ...input,
            category: "write",
            source: {
              rootSessionId: input.sessionId,
              ancestorSessionIds: [input.sessionId],
            },
          }),
      },
    });
    const manager = createMessageManager({
      bus,
      store: createDatabaseMessageStore(),
      idGenerator: createDeterministicIds(),
    });
    const published: import("ohbaby-sdk").UiSessionRecoveryEvent[] = [];
    const makeSource = (messageManager = manager) =>
      new SourceSessionProjection({
        runtimeEpoch: "durable",
        messageManager,
        metadata: async (id) => ({
          id,
          title: "fixture",
          createdAt: "2026-09-26",
          updatedAt: "2026-09-26",
        }),
        runs: async () => [],
        prompts: async () => [],
        publish: (event) => {
          published.push(event);
        },
      });
    const source = makeSource();
    await source.owner.initialize("session_1");
    let refresh: SourceSessionProjection | undefined;
    let pending!: PermissionInfo;
    const off = bus.subscribe(PermissionEvent.Updated, ({ info }) => {
      pending = info;
    });
    const calls: string[] = [];
    const { withToolAdmission } =
      await import("../../../packages/ohbaby-agent/src/core/tool-scheduler/tool-admission.js");
    for (const [name, category] of [
      ["write", "write"],
      ["read", "readonly"],
    ] as const) {
      scheduler.register(
        withToolAdmission(
          {
            name,
            category,
            source: "builtin",
            description: "controlled independent tool",
            parametersJsonSchema: { type: "object" },
            execute: async () => {
              calls.push(name);
              return { output: name === "read" ? "B durable" : "A approved" };
            },
          },
          { plan: () => [] },
        ),
      );
    }
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
              toolCallDeltas: [
                {
                  id: "a",
                  index: 0,
                  name: "write",
                  argumentsDelta: '{"file_path":"a.txt","content":"A"}',
                },
                {
                  id: "b",
                  index: 1,
                  name: "read",
                  argumentsDelta: '{"file_path":"b.txt"}',
                },
              ],
              finishReason: "tool_calls",
            },
          ],
          [{ textDelta: "done", finishReason: "stop" }],
        ],
        requests,
      ),
    });
    const seen: string[] = [];
    try {
      for await (const event of lifecycle.run({
        sessionId: "session_1",
        runId: "durable",
        directory,
        modelId: "fake-model",
      })) {
        if (event.type === "tool:result") {
          seen.push(event.callId);
          if (event.callId === "b") {
            expect(calls).toEqual(["read"]);
            expect(requests).toHaveLength(1);
            expect(pending.callId).toBe("a");
            const records =
              await createDatabaseMessageStore().listBySession("session_1");
            expect(
              records
                .flatMap((m) => m.parts)
                .find((p) => p.type === "tool" && p.callId === "b"),
            ).toMatchObject({
              state: { status: "completed", output: "B durable" },
              metadata: { execution: { phase: "ended", outcome: "success" } },
            });
            expect(
              published.some(
                (e) =>
                  e.type === "session.changed" &&
                  e.messages?.some((m) =>
                    m.parts.some(
                      (p) =>
                        p.type === "tool-result" &&
                        p.result.callId === "b" &&
                        p.result.output === "B durable",
                    ),
                  ),
              ),
            ).toBe(true);
            refresh = makeSource(
              createMessageManager({
                bus: createBus(),
                store: createDatabaseMessageStore(),
              }),
            );
            await refresh.owner.initialize("session_1");
            expect(refresh.owner.read("session_1").session.messages).toEqual(
              source.owner.read("session_1").session.messages,
            );
            permissions.respond(pending.sessionId, pending.id, {
              type: answer,
            });
          }
        }
        if (event.type === "step:complete" && event.toolResults)
          expect(event.toolResults.map((r) => r.callId)).toEqual(["a", "b"]);
      }
      expect(seen).toEqual(["b", "a"]);
      expect(requests).toHaveLength(2);
      expect(calls).toEqual(answer === "once" ? ["read", "write"] : ["read"]);
    } finally {
      if (pending)
        permissions.respond(pending.sessionId, pending.id, { type: "reject" });
      off();
      source.reasoning.dispose();
      source.owner.dispose();
      refresh?.reasoning.dispose();
      refresh?.owner.dispose();
      closeDatabase();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.each([false, true])(
  "persists real Bash cleanup and keeps background=%s dispatch result stable after lifecycle end",
  async (background) => {
    const directory = await mkdtemp(join(tmpdir(), "bash-delivery-"));
    const { createBashTool } =
      await import("../../../packages/ohbaby-agent/src/tools/bash.js");
    const { ShellJobRegistry } =
      await import("../../../packages/ohbaby-agent/src/tools/shell-job-registry.js");
    const { Shell } =
      await import("../../../packages/ohbaby-agent/src/shell/index.js");
    const { createHostLocalEnvironment } =
      await import("../../../packages/ohbaby-agent/src/adapters/ui-runtime/host-local-environment.js");
    const registry = new ShellJobRegistry({
      killTree: Shell.killTree,
      terminationManagesObservation: true,
    });
    initDatabase({ dbPath: join(directory, "fixture.db") });
    insertSession("session_1");
    const bus = createBus();
    const scheduler = createToolScheduler({
      bus,
      permissionState: createPermissionState({
        bus,
        initialLevel: "full-access",
      }),
      resolveOwner: (request) => ({
        ...request,
        rootSessionId: request.sessionId,
        workspaceKey: directory,
      }),
    });
    scheduler.register(createBashTool({ registry }));
    const manager = createMessageManager({
      bus,
      store: createDatabaseMessageStore(),
      idGenerator: createDeterministicIds(),
    });
    const source = new SourceSessionProjection({
      runtimeEpoch: "bash",
      messageManager: manager,
      metadata: async (id) => ({
        id,
        title: "bash",
        createdAt: "2026-09-26",
        updatedAt: "2026-09-26",
      }),
      runs: async () => [],
      prompts: async () => [],
      publish: () => undefined,
    });
    await source.owner.initialize("session_1");
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
              toolCallDeltas: [
                {
                  id: "bash",
                  index: 0,
                  name: "bash",
                  argumentsDelta: JSON.stringify({
                    command:
                      "node -e 'process.stdout.write(\"OWNED_READY\\n\");setInterval(()=>{},100)'",
                    timeout: background ? 10000 : 150,
                    run_in_background: background,
                  }),
                },
              ],
              finishReason: "tool_calls",
            },
          ],
          [{ textDelta: "done", finishReason: "stop" }],
        ],
        requests,
      ),
    });
    const results: string[] = [];
    try {
      for await (const event of lifecycle.run({
        sessionId: "session_1",
        runId: "bash",
        directory,
        environment: createHostLocalEnvironment(directory),
        modelId: "fake-model",
      }))
        if (event.type === "tool:result") results.push(event.callId);
      const readTool = async () =>
        (await manager.listBySession("session_1"))
          .flatMap((m) => m.parts)
          .find((p) => p.type === "tool");
      const terminal = await readTool();
      if (
        !terminal ||
        terminal.type !== "tool" ||
        terminal.state.status !== "completed"
      )
        throw new Error("Bash did not produce persisted result");
      const jobId = String(terminal.state.metadata?.jobId);
      const dispatch = structuredClone(terminal.state);
      if (background) {
        expect(registry.get(jobId, "session_1").status).toBe("running");
        await registry.kill(jobId, "session_1");
        await registry.kill(jobId, "session_1");
      }
      await vi.waitFor(() =>
        expect(registry.get(jobId, "session_1").metadata.cleanup).toBe(
          "confirmed",
        ),
      );
      if (!background)
        expect(terminal.state.metadata?.status).toBe("timed_out");
      expect(terminal.metadata?.execution?.outcome).toBe(
        background ? "success" : "timed-out",
      );
      await vi.waitFor(async () => {
        const latest = await readTool();
        expect(latest?.metadata?.execution?.cleanup).toBe("confirmed");
      });
      expect((await readTool())?.state).toEqual(dispatch);
      expect(results).toEqual(["bash"]);
      expect(requests).toHaveLength(2);
      const refreshed = new SourceSessionProjection({
        runtimeEpoch: "refresh",
        messageManager: createMessageManager({
          bus: createBus(),
          store: createDatabaseMessageStore(),
        }),
        metadata: async (id) => ({
          id,
          title: "bash",
          createdAt: "2026-09-26",
          updatedAt: "2026-09-26",
        }),
        runs: async () => [],
        prompts: async () => [],
        publish: () => undefined,
      });
      try {
        await refreshed.owner.initialize("session_1");
        expect(refreshed.owner.read("session_1").session.messages).toEqual(
          source.owner.read("session_1").session.messages,
        );
      } finally {
        refreshed.reasoning.dispose();
        refreshed.owner.dispose();
      }
    } finally {
      await registry.dispose();
      source.reasoning.dispose();
      source.owner.dispose();
      closeDatabase();
      await rm(directory, { recursive: true, force: true });
    }
  },
  15000,
);

it("keeps two timed-out SQLite write owners protected and projects out-of-order late cleanup without replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "late-write-owners-"));
  initDatabase({ dbPath: join(directory, "fixture.db") });
  insertSession("session_1");
  const bus = createBus();
  const releases = new Map<string, () => void>();
  const unconfirmed = new Set<string>();
  let bothUnconfirmed!: () => void;
  const observed = new Promise<void>((r) => {
    bothUnconfirmed = r;
  });
  const scheduler = createToolScheduler({
    bus,
    permissionState: createPermissionState({
      bus,
      initialLevel: "full-access",
    }),
    config: { timeout: { defaultTimeout: 15 } },
    cleanupObservationMs: 30,
    onExecutionFact: (fact) => {
      if (fact.cleanup === "unconfirmed") {
        unconfirmed.add(fact.owner.callId);
        if (unconfirmed.size === 2) bothUnconfirmed();
      }
    },
  });
  const { withToolAdmission } =
    await import("../../../packages/ohbaby-agent/src/core/tool-scheduler/tool-admission.js");
  const invoked: string[] = [];
  scheduler.register(
    withToolAdmission(
      {
        name: "controlled_write",
        category: "write",
        source: "builtin",
        description: "owned file write",
        parametersJsonSchema: { type: "object" },
        execute: async (params, context) => {
          invoked.push(context.callId);
          if (params.hold)
            await new Promise<void>((resolve) =>
              releases.set(context.callId, resolve),
            );
          const { writeFile } = await import("node:fs/promises");
          await writeFile(join(directory, String(params.file)), context.callId);
          return { output: context.callId };
        },
      },
      {
        plan: (params) => [
          {
            kind: "file",
            path: join(directory, String(params.file)),
            scope: "file",
            mode: "write",
          },
        ],
        resolve: (params) => ({
          resources: [
            {
              kind: "file",
              path: join(directory, String(params.file)),
              scope: "file",
              mode: "write",
            },
          ],
        }),
      },
    ),
  );
  const manager = createMessageManager({
    bus,
    store: createDatabaseMessageStore(),
    idGenerator: createDeterministicIds(),
  });
  const source = new SourceSessionProjection({
    runtimeEpoch: "owners",
    messageManager: manager,
    metadata: async (id) => ({
      id,
      title: "owners",
      createdAt: "2026-09-26",
      updatedAt: "2026-09-26",
    }),
    runs: async () => [],
    prompts: async () => [],
    publish: () => undefined,
  });
  await source.owner.initialize("session_1");
  const call = (id: string, index: number, file: string, hold = false) => ({
    id,
    index,
    name: "controlled_write",
    argumentsDelta: JSON.stringify({ file, hold }),
  });
  const requests: ProviderRequest[] = [];
  const client = createSequentialFakeLLMClient(
    [
      [
        {
          toolCallDeltas: [
            call("a", 0, "a.txt", true),
            call("b", 1, "b.txt", true),
          ],
          finishReason: "tool_calls",
        },
      ],
      [
        {
          toolCallDeltas: [
            call("retry-a", 0, "a.txt"),
            call("retry-b", 1, "b.txt"),
            call("independent", 2, "c.txt"),
          ],
          finishReason: "tool_calls",
        },
      ],
      [
        {
          textDelta: "blocked writes explained; independent work done",
          finishReason: "stop",
        },
      ],
    ],
    requests,
  );
  const stream = client.provider.streamResponse.bind(client.provider);
  client.provider.streamResponse = async (request) => {
    if (requests.length === 1) await observed;
    return stream(request);
  };
  const lifecycle = new Lifecycle({
    messageManager: manager,
    toolScheduler: scheduler,
    contextManager: createContextManagerMock(async () =>
      preparedTurn([{ role: "user", content: "write" }]),
    ),
    llmClient: client,
  });
  const results: string[] = [];
  const parts = async () =>
    (await manager.listBySession("session_1"))
      .flatMap((m) => m.parts)
      .filter((p) => p.type === "tool");
  try {
    for await (const event of lifecycle.run({
      sessionId: "session_1",
      runId: "owners",
      directory,
      modelId: "fake-model",
    }))
      if (event.type === "tool:result") results.push(event.callId);
    expect(invoked.sort()).toEqual(["a", "b", "independent"]);
    const before = await parts();
    for (const id of ["retry-a", "retry-b"]) {
      const failed = before.find((p) => p.callId === id);
      expect(failed?.state.status).toBe("error");
      expect(JSON.stringify(failed?.state)).toMatch(
        /not executed|did not execute/,
      );
      expect(JSON.stringify(failed?.state)).toContain("unconfirmed");
      expect(failed?.metadata?.execution?.executionStartedAt).toBeUndefined();
    }
    releases.get("b")!();
    await vi.waitFor(async () =>
      expect(
        (await parts()).find((p) => p.callId === "b")?.metadata?.execution
          ?.cleanup,
      ).toBe("confirmed"),
    );
    expect(
      (await parts()).find((p) => p.callId === "a")?.metadata?.execution
        ?.cleanup,
    ).toBe("unconfirmed");
    releases.get("a")!();
    await vi.waitFor(async () =>
      expect(
        (await parts()).find((p) => p.callId === "a")?.metadata?.execution
          ?.cleanup,
      ).toBe("confirmed"),
    );
    const after = await parts();
    for (const id of ["a", "b"]) {
      expect(after.find((p) => p.callId === id)?.state).toEqual(
        before.find((p) => p.callId === id)?.state,
      );
      expect(
        after.find((p) => p.callId === id)?.metadata?.execution,
      ).toMatchObject({ phase: "ended", outcome: "timed-out" });
    }
    expect(results).toHaveLength(5);
    expect(new Set(results).size).toBe(5);
    expect(requests).toHaveLength(3);
    const refresh = new SourceSessionProjection({
      runtimeEpoch: "refresh",
      messageManager: createMessageManager({
        bus: createBus(),
        store: createDatabaseMessageStore(),
      }),
      metadata: async (id) => ({
        id,
        title: "owners",
        createdAt: "2026-09-26",
        updatedAt: "2026-09-26",
      }),
      runs: async () => [],
      prompts: async () => [],
      publish: () => undefined,
    });
    try {
      await refresh.owner.initialize("session_1");
      expect(refresh.owner.read("session_1").session.messages).toEqual(
        source.owner.read("session_1").session.messages,
      );
    } finally {
      refresh.reasoning.dispose();
      refresh.owner.dispose();
    }
  } finally {
    for (const release of releases.values()) release();
    await vi.waitFor(async () => {
      const saved = await parts();
      expect(
        saved
          .filter((p) => ["a", "b"].includes(p.callId))
          .every((p) => p.metadata?.execution?.cleanup === "confirmed"),
      ).toBe(true);
    });
    source.reasoning.dispose();
    source.owner.dispose();
    closeDatabase();
    await rm(directory, { recursive: true, force: true });
  }
});

it("allows real foreground Bash gates in separate child batches sharing one root and workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "child-bash-overlap-"));
  const { createBashTool } =
    await import("../../../packages/ohbaby-agent/src/tools/bash.js");
  const { ShellJobRegistry } =
    await import("../../../packages/ohbaby-agent/src/tools/shell-job-registry.js");
  const { Shell } =
    await import("../../../packages/ohbaby-agent/src/shell/index.js");
  const { createHostLocalEnvironment } =
    await import("../../../packages/ohbaby-agent/src/adapters/ui-runtime/host-local-environment.js");
  const registry = new ShellJobRegistry({
    killTree: Shell.killTree,
    terminationManagesObservation: true,
  });
  const script = join(directory, "gate.cjs");
  await writeFile(
    script,
    `const fs=require('node:fs');const path=require('node:path');const side=process.argv[2];fs.writeFileSync(path.join(__dirname,side+'.start'),String(Date.now()));const timer=setInterval(()=>{if(fs.existsSync(path.join(__dirname,'release'))){clearInterval(timer);fs.writeFileSync(path.join(__dirname,side+'.end'),String(Date.now()));console.log(side+' done')}},10);`,
  );
  const bus = createBus();
  const scheduler = createToolScheduler({
    bus,
    permissionState: createPermissionState({
      bus,
      initialLevel: "full-access",
    }),
    resolveOwner: (request) => ({
      ...request,
      rootSessionId: "shared-parent",
      workspaceKey: directory,
    }),
  });
  scheduler.register(createBashTool({ registry }));
  const operations = ["left", "right"].map((side) =>
    scheduler.executeBatch({
      calls: [
        {
          callId: side,
          sessionId: side,
          messageId: side,
          runId: side,
          contextScopeId: side,
          environment: createHostLocalEnvironment(directory),
          toolName: "bash",
          params: { command: `node '${script}' ${side}`, timeout: 5000 },
        },
      ],
      observer: {
        onCallState: () => Promise.resolve(),
        onCallSettled: () => Promise.resolve(),
      },
    }),
  );
  try {
    await vi.waitFor(
      async () => {
        for (const side of ["left", "right"])
          expect(
            Number(await readFile(join(directory, side + ".start"), "utf8")),
          ).toBeGreaterThan(0);
      },
      { timeout: 3000 },
    );
    await writeFile(join(directory, "release"), "go");
    const results = await Promise.all(operations);
    expect(results.flat().map((result) => result.execution?.outcome)).toEqual([
      "success",
      "success",
    ]);
    const intervals = await Promise.all(
      ["left", "right"].map(async (side) => ({
        start: Number(await readFile(join(directory, side + ".start"), "utf8")),
        end: Number(await readFile(join(directory, side + ".end"), "utf8")),
      })),
    );
    expect(Math.max(...intervals.map((i) => i.start))).toBeLessThan(
      Math.min(...intervals.map((i) => i.end)),
    );
  } finally {
    await writeFile(join(directory, "release"), "cleanup");
    await Promise.allSettled(operations);
    await registry.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
