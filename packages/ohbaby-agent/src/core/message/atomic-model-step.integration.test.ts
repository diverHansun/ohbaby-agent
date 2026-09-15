import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BusInstance } from "../../bus/index.js";
import { createBus } from "../../bus/index.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
  schema,
} from "../../services/database/index.js";
import type { ModelState } from "../../services/interface-providers/native-state.js";
import { createDatabaseMessageStore } from "./database-store.js";
import { createInMemoryMessageStore } from "./store.js";
import { createMessageManager } from "./manager.js";
import { MessageEvent } from "./events.js";
import type {
  CommitModelStepInput,
  MessageStore,
  Part,
  MessageManager,
  Message,
} from "./types.js";

let directory = "";
let databasePath = "";
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ohbaby-atomic-step-"));
  databasePath = join(directory, "agent.db");
  initDatabase({ dbPath: databasePath });
  getDatabase()
    .prepare(
      `INSERT INTO ${schema.session.tableName} (id,project_id,project_root,agent,title,status,created_at,updated_at,message_count,data) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      "session",
      "project",
      "/repo",
      "default",
      "test",
      "active",
      1,
      1,
      0,
      "{}",
    );
});
afterEach(async () => {
  closeDatabase();
  await rm(directory, { recursive: true, force: true });
});
const state: ModelState = {
  version: 1,
  origin: {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    protocol: "anthropic",
    endpoint: "https://api.anthropic.com",
  },
  output: {
    protocol: "anthropic",
    items: [
      {
        type: "thinking",
        thinking: "private thought",
        signature: "opaque signature",
      },
      { type: "text", text: "Checking" },
      {
        type: "tool_use",
        id: "call-1",
        name: "read_file",
        input: { path: "a.txt" },
      },
    ],
  },
  estimate: { tokens: 20, source: "reasoning" },
};
function input(messageId: string, textPartId?: string): CommitModelStepInput {
  return {
    assistantMessageId: messageId,
    ...(textPartId === undefined ? {} : { textPartId }),
    text: "Checking",
    modelState: structuredClone(state),
    tools: [
      {
        callId: "call-1",
        name: "read_file",
        arguments: { path: "a.txt" },
        argumentsJson: '{"path":"a.txt"}',
      },
    ],
    tokenUsage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
    finishReason: "tool_calls",
    completedAt: 200,
  };
}
async function setup(store: MessageStore): Promise<{
  manager: MessageManager;
  bus: BusInstance;
  message: Message;
  textPart: Part;
}> {
  const bus = createBus();
  let next = 0;
  const manager = createMessageManager({
    store,
    bus,
    now: () => 100,
    idGenerator: {
      messageId: () => `message-${String(++next)}`,
      partId: () => `part-${String(++next)}`,
    },
  });
  const message = await manager.createMessage({
    sessionId: "session",
    role: "assistant",
    agent: "default",
    providerId: "anthropic",
    modelId: "claude-sonnet-4-6",
  });
  const textPart = await manager.appendPart(message.id, {
    type: "text",
    text: "Check",
  });
  return { manager, bus, message, textPart };
}
for (const backend of ["memory", "sqlite"] as const) {
  describe(`atomic model step (${backend})`, () => {
    const createStore = (): MessageStore =>
      backend === "sqlite"
        ? createDatabaseMessageStore()
        : createInMemoryMessageStore();
    it("commits one state, pending tools, one usage carrier and completion, then rejects a duplicate", async () => {
      const store = createStore();
      const { manager, message, textPart, bus } = await setup(store);
      const events: Part[] = [];
      bus.subscribe(MessageEvent.PartUpdated, ({ part }) => {
        events.push(part);
      });
      const result = await manager.commitModelStep(
        input(message.id, textPart.id),
      );
      expect(result.toolParts).toMatchObject([
        {
          callId: "call-1",
          tool: "read_file",
          state: {
            status: "pending",
            input: { path: "a.txt" },
            raw: '{"path":"a.txt"}',
          },
        },
      ]);
      expect(result.message.time.completed).toBe(200);
      expect(result.textPart).toMatchObject({
        id: textPart.id,
        text: "Checking",
        metadata: {
          tokenUsage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
        },
      });
      expect(events.map((part) => part.type)).toEqual(["text", "tool"]);
      expect(JSON.stringify(events)).not.toContain("opaque signature");
      await expect(
        manager.commitModelStep(input(message.id, textPart.id)),
      ).rejects.toThrow(/already.*commit|completed/i);
      const saved = await store.listBySession("session");
      expect(
        saved[0].parts.filter((part) => part.type === "model-state"),
      ).toHaveLength(1);
      expect(
        saved[0].parts.filter((part) => part.type === "tool"),
      ).toHaveLength(1);
      expect(
        saved[0].parts.filter(
          (part) => part.metadata?.tokenUsage !== undefined,
        ),
      ).toHaveLength(1);
    });
    it("rejects projection mismatch with no changes or completion event", async () => {
      const store = createStore();
      const { manager, message, textPart, bus } = await setup(store);
      const before = await store.listBySession("session");
      const events: unknown[] = [];
      bus.subscribe(MessageEvent.PartUpdated, (event) => {
        events.push(event);
      });
      bus.subscribe(MessageEvent.Updated, (event) => {
        events.push(event);
      });
      await expect(
        manager.commitModelStep({
          ...input(message.id, textPart.id),
          text: "wrong",
        }),
      ).rejects.toThrow(/projection/);
      expect(await store.listBySession("session")).toEqual(before);
      expect(events).toEqual([]);
    });
    it("stores usage on the first tool when no text exists and on state for reasoning-only output", async () => {
      const store = createStore();
      const manager = createMessageManager({ store, bus: createBus() });
      for (const withTool of [true, false]) {
        const message = await manager.createMessage({
          sessionId: "session",
          role: "assistant",
          agent: "default",
        });
        const args = input(message.id);
        const output: ModelState = {
          ...state,
          output: {
            protocol: "anthropic",
            items:
              state.output.protocol === "anthropic"
                ? state.output.items.filter(
                    (item) =>
                      item.type === "thinking" ||
                      (withTool && item.type === "tool_use"),
                  )
                : [],
          },
        };
        const result = await manager.commitModelStep({
          ...args,
          text: "",
          modelState: output,
          tools: withTool ? args.tools : [],
        });
        expect(result.textPart).toBeUndefined();
        expect(
          (withTool ? result.toolParts[0] : result.modelStatePart).metadata
            ?.tokenUsage?.totalTokens,
        ).toBe(30);
        const saved = (await store.listBySession("session")).find(
          (row) => row.info.id === message.id,
        );
        expect(
          saved?.parts.filter(
            (part) => part.metadata?.tokenUsage !== undefined,
          ),
        ).toHaveLength(1);
      }
    });
    it("rejects incomplete native item status before commit", async () => {
      const { manager, message, textPart } = await setup(createStore());
      const incomplete: ModelState = {
        ...state,
        origin: { ...state.origin, protocol: "openai-responses" },
        output: {
          protocol: "openai-responses",
          items: [
            {
              type: "reasoning",
              id: "rs-1",
              summary: [],
              status: "in_progress",
            },
            {
              type: "message",
              id: "msg-1",
              role: "assistant",
              status: "completed",
              content: [
                { type: "output_text", text: "Checking", annotations: [] },
              ],
            },
          ],
        },
      };
      await expect(
        manager.commitModelStep({
          ...input(message.id, textPart.id),
          tools: [],
          modelState: incomplete,
        }),
      ).rejects.toThrow(/incomplete/i);
    });
    it("never publishes model-state parts when compaction updates private state", async () => {
      const store = createStore();
      const { manager, message, textPart, bus } = await setup(store);
      const committed = await manager.commitModelStep(
        input(message.id, textPart.id),
      );
      const events: Part[] = [];
      bus.subscribe(MessageEvent.PartUpdated, ({ part }) => {
        events.push(part);
      });
      await manager.commitCompaction({
        sessionId: "session",
        compactedAt: 300,
        expectedParts: [committed.modelStatePart],
      });
      expect(events).toEqual([]);
    });
    it("rejects duplicate call ids before any writes", async () => {
      const store = createStore();
      const { manager, message, textPart } = await setup(store);
      const args = input(message.id, textPart.id);
      await expect(
        manager.commitModelStep({
          ...args,
          tools: [...args.tools, ...args.tools],
        }),
      ).rejects.toThrow(/duplicate/i);
      expect((await store.listBySession("session"))[0].parts).toHaveLength(1);
    });
  });
}
describe("SQLite atomic failure and restart", () => {
  it.each(["state", "tool", "completion"])(
    "rolls back failure at %s and remains uncommitted after reopen",
    async (stage) => {
      const store = createDatabaseMessageStore();
      const { manager, message, textPart } = await setup(store);
      const trigger =
        stage === "completion"
          ? `BEFORE UPDATE ON ${schema.message.tableName}`
          : `BEFORE INSERT ON ${schema.part.tableName} WHEN NEW.type = '${stage === "state" ? "model-state" : "tool"}'`;
      getDatabase().exec(
        `CREATE TRIGGER fail_step ${trigger} BEGIN SELECT RAISE(ABORT, 'injected atomic failure'); END;`,
      );
      await expect(
        manager.commitModelStep(input(message.id, textPart.id)),
      ).rejects.toThrow(/injected atomic failure/);
      closeDatabase();
      initDatabase({ dbPath: databasePath });
      const rows = await createDatabaseMessageStore().listBySession("session");
      expect(rows[0].info.time.completed).toBeUndefined();
      expect(rows[0].parts).toEqual([textPart]);
    },
  );
  it("reopens a committed collection with exact private state and unique pending tool", async () => {
    const { manager, message, textPart } = await setup(
      createDatabaseMessageStore(),
    );
    await manager.commitModelStep(input(message.id, textPart.id));
    closeDatabase();
    initDatabase({ dbPath: databasePath });
    const rows = await createDatabaseMessageStore().listBySession("session");
    expect(rows[0].info.time.completed).toBe(200);
    expect(
      rows[0].parts.find((part) => part.type === "model-state"),
    ).toMatchObject({ modelState: state });
    expect(rows[0].parts.filter((part) => part.type === "tool")).toHaveLength(
      1,
    );
  });
});
