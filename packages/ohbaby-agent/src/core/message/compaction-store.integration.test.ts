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
import type { SummaryRequestRecord } from "ohbaby-llm";
import { createDatabaseMessageStore } from "./database-store.js";
import { createMessageManager } from "./manager.js";
import { createInMemoryMessageStore } from "./store.js";
import type { MessageManager, MessageStore } from "./types.js";

const summaryRequest: SummaryRequestRecord = {
  requestId: "summary_request",
  messageId: "summary_message",
  compactionId: "compaction_1",
  purpose: "context-summary",
  attempt: 2,
  startedAt: 1_000,
  endedAt: 1_100,
  outcome: "success",
  usage: {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    reasoningTokens: 0,
  },
};

describe.each(["memory", "database"] as const)(
  "%s compaction commit",
  (backend) => {
    let directory: string | undefined;
    let databasePath: string;
    let store: MessageStore;
    let manager: MessageManager;

    beforeEach(async () => {
      if (backend === "database") {
        directory = await mkdtemp(join(tmpdir(), "ohbaby-compaction-store-"));
        databasePath = join(directory, "agent.db");
        initDatabase({ dbPath: databasePath });
        getDatabase()
          .prepare(
            `INSERT INTO ${schema.session.tableName}
              (id, project_id, project_root, agent, title, status, created_at, updated_at, message_count, data)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "session_1",
            "project_1",
            "/repo",
            "default",
            "Session",
            "active",
            1,
            1,
            0,
            "{}",
          );
      }
      store =
        backend === "database"
          ? createDatabaseMessageStore()
          : createInMemoryMessageStore();
      manager = createMessageManager({
        store,
        bus: createBus(),
        now: () => 100,
      });
    });

    afterEach(async () => {
      if (backend === "database") closeDatabase();
      if (directory !== undefined) {
        await rm(directory, { recursive: true, force: true });
        directory = undefined;
      }
    });

    async function seedToolMessage(): Promise<{
      messageId: string;
      textPartId: string;
      toolPartId: string;
    }> {
      const message = await manager.createMessage({
        id: "history_message",
        role: "assistant",
        agent: "build",
        sessionId: "session_1",
      });
      const text = await manager.appendPart(message.id, {
        type: "text",
        text: "Earlier implementation notes",
      });
      const tool = await manager.appendPart(message.id, {
        type: "tool",
        callId: "call_1",
        tool: "read",
        state: { status: "completed", input: {}, output: "Original result" },
      });
      return {
        messageId: message.id,
        textPartId: text.id,
        toolPartId: tool.id,
      };
    }

    it("persists summary ownership and omission metadata with retirement while allowing new input", async () => {
      await seedToolMessage();
      const expectedMessages = await manager.listBySession("session_1");
      const expectedParts = expectedMessages.flatMap(
        (message) => message.parts,
      );
      const newInput = await manager.createMessage({
        id: "new_input",
        role: "user",
        agent: "build",
        sessionId: "session_1",
      });
      await manager.appendPart(newInput.id, { type: "text", text: "Continue" });

      const committed = await manager.commitCompaction({
        sessionId: "session_1",
        compactedAt: 200,
        expectedMessages,
        expectedParts,
        summary: {
          messageId: "summary_message",
          agent: "context-summary",
          text: "Current state",
          modelRequests: [summaryRequest],
          metadata: {
            kind: "untrusted-kind",
            compactionId: "compaction_1",
            omittedPartIds: [expectedParts[0].id],
            omissionReason: "summary-capacity",
          },
        },
      });
      expect(committed?.summary?.message.id).toBe("summary_message");
      if (backend === "database") {
        closeDatabase();
        initDatabase({ dbPath: databasePath });
        store = createDatabaseMessageStore();
      }
      const history = await store.listBySession("session_1");
      const summary = history.find(
        (message) => message.info.id === "summary_message",
      );
      expect(summary?.info).toMatchObject({ modelRequests: [summaryRequest] });
      expect(summary?.info).not.toHaveProperty("runId");
      expect(summary?.parts[0]).toMatchObject({
        text: "Current state",
        metadata: {
          kind: "context-summary",
          compactionId: "compaction_1",
          omittedPartIds: [expectedParts[0].id],
          omissionReason: "summary-capacity",
        },
      });
      expect(
        history.find((message) => message.info.id === "history_message")?.parts,
      ).toEqual(
        expectedParts.map((part) => ({
          ...part,
          time: { ...part.time, compacted: 200 },
        })),
      );
      const keptInput = history.find(
        (message) => message.info.id === "new_input",
      );
      expect(keptInput?.parts[0]).toMatchObject({ text: "Continue" });
      expect(keptInput?.parts[0].time?.compacted).toBeUndefined();
    });

    it.each(["new-tool-part", "changed-kept-tool", "changed-message"] as const)(
      "rejects a candidate when its existing tool group has a %s",
      async (change) => {
        const seeded = await seedToolMessage();
        const expectedMessages = await manager.listBySession("session_1");
        const expectedParts = expectedMessages[0].parts.filter(
          (part) => part.id === seeded.textPartId,
        );
        if (change === "new-tool-part") {
          await manager.appendPart(seeded.messageId, {
            type: "tool",
            callId: "call_2",
            tool: "read",
            state: { status: "completed", input: {}, output: "New result" },
          });
        } else if (change === "changed-kept-tool") {
          await manager.updatePart(seeded.toolPartId, {
            state: { status: "completed", input: {}, output: "Changed result" },
          });
        } else {
          await manager.updateMessage(seeded.messageId, {
            finish: "tool_calls",
          });
        }
        await expect(
          manager.commitCompaction({
            sessionId: "session_1",
            compactedAt: 200,
            expectedMessages,
            expectedParts,
            summary: {
              messageId: "summary_message",
              agent: "context-summary",
              text: "Stale summary",
            },
          }),
        ).resolves.toBeUndefined();
        const history = await store.listBySession("session_1");
        expect(history).toHaveLength(1);
        expect(
          history[0].parts.every((part) => part.time?.compacted === undefined),
        ).toBe(true);
      },
    );

    it("does not write when Stop arrives while compaction waits in the commit queue", async () => {
      await seedToolMessage();
      const expectedMessages = await manager.listBySession("session_1");
      const controller = new AbortController();
      let entered!: () => void;
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      manager.setCommitCoordinator({
        async run(_sessionId, operation) {
          entered();
          await gate;
          return operation();
        },
        onCommitted: () => undefined,
        onProjectionError: () => undefined,
      });
      const pending = manager.commitCompaction({
        sessionId: "session_1",
        compactedAt: 200,
        expectedMessages,
        expectedParts: expectedMessages[0].parts,
        signal: controller.signal,
        summary: {
          messageId: "summary_message",
          agent: "context-summary",
          text: "Must not be committed",
          modelRequests: [summaryRequest],
        },
      });
      await waiting;
      controller.abort();
      release();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      if (backend === "database") {
        closeDatabase();
        initDatabase({ dbPath: databasePath });
        store = createDatabaseMessageStore();
      }
      await expect(store.listBySession("session_1")).resolves.toEqual(
        expectedMessages,
      );
    });

    it("keeps the successful transaction when Stop arrives after the write", async () => {
      await seedToolMessage();
      const expectedMessages = await manager.listBySession("session_1");
      const controller = new AbortController();
      manager.setCommitCoordinator({
        async run(_sessionId, operation) {
          const committed = await operation();
          controller.abort();
          return committed;
        },
        onCommitted: () => undefined,
        onProjectionError: () => undefined,
      });
      const committed = await manager.commitCompaction({
        sessionId: "session_1",
        compactedAt: 200,
        expectedMessages,
        expectedParts: expectedMessages[0].parts,
        signal: controller.signal,
        summary: {
          messageId: "summary_message",
          agent: "context-summary",
          text: "Committed before Stop",
          modelRequests: [summaryRequest],
        },
      });
      expect(controller.signal.aborted).toBe(true);
      expect(committed?.summary?.message.id).toBe("summary_message");
      if (backend === "database") {
        closeDatabase();
        initDatabase({ dbPath: databasePath });
        store = createDatabaseMessageStore();
      }
      const history = await store.listBySession("session_1");
      expect(
        history.find((message) => message.info.id === "summary_message")
          ?.parts[0],
      ).toMatchObject({ text: "Committed before Stop" });
      expect(
        history
          .find((message) => message.info.id === "history_message")
          ?.parts.every((part) => part.time?.compacted === 200),
      ).toBe(true);
    });

    if (backend === "database") {
      it("rolls back the summary and retirement when a later part update fails", async () => {
        const seeded = await seedToolMessage();
        const expectedMessages = await manager.listBySession("session_1");
        getDatabase().exec(`CREATE TRIGGER fail_compaction_update
          BEFORE UPDATE ON ${schema.part.tableName}
          WHEN OLD.id = '${seeded.toolPartId}'
          BEGIN SELECT RAISE(ABORT, 'compaction write failed'); END`);
        await expect(
          manager.commitCompaction({
            sessionId: "session_1",
            compactedAt: 200,
            expectedMessages,
            expectedParts: expectedMessages[0].parts,
            summary: {
              messageId: "summary_message",
              agent: "context-summary",
              text: "Must roll back",
              modelRequests: [summaryRequest],
              metadata: { omittedPartIds: [seeded.textPartId] },
            },
          }),
        ).rejects.toThrow("compaction write failed");
        closeDatabase();
        initDatabase({ dbPath: databasePath });
        await expect(
          createDatabaseMessageStore().listBySession("session_1"),
        ).resolves.toEqual(expectedMessages);
      });
    }
  },
);
