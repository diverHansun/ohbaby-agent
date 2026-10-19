import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messageToUiMessage } from "../../adapters/ui-state/persistent-store.js";
import { createBus } from "../../bus/index.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
  schema,
} from "../../services/database/index.js";
import {
  createDatabaseMessageStore,
  createMessageManager,
  escapeReminderValue,
  isModelContextPart,
  type MessageIdGenerator,
} from "../message/index.js";
import { createFallbackSessionTitleFromMessages } from "../../services/session/title-fallback.js";
import { createContextManager } from "./context-manager.js";
import { serializeHistory } from "./serialization.js";
import { serializeForLlm, serializeHistoryMessages } from "./serializer.js";
import { Lifecycle } from "../lifecycle/lifecycle.js";
import { createToolScheduler } from "../tool-scheduler/index.js";
import { createPermissionState } from "../../permission/index.js";
import { adaptMcpTool } from "../../mcp/integration/tool-adapter.js";
import { admitMcpTool } from "../../mcp/integration/dynamic-tool-menu.js";
import type { McpClientLike } from "../../mcp/types.js";
import type { LLMClientInstance } from "../llm-client/index.js";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
} from "../../services/interface-providers/types.js";
import { estimateHistoryForCompaction } from "./compaction-policy.js";

const cleanupPaths: string[] = [];
let databasePath = "";

function createMessageIds(prefix = ""): MessageIdGenerator {
  let nextMessageId = 1;
  let nextPartId = 1;

  return {
    messageId(): string {
      const id = `${prefix}message_${String(nextMessageId)}`;
      nextMessageId += 1;
      return id;
    },
    partId(): string {
      const id = `${prefix}part_${String(nextPartId)}`;
      nextPartId += 1;
      return id;
    },
  };
}

function createClock(): () => number {
  let now = 1_000;

  return () => {
    const current = now;
    now += 1_000;
    return current;
  };
}

