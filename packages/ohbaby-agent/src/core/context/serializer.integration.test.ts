import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  type MessageIdGenerator,
} from "../message/index.js";
import { serializeForLlm } from "./serializer.js";

const cleanupPaths: string[] = [];

function createMessageIds(): MessageIdGenerator {
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
  initDatabase({ dbPath: join(directory, "agent.db") });
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
      isSubagent: false,
      memory: { global: "", project: "", merged: "" },
      systemPrompt: "",
    });

    expect(messages).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_bash",
            type: "function",
            function: {
              name: "bash",
              arguments: "{\"command\":\"false\"}",
            },
          },
          {
            id: "call_mcp",
            type: "function",
            function: {
              name: "mcp_s6_server_t6_search",
              arguments: "{\"query\":\"ohbaby\"}",
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_bash",
        content:
          '<tool_metadata>\n{"exitCode":1,"signal":null}\n</tool_metadata>',
      },
      {
        role: "tool",
        tool_call_id: "call_mcp",
        content:
          'structured result\n\n<tool_metadata>\n{"server":"server","tool":"search","contentTypes":["text"],"structuredContent":{"count":1}}\n</tool_metadata>',
      },
    ]);
  });
});
