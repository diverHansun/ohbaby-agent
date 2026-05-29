import { mkdtemp, rm } from "node:fs/promises";
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
  type PreparedTurn,
  type SystemPromptProvider,
  type TokenCounter,
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
import type {
  Tool,
  ToolExecutionEnvironment,
} from "../../../packages/ohbaby-agent/src/core/tool-scheduler/index.js";
import { createPermissionState } from "../../../packages/ohbaby-agent/src/permission/index.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
  schema,
} from "../../../packages/ohbaby-agent/src/services/database/index.js";
import type {
  ProviderRequest,
  ProviderStreamEvent,
} from "../../../packages/ohbaby-agent/src/services/providers/index.js";

interface FakeSdkClient {
  readonly kind: "fake";
}

const SESSION_USAGE: ContextUsage = {
  contextLimit: 100_000,
  currentTokens: 120,
  modelId: "fake-model",
  remainingTokens: 99_880,
  shouldCompress: false,
  usageRatio: 0.0012,
};

function preparedTurn(messages: PreparedTurn["messages"]): PreparedTurn {
  return {
    assembledAt: 1_700_000_000_000,
    hasSummary: false,
    messages,
    usage: SESSION_USAGE,
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
      streamChatCompletion(
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
            tool_calls: [
              {
                id: "call_read",
                function: {
                  arguments: '{"path":"README.md"}',
                  name: "read_fake",
                },
                type: "function",
              },
            ],
          },
          {
            role: "tool",
            content:
              '{"params":{"path":"README.md"},"workdir":"D:/workspace/session_1","commandCwd":"D:/workspace/session_1"}',
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
        tool_calls: [
          {
            id: "call_read",
            function: {
              arguments: '{"path":"README.md"}',
              name: "read_fake",
            },
            type: "function",
          },
        ],
      },
      {
        role: "tool",
        content:
          '{"params":{"path":"README.md"},"workdir":"D:/workspace/session_1","commandCwd":"D:/workspace/session_1"}',
        tool_call_id: "call_read",
      },
    ]);
    expect(result).toMatchObject({
      finalResponse: "The fake file was read.",
      finishReason: "stop",
      success: true,
      toolCalls: [
        {
          arguments: { path: "README.md" },
          id: "call_read",
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
      });

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
            [{ textDelta: "All metadata was available.", finishReason: "stop" }],
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
        }),
      );

      expect(requests).toHaveLength(2);
      const secondMessages = requests[1]?.messages ?? [];
      const readResult = secondMessages.find(
        (message) =>
          message.role === "tool" && message.tool_call_id === "call_read",
      );
      const bashResult = secondMessages.find(
        (message) =>
          message.role === "tool" && message.tool_call_id === "call_bash",
      );
      const mcpResult = secondMessages.find(
        (message) =>
          message.role === "tool" && message.tool_call_id === "call_mcp",
      );
      expect(readResult?.content).toContain('"mtimeMs":1700000000000');
      expect(bashResult?.content).toContain('"exitCode":1');
      expect(mcpResult?.content).toContain(
        '"structuredContent":{"total":1}',
      );
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
});