function insertSession(): void {
  getDatabase()
    .prepare(
      `INSERT INTO ${schema.session.tableName}
        (id, project_id, project_root, agent, title, status, created_at, updated_at, message_count, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "session_1",
      "project_1",
      "D:/repo",
      "default",
      "Session",
      "active",
      1_000,
      1_000,
      0,
      "{}",
    );
}

beforeEach(async () => {
  const directory = await mkdtemp(join(tmpdir(), "ohbaby-context-db-"));
  cleanupPaths.push(directory);
  databasePath = join(directory, "agent.db");
  initDatabase({ dbPath: databasePath });
  insertSession();
});

afterEach(async () => {
  closeDatabase();
  await Promise.all(
    cleanupPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("serializeForLlm database metadata projection", () => {
  it("replays real MCP error and large successful results through lifecycle, restart and budget changes", async () => {
    const bus = createBus();
    const messageManager = createMessageManager({
      bus,
      store: createDatabaseMessageStore(),
      idGenerator: createMessageIds(),
      now: createClock(),
    });
    const user = await messageManager.createMessage({
      sessionId: "session_1",
      role: "user",
      agent: "default",
    });
    await messageManager.appendPart(user.id, {
      type: "text",
      text: "Look up all three records",
    });
    const largeOutput = "stable-large-result-".repeat(3000);
    const structuredContent = {
      reason: "missing-record",
      suggestion: "correct the record id",
    };
    const mcp: McpClientLike = {
      name: "records",
      config: {
        type: "stdio",
        command: "fixture",
        args: [],
        enabled: true,
        trust: true,
        timeout: 5000,
      },
      connect: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
      listTools: () => Promise.resolve([]),
      getStatus: () => ({ status: "connected", toolCount: 1 }),
      callTool: ({ arguments: params }) =>
        Promise.resolve(
          params?.key === "missing"
            ? {
                isError: true,
                content: [{ type: "text", text: "Record not found" }],
                structuredContent,
              }
            : { content: [{ type: "text", text: largeOutput }] },
        ),
    };
    const tool = adaptMcpTool(
      {
        name: "lookup",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string" } },
        },
        annotations: { readOnlyHint: true },
      },
      mcp,
    );
    const scheduler = createToolScheduler({
      bus,
      permissionState: createPermissionState({
        bus,
        initialLevel: "full-access",
      }),
    });
    scheduler.register(admitMcpTool(tool).accepted[0]);
    let limit = 1_000_000;
    const tokenCounter = {
      estimateTokens: (text: string): number => text.length,
      getLimit: (): number => limit,
    };
    const contextManager = createContextManager({
      bus,
      messageManager,
      tokenCounter,
      llmClient: {
        generateSummary: () =>
          Promise.reject(new Error("Unexpected compaction")),
      },
      systemPromptProvider: { build: () => Promise.resolve("system") },
    });
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
            contextWindowTokens: limit,
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
          const first = requests.length === 1;
          return Promise.resolve(
            (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
              yield await Promise.resolve(
                first
                  ? {
                      toolCallDeltas: ["missing", "one", "two"].map(
                        (key, index) => ({
                          index,
                          id: `call_${key}`,
                          name: tool.name,
                          argumentsDelta: JSON.stringify({ key }),
                        }),
                      ),
                      finishReason: "tool_calls",
                    }
                  : { textDelta: "Done", finishReason: "stop" },
              );
            })(),
          );
        },
      },
    };
    const lifecycle = new Lifecycle({
      llmClient,
      messageManager,
      contextManager,
      toolScheduler: scheduler,
    });
    const run = lifecycle.run({
      sessionId: "session_1",
      modelId: "fixture",
      directory: process.cwd(),
    });
    let next = await run.next();
    while (!next.done) next = await run.next();
    expect(next.value.success).toBe(true);
    expect(requests).toHaveLength(2);
    const sentResults = requests[1].messages.filter(
      (message) => message.role === "tool",
    );
    expect(sentResults.map((message) => message.callId)).toEqual([
      "call_missing",
      "call_one",
      "call_two",
    ]);
    const errorContent = sentResults[0].content;
    if (typeof errorContent !== "string") throw new Error("Expected tool text");
    expect(errorContent.match(/Record not found/g)).toHaveLength(1);
    expect(errorContent.match(/missing-record/g)).toHaveLength(1);
    expect(errorContent).toContain('"isError":true');
    expect(errorContent).not.toContain('"source"');
    expect(errorContent).not.toContain("uiToolSource");
    expect(errorContent).not.toContain('"metadata":');
    for (const result of sentResults.slice(1))
      expect(result.content).toContain(largeOutput);

    const history = await messageManager.listBySession("session_1");
    const parts = history
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool");
    expect(parts.map((part) => part.state.status)).toEqual([
      "error",
      "completed",
      "completed",
    ]);
    expect(parts[0].state).toMatchObject({
      metadata: {
        isError: true,
        source: "mcp",
        contentTypes: ["text"],
        structuredContent,
      },
    });
    const before = serializeHistoryMessages(history);
    const summary = serializeHistory(history, { includeToolContext: true });
    for (const result of sentResults) {
      if (typeof result.content !== "string")
        throw new Error("Expected tool text");
      expect(summary).toContain(result.content);
    }
    const expectedCount = before
      .map((message) => JSON.stringify(message))
      .join("\n").length;
    expect(estimateHistoryForCompaction(history, tokenCounter)).toBe(
      expectedCount,
    );

    // Changed budgets below summary pressure must not redistribute or trim old results.
    limit = 200_000;
    const prepared = await contextManager.prepareTurn({
      sessionId: "session_1",
      directory: process.cwd(),
      modelId: "fixture",
      toolNames: [],
      tools: undefined,
    });
    expect(prepared.usage.usageRatio).toBeGreaterThan(0.5);
    expect(prepared.compaction).toBeUndefined();
    expect(
      prepared.request.messages.filter((message) => message.role === "tool"),
    ).toEqual(sentResults);
    expect(await messageManager.listBySession("session_1")).toEqual(history);

    closeDatabase();
    initDatabase({ dbPath: databasePath });
    const reopened = createMessageManager({
      bus: createBus(),
      store: createDatabaseMessageStore(),
    });
    const restored = await reopened.listBySession("session_1");
    expect(restored).toEqual(history);
    expect(serializeHistoryMessages(restored)).toEqual(before);
    expect(serializeHistory(restored, { includeToolContext: true })).toBe(
      summary,
    );
    expect(estimateHistoryForCompaction(restored, tokenCounter)).toBe(
      expectedCount,
    );
  });

  it.each([
    {
      name: "MessageContentFilterError",
      notice: "[Response incomplete: content was filtered.]",
    },
    {
      name: "MessageStreamInterruptedError",
      notice: "[Response interrupted: the saved text below may be incomplete.]",
    },
  ] as const)(
    "reopens the new $name variant without upgrading legacy error wording",
    async ({ name, notice }) => {
      const manager = createMessageManager({
        bus: createBus(),
        store: createDatabaseMessageStore(),
      });
      const failed = await manager.createMessage({
        sessionId: "session_1",
        role: "assistant",
        agent: "default",
        contextScopeId: "child",
      });
      const body = await manager.appendPart(failed.id, {
        type: "text",
        text: "saved new-variant body",
      });
      await manager.updateMessage(failed.id, {
        finish: "error",
        error: { name },
      });
      const legacy = await manager.createMessage({
        sessionId: "session_1",
        role: "assistant",
        agent: "default",
        contextScopeId: "child",
      });
      await manager.appendPart(legacy.id, {
        type: "text",
        text: "legacy body must stay excluded",
      });
      await manager.updateMessage(legacy.id, {
        finish: "error",
        error: {
          name: "Unknown",
          message: "content filtered or stream interrupted",
        },
      });
      const before = await manager.listBySession("session_1", {
        contextScopeId: "child",
      });
      closeDatabase();
      initDatabase({ dbPath: databasePath });
      const reopened = createMessageManager({
        bus: createBus(),
        store: createDatabaseMessageStore(),
      });
      const history = await reopened.listBySession("session_1", {
        contextScopeId: "child",
      });
      expect(history).toEqual(before);
      expect(history[0].info).toMatchObject({
        error: { name },
        contextScopeId: "child",
      });
      expect(serializeHistoryMessages(history)).toEqual([
        { role: "assistant", content: `${notice}\nsaved new-variant body` },
      ]);
      expect(
        serializeHistory(history, {
          includeModelContext: false,
          includeToolContext: true,
        }),
      ).toBe(`assistant: ${notice}\nsaved new-variant body`);
      await reopened.updatePart(body.id, { time: { compacted: 50_000 } });
      closeDatabase();
      initDatabase({ dbPath: databasePath });
      expect(
        serializeHistoryMessages(
          await createMessageManager({
            bus: createBus(),
            store: createDatabaseMessageStore(),
          }).listBySession("session_1", { contextScopeId: "child" }),
        ),
      ).toEqual([]);
    },
  );

  it("retains failed-history policy and accepted tool pairing across SQLite reopen and retirement", async () => {
    const manager = createMessageManager({
      bus: createBus(),
      store: createDatabaseMessageStore(),
      idGenerator: createMessageIds(),
      now: createClock(),
    });
    const limited = await manager.createMessage({
      sessionId: "session_1",
      role: "assistant",
      agent: "default",
    });
    const body = await manager.appendPart(limited.id, {
      type: "text",
      text: "saved partial answer",
    });
    await manager.updateMessage(limited.id, {
      finish: "error",
      error: { name: "MessageOutputLengthError" },
    });
    const cancelled = await manager.createMessage({
      sessionId: "session_1",
      role: "assistant",
      agent: "default",
    });
    await manager.appendPart(cancelled.id, {
      type: "text",
      text: "cancelled private answer",
    });
    const notice = await manager.appendPart(cancelled.id, {
      type: "text",
      text: "[Response cancelled by the user.]",
      synthetic: true,
      metadata: { kind: "lifecycle-interruption" },
    });
    await manager.updateMessage(cancelled.id, {
      finish: "error",
      error: { name: "MessageAbortedError", message: "cancelled" },
    });
    const accepted = await manager.createMessage({
      sessionId: "session_1",
      role: "assistant",
      agent: "default",
    });
    await manager.appendPart(accepted.id, {
      type: "tool",
      tool: "read",
      callId: "call_saved",
      state: {
        status: "error",
        input: { path: "missing.txt" },
        error: "file missing",
      },
    });
    await manager.updateMessage(accepted.id, { finish: "tool_calls" });

    closeDatabase();
    initDatabase({ dbPath: databasePath });
    const reopened = createMessageManager({
      bus: createBus(),
      store: createDatabaseMessageStore(),
    });
    const history = await reopened.listBySession("session_1");
    expect(serializeHistoryMessages(history)).toEqual([
      {
        role: "assistant",
        content:
          "[Response incomplete: output limit reached.]\nsaved partial answer",
      },
      { role: "assistant", content: "[Response cancelled by the user.]" },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            callId: "call_saved",
            name: "read",
            argumentsJson: '{"path":"missing.txt"}',
          },
        ],
      },
      { role: "tool", callId: "call_saved", content: "file missing" },
    ]);
    const summary = serializeHistory(history, {
      includeModelContext: false,
      includeToolContext: true,
    });
    expect(summary).toContain("saved partial answer");
    expect(summary).toContain("[Response cancelled by the user.]");
    expect(summary).not.toContain("cancelled private answer");
    expect(summary).toContain('"status":"error"');
    expect(summary).toContain("file missing");

    await reopened.updatePart(body.id, { time: { compacted: 50_000 } });
    await reopened.updatePart(notice.id, { time: { compacted: 50_000 } });
    closeDatabase();
    initDatabase({ dbPath: databasePath });
    const afterRetirement = await createMessageManager({
      bus: createBus(),
      store: createDatabaseMessageStore(),
    }).listBySession("session_1");
    expect(serializeHistoryMessages(afterRetirement)).toEqual([
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            callId: "call_saved",
            name: "read",
            argumentsJson: '{"path":"missing.txt"}',
          },
        ],
      },
      { role: "tool", callId: "call_saved", content: "file missing" },
    ]);
    expect(
      serializeHistory(afterRetirement, {
        includeModelContext: false,
        includeToolContext: true,
      }),
    ).toBe(
      'assistant: {"tool":"read","callId":"call_saved","input":{"path":"missing.txt"},"status":"error"}\nfile missing',
    );
  });

  it("keeps persisted runtime context model-visible after a database round trip", async () => {
    const messageManager = createMessageManager({
      bus: createBus(),
      store: createDatabaseMessageStore(),
      idGenerator: createMessageIds(),
      now: createClock(),
    });
    const user = await messageManager.createMessage({
      agent: "build",
      role: "user",
      sessionId: "session_1",
    });
    await messageManager.appendPart(user.id, {
      text: "inspect caching",
      type: "text",
    });
    await messageManager.appendPart(user.id, {
      metadata: { kind: "model-context:runtime:v1" },
      synthetic: true,
      text: "\n\n<environment_context>/repo</environment_context>",
      type: "text",
    });

    const historyBeforeCrash = await messageManager.listBySession("session_1");
    closeDatabase();
    initDatabase({ dbPath: databasePath });
    const reopenedMessageManager = createMessageManager({
      bus: createBus(),
      store: createDatabaseMessageStore(),
      idGenerator: createMessageIds(),
      now: createClock(),
    });
    const history = await reopenedMessageManager.listBySession("session_1");
    const restoredUser = history[0];
    expect(history).toEqual(historyBeforeCrash);
    expect(history[0]?.parts.filter(isModelContextPart)).toHaveLength(1);
    expect(serializeHistory(history)).toContain(
      "<environment_context>/repo</environment_context>",
    );
    expect(
      serializeHistory(history, { includeModelContext: false }),
    ).not.toContain("<environment_context>/repo</environment_context>");
    expect(
      JSON.stringify(
        serializeForLlm({
          history,
          systemPrompt: "stable",
        }),
      ),
    ).toContain("<environment_context>/repo</environment_context>");
    expect(messageToUiMessage(restoredUser)).toMatchObject({
      parts: [{ text: "inspect caching", type: "text" }],
    });
    expect(createFallbackSessionTitleFromMessages(history)).toBe(
      "inspect caching",
    );

    const contextManager = createContextManager({
      bus: createBus(),
      llmClient: {
        generateSummary: vi.fn().mockResolvedValue({
          text: "summary",
          summaryMessageId: "summary",
          requests: [],
        }),
      },
      messageManager: reopenedMessageManager,
      systemPromptProvider: {
        build: vi.fn().mockResolvedValue("stable"),
      },
      tokenCounter: {
        estimateTokens: (content) => content.length,
        getLimit: () => 100_000,
      },
    });
    const resumedSnapshot = await contextManager.createRunPromptSnapshot({
      directory: "/changed",
      isSubagent: false,
      sessionId: "session_1",
      toolNames: [],
    });
    const resumed = await contextManager.prepareTurn({
      directory: "/changed",
      modelId: "fake-model",
      promptSnapshot: resumedSnapshot,
      sessionId: "session_1",
      toolNames: [],
      tools: undefined,
    });

    expect(
      JSON.stringify(resumed.request).split(
        "<environment_context>/repo</environment_context>",
      ),
    ).toHaveLength(2);
    expect(
      (
        await reopenedMessageManager.listBySession("session_1")
      )[0]?.parts.filter(isModelContextPart),
    ).toHaveLength(1);
  });

  it("projects bash and MCP metadata after a database round trip", async () => {
    const messageManager = createMessageManager({
      bus: createBus(),
      store: createDatabaseMessageStore(),
      idGenerator: createMessageIds(),
      now: createClock(),
    });
    const assistant = await messageManager.createMessage({
      sessionId: "session_1",
      role: "assistant",
      agent: "default",
    });
    await messageManager.appendPart(assistant.id, {
      type: "tool",
      callId: "call_bash",
      tool: "bash",
      state: {
        status: "error",
        input: { command: "false" },
        error: "",
        metadata: {
          exitCode: 1,
          pid: 42,
          resolvedPaths: ["D:/repo/secret.txt"],
          signal: null,
        },
      },
    });
    await messageManager.appendPart(assistant.id, {
      type: "tool",
      callId: "call_mcp",
      tool: "mcp_s6_server_t6_search",
      state: {
        status: "completed",
        input: { query: "ohbaby" },
        output: "structured result",
        metadata: {
          contentTypes: ["text"],
          server: "server",
          source: "mcp",
          structuredContent: { count: 1 },
          tool: "search",
        },
      },
    });

    const messages = serializeForLlm({
      history: await messageManager.listBySession("session_1"),
      systemPrompt: "",
    });

    expect(messages).toEqual([
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            callId: "call_bash",
            name: "bash",
            argumentsJson: '{"command":"false"}',
          },
          {
            callId: "call_mcp",
            name: "mcp_s6_server_t6_search",
            argumentsJson: '{"query":"ohbaby"}',
          },
        ],
      },
      {
        role: "tool",
        callId: "call_bash",
        content:
          '<tool_metadata>\n{"exitCode":1,"signal":null}\n</tool_metadata>',
      },
      {
        role: "tool",
        callId: "call_mcp",
        content:
          'structured result\n\n<tool_metadata>\n{"server":"server","tool":"search","contentTypes":["text"],"structuredContent":{"count":1}}\n</tool_metadata>',
      },
    ]);
  });

  it("keeps aborted output, error and call pairing exactly once after restart", async () => {
    const manager = createMessageManager({
      bus: createBus(),
      store: createDatabaseMessageStore(),
      idGenerator: createMessageIds(),
    });
    const assistant = await manager.createMessage({
      sessionId: "session_1",
      role: "assistant",
      agent: "default",
    });
    await manager.appendPart(assistant.id, {
      type: "tool",
      callId: "call_aborted",
      tool: "bash",
      state: {
        status: "aborted",
        input: { command: "long-job" },
        output: "partial stdout",
        error: "Tool execution aborted by user",
        metadata: {
          exitCode: 130,
          signal: "SIGINT",
          internalPath: "private-path",
        },
      },
    });
    const history = await manager.listBySession("session_1");
    const before = serializeHistoryMessages(history);
    const summaryBefore = serializeHistory(history, {
      includeToolContext: true,
    });
    const result = before.find((message) => message.role === "tool");
    expect(before[0]).toMatchObject({
      role: "assistant",
      toolCalls: [
        {
          callId: "call_aborted",
          name: "bash",
          argumentsJson: '{"command":"long-job"}',
        },
      ],
    });
    expect(result).toMatchObject({ role: "tool", callId: "call_aborted" });
    if (typeof result?.content !== "string")
      throw new Error("Expected aborted tool text");
    for (const text of [result.content, summaryBefore]) {
      expect(text.match(/partial stdout/g)).toHaveLength(1);
      expect(text.match(/Tool execution aborted by user/g)).toHaveLength(1);
      expect(text).toContain('"exitCode":130');
      expect(text).not.toContain("private-path");
    }
    closeDatabase();
    initDatabase({ dbPath: databasePath });
    const restored = await createMessageManager({
      bus: createBus(),
      store: createDatabaseMessageStore(),
    }).listBySession("session_1");
    expect(restored).toEqual(history);
    expect(serializeHistoryMessages(restored)).toEqual(before);
    expect(serializeHistory(restored, { includeToolContext: true })).toBe(
      summaryBefore,
    );
  });

  it("projects deterministic unknown results for in-flight tools after restart", async () => {
    const messageManager = createMessageManager({
      bus: createBus(),
      store: createDatabaseMessageStore(),
      idGenerator: createMessageIds(),
      now: createClock(),
    });
    const assistant = await messageManager.createMessage({
      sessionId: "session_1",
      role: "assistant",
      agent: "default",
    });
    await messageManager.appendPart(assistant.id, {
      type: "tool",
      callId: "call_pending_write",
      tool: "write_file",
      state: {
        status: "pending",
        input: { path: "result.txt", content: "value" },
        raw: '{"path":"result.txt","content":"value"}',
      },
    });
    await messageManager.appendPart(assistant.id, {
      type: "tool",
      callId: "call_running_shell",
      tool: "bash",
      state: {
        status: "running",
        input: { command: "deploy" },
      },
    });

    closeDatabase();
    initDatabase({ dbPath: databasePath });
    const reopenedMessageManager = createMessageManager({
      bus: createBus(),
      store: createDatabaseMessageStore(),
      idGenerator: createMessageIds("reopened_"),
      now: createClock(),
    });
    const history = await reopenedMessageManager.listBySession("session_1");
    const first = serializeForLlm({
      history,
      systemPrompt: "",
    });
    const second = serializeForLlm({
      history,
      systemPrompt: "",
    });

    expect(first).toEqual(second);
    expect(first).toEqual([
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            callId: "call_pending_write",
            name: "write_file",
            argumentsJson: '{"path":"result.txt","content":"value"}',
          },
          {
            callId: "call_running_shell",
            name: "bash",
            argumentsJson: '{"command":"deploy"}',
          },
        ],
      },
      {
        role: "tool",
        callId: "call_pending_write",
        content:
          "Tool execution was interrupted before a durable result was recorded. Side effects may have occurred; verify before retrying.",
      },
      {
        role: "tool",
        callId: "call_running_shell",
        content:
          "Tool execution was interrupted before a durable result was recorded. Side effects may have occurred; verify before retrying.",
      },
    ]);
  });

  it("injects active reasoning only on assistant messages with tool calls", async () => {
    const messageManager = createMessageManager({
      bus: createBus(),
      store: createDatabaseMessageStore(),
      idGenerator: createMessageIds(),
      now: createClock(),
    });
    const toolAssistant = await messageManager.createMessage({
      sessionId: "session_1",
      role: "assistant",
      agent: "default",
    });
    await messageManager.appendPart(toolAssistant.id, {
      type: "tool",
      callId: "call_read",
      tool: "read_file",
      state: {
        status: "completed",
        input: { path: "README.md" },
        output: "file contents",
      },
    });
    const textAssistant = await messageManager.createMessage({
      sessionId: "session_1",
      role: "assistant",
      agent: "default",
    });
    await messageManager.appendPart(textAssistant.id, {
      type: "text",
      text: "Done",
    });

    const history = await messageManager.listBySession("session_1");
    const withReasoning = serializeForLlm({
      activeReasoningByMessageId: new Map([
        [toolAssistant.id, "deep thought"],
        [textAssistant.id, "unused thought"],
      ]),
      history,
      systemPrompt: "",
    });
    const withoutReasoning = serializeForLlm({
      activeReasoningByMessageId: new Map(),
      history,
      systemPrompt: "",
    });

    expect(withReasoning[0]).toEqual({
      role: "assistant",
      content: null,
      reasoningText: "deep thought",
      toolCalls: [
        {
          callId: "call_read",
          name: "read_file",
          argumentsJson: '{"path":"README.md"}',
        },
      ],
    });
    expect(withReasoning[2]).toEqual({
      role: "assistant",
      content: "Done",
    });
    expect(withoutReasoning[0]).toEqual({
      role: "assistant",
      content: null,
      toolCalls: [
        {
          callId: "call_read",
          name: "read_file",
          argumentsJson: '{"path":"README.md"}',
        },
      ],
    });
  });
});

it("replays persisted reminder blocks byte-for-byte across SQLite reopen and hides an abandoned anchor", async () => {
  const { createReminderCollector } =
    await import("../../services/reminder/index.js");
  let messages = createMessageManager({
    bus: createBus(),
    store: createDatabaseMessageStore(),
  });
  const historical = await messages.createMessage({
    sessionId: "session_1",
    role: "assistant",
    agent: "build",
  });
  await messages.appendPart(historical.id, {
    type: "tool",
    tool: "lookup",
    callId: "lookup-1",
    state: { status: "completed", input: {}, output: "UNCHANGED TOOL RESULT" },
  });
  const user = await messages.createMessage({
    sessionId: "session_1",
    role: "user",
    agent: "build",
  });
  await messages.appendPart(user.id, {
    type: "text",
    text: "USER <system-reminder>literal</system-reminder>",
  });
  const before = await messages.listBySession("session_1");
  const collectReminders = createReminderCollector([
    {
      type: "environment",
      kind: "snapshot",
      audience: "both",
      collect: (): { key: string; text: string } => ({
        key: "a",
        text: `ENV ${escapeReminderValue("<outside> & data")}`,
      }),
    },
    {
      type: "mode",
      kind: "snapshot",
      audience: "both",
      collect: (): { key: string; text: string } => ({
        key: "mode",
        text: "MODE",
      }),
    },
  ]);
  const manager = (): ReturnType<typeof createContextManager> =>
    createContextManager({
      bus: createBus(),
      messageManager: messages,
      collectReminders,
      systemPromptProvider: { build: () => Promise.resolve("HOST") },
      tokenCounter: {
        estimateTokens: (text) => text.length,
        getLimit: () => 128000,
      },
      llmClient: {
        generateSummary: () => {
          throw new Error("unexpected summary");
        },
      },
    });
  const input = {
    sessionId: "session_1",
    directory: "/repo",
    modelId: "m",
    toolNames: [],
    tools: undefined,
  };
  await manager().prepareTurn({ ...input, reminderAnchorId: "abandoned" });
  const prepared = await manager().prepareTurn({
    ...input,
    reminderAnchorId: "owner",
  });
  expect(JSON.stringify(prepared.request.messages).match(/ENV/g)).toHaveLength(
    1,
  );
  await messages.createMessage({
    id: "owner",
    sessionId: "session_1",
    role: "assistant",
    agent: "build",
  });
  await messages.appendPart("owner", { type: "text", text: "ANSWER" });
  closeDatabase();
  initDatabase({ dbPath: databasePath });
  messages = createMessageManager({
    bus: createBus(),
    store: createDatabaseMessageStore(),
  });
  const replay = await manager().prepareTurn({
    ...input,
    reminderAnchorId: "later",
  });
  expect(JSON.stringify(replay.request.messages.slice(0, -1))).toBe(
    JSON.stringify(prepared.request.messages),
  );
  expect(replay.request.messages.at(-1)).toEqual({
    role: "assistant",
    content: "ANSWER",
  });
  const all = await messages.listBySession("session_1");
  expect(
    all.filter((message) =>
      before.some((old) => old.info.id === message.info.id),
    ),
  ).toEqual(before);
  expect(
    all
      .flatMap((message) => message.parts)
      .filter((part) => part.metadata?.kind === "system-reminder:v1"),
  ).toHaveLength(4);
  const reminder = replay.request.messages.at(-2);
  expect(reminder).toEqual({
    role: "user",
    content: [
      {
        type: "text",
        source: "system-reminder",
        text: "<system-reminder>\nENV &lt;outside&gt; &amp; data\n</system-reminder>",
      },
      {
        type: "text",
        source: "system-reminder",
        text: "<system-reminder>\nMODE\n</system-reminder>",
      },
    ],
  });
});
