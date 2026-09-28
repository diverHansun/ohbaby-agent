import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBus } from "../../bus/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../../core/message/index.js";
import {
  InMemorySubagentExecutionStore,
  DatabaseSubagentExecutionStore,
} from "../../agents/subagents/execution-store.js";
import type { SubagentExecutionStore } from "../../agents/subagents/execution-store.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../../services/database/index.js";
import { messageToUiMessage } from "../ui-state/persistent-store.js";
import { createSubagentConversationHistory } from "./subagent-conversation-history.js";

async function fixture(
  executions: SubagentExecutionStore = new InMemorySubagentExecutionStore(),
) {
  await Promise.resolve();
  const store = createInMemoryMessageStore();
  const messages = createMessageManager({ bus: createBus(), store });
  const reader = createSubagentConversationHistory({
    executions,
    messages,
    project: messageToUiMessage,
  });
  async function accept(id: string, subagentId = "a") {
    const { record } = await executions.accept({
      executionId: id,
      requestId: id,
      parentSessionId: "root",
      requesterScopeId: "primary",
      requesterRunId: "root-run",
      rootSessionId: "root",
      rootRunId: "root-run",
      subagentId,
      mode: "background",
      prompt: `Prompt ${id}`,
      createdAt: 1000,
    });
    await executions.bindChild(
      record,
      { sessionId: "child", contextScopeId: subagentId },
      1001,
    );
    return record;
  }
  async function add(id: string, runId: string, scope = "a") {
    const message = {
      id,
      sessionId: "child",
      contextScopeId: scope,
      runId,
      role: "assistant",
      agent: "explore",
      time: { created: 2000 },
    } as const;
    await store.insertMessage(message);
    await store.appendPart({
      message,
      partId: `${id}-text`,
      data: { type: "text", text: id },
      updatedAt: 2001,
    });
  }
  return { reader, executions, messages, store, accept, add };
}

describe("subagent conversation history", () => {
  it("pages backward into legacy executions and forward into sequenced executions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "subagent-history-legacy-"));
    try {
      initDatabase({ dbPath: join(dir, "agent.db") });
      const f = await fixture(
        new DatabaseSubagentExecutionStore({ db: getDatabase() }),
      );
      const first = await f.accept("legacy-a");
      await f.executions.start(first, "old-a", 1002);
      await f.add("answer-a", "old-a");
      const second = await f.accept("legacy-b");
      await f.executions.start(second, "old-b", 1003);
      await f.add("answer-b", "old-b");
      getDatabase()
        .prepare(
          "UPDATE subagent_execution SET delegation_sequence = NULL, child_user_message_id = NULL WHERE execution_id IN (?, ?)",
        )
        .run("legacy-a", "legacy-b");
      const modern = await f.accept("modern");
      await f.executions.start(modern, "new-run", 1004);
      await f.add("answer-new", "new-run");
      const newest = await f.reader.read({
        rootSessionId: "root",
        subagentId: "a",
        limit: 2,
      });
      expect(newest.messages.map((m) => m.id)).toEqual([
        modern.childUserMessageId,
        "answer-new",
      ]);
      const older = await f.reader.read({
        rootSessionId: "root",
        subagentId: "a",
        before: newest.history.before,
        limit: 1,
      });
      expect(older.messages.map((m) => m.id)).toEqual(["answer-b"]);
      const oldest = await f.reader.read({
        rootSessionId: "root",
        subagentId: "a",
        before: older.history.before,
        limit: 1,
      });
      expect(oldest.messages.map((m) => m.id)).toEqual(["answer-a"]);
      const forward = await f.reader.read({
        rootSessionId: "root",
        subagentId: "a",
        after: oldest.history.after,
        limit: 1,
      });
      expect(forward.messages.map((m) => m.id)).toEqual(["answer-b"]);
      const boundary = await f.reader.read({
        rootSessionId: "root",
        subagentId: "a",
        after: forward.history.after,
        limit: 1,
      });
      expect(boundary.messages.map((m) => m.id)).toEqual([
        modern.childUserMessageId,
      ]);
    } finally {
      closeDatabase();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("advances a bounded empty page past filtered messages toward a visible item", async () => {
    const f = await fixture();
    const execution = await f.accept("e1");
    await f.executions.start(execution, "run-1", 1002);
    for (let i = 0; i < 8; i++)
      await f.store.insertMessage({
        id: `hidden-${String(i)}`,
        sessionId: "child",
        contextScopeId: "a",
        runId: "run-1",
        role: "assistant",
        agent: "explore",
        time: { created: 2000 + i },
      });
    const visible = {
      id: "visible",
      sessionId: "child",
      contextScopeId: "a",
      runId: "run-1",
      role: "assistant",
      agent: "explore",
      time: { created: 3000 },
    } as const;
    await f.store.insertMessage(visible);
    await f.store.appendPart({
      message: visible,
      partId: "visible-text",
      data: { type: "text", text: "visible" },
      updatedAt: 3001,
    });
    const anchor = await f.reader.read({
      rootSessionId: "root",
      subagentId: "a",
      anchorExecutionId: "e1",
      limit: 1,
    });
    expect(anchor.history.hasLater).toBe(true);
    let cursor = anchor.history.after;
    let found = false;
    for (let i = 0; i < 5; i++) {
      const page = await f.reader.read({
        rootSessionId: "root",
        subagentId: "a",
        after: cursor,
        limit: 1,
      });
      if (page.messages.some((m) => m.id === "visible")) {
        found = true;
        break;
      }
      expect(page.history.hasLater).toBe(true);
      expect(page.history.after).toBeDefined();
      expect(page.history.after).not.toBe(cursor);
      cursor = page.history.after;
    }
    expect(found).toBe(true);
  });
  it("crosses several empty legacy executions with a resumable cursor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "subagent-history-empty-"));
    try {
      initDatabase({ dbPath: join(dir, "agent.db") });
      const f = await fixture(
        new DatabaseSubagentExecutionStore({ db: getDatabase() }),
      );
      const old = await f.accept("a-old");
      await f.executions.start(old, "old-run", 1002);
      await f.add("old-answer", "old-run");
      for (const id of ["b-gap", "c-gap", "d-gap"]) await f.accept(id);
      getDatabase()
        .prepare(
          "UPDATE subagent_execution SET delegation_sequence = NULL, child_user_message_id = NULL WHERE execution_id <> 'modern'",
        )
        .run();
      const modern = await f.accept("modern");
      const first = await f.reader.read({
        rootSessionId: "root",
        subagentId: "a",
        before: (
          await f.reader.read({
            rootSessionId: "root",
            subagentId: "a",
            limit: 1,
          })
        ).history.before,
        limit: 1,
      });
      expect(first.messages).toEqual([]);
      expect(first.history.hasMore).toBe(true);
      expect(first.history.before).toBeDefined();
      const next = await f.reader.read({
        rootSessionId: "root",
        subagentId: "a",
        before: first.history.before,
        limit: 1,
      });
      expect(next.messages.map((m) => m.id)).toEqual(["old-answer"]);
      expect(modern.delegationSequence).toBe(1);
    } finally {
      closeDatabase();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("pages across execution segments in acceptance order with stable parent prompt identity", async () => {
    const f = await fixture();
    const first = await f.accept("e1");
    await f.executions.start(first, "run-1", 1002);
    await f.add("a1", "run-1");
    await f.add("a2", "run-1");
    const second = await f.accept("e2");
    await f.executions.start(second, "run-2", 1003);
    await f.add("b1", "run-2");
    await f.add("foreign", "run-foreign", "b");

    const latest = await f.reader.read({
      rootSessionId: "root",
      subagentId: "a",
      limit: 2,
    });
    expect(latest.messages.map((m) => m.id)).toEqual([
      second.childUserMessageId,
      "b1",
    ]);
    expect(latest.history.hasMore).toBe(true);
    const older = await f.reader.read({
      rootSessionId: "root",
      subagentId: "a",
      before: latest.history.before,
      limit: 2,
    });
    expect(older.messages.map((m) => m.id)).toEqual(["a1", "a2"]);
    const earliest = await f.reader.read({
      rootSessionId: "root",
      subagentId: "a",
      before: older.history.before,
      limit: 2,
    });
    expect(earliest.messages.map((m) => m.id)).toEqual([
      first.childUserMessageId,
    ]);
    expect(earliest.history.hasMore).toBe(false);
    const forward = await f.reader.read({
      rootSessionId: "root",
      subagentId: "a",
      after: earliest.history.after,
      limit: 2,
    });
    expect(forward.messages.map((m) => m.id)).toEqual(["a1", "a2"]);
    expect(forward.history.hasLater).toBe(true);
  });

  it("anchors accepted prompts, replaces synthetic content with persisted user content, and rejects foreign cursors", async () => {
    const f = await fixture();
    const a = await f.accept("e1");
    if (!a.childUserMessageId) throw new Error("Missing child message ID");
    const queued = await f.reader.read({
      rootSessionId: "root",
      subagentId: "a",
      anchorExecutionId: "e1",
    });
    expect(queued.anchorFound).toBe(true);
    expect(queued.anchorMessageId).toBe(a.childUserMessageId);
    expect(queued.messages[0]?.parts).toMatchObject([
      { type: "text", text: "Prompt e1" },
    ]);
    await f.store.insertMessage({
      id: a.childUserMessageId,
      sessionId: "child",
      contextScopeId: "a",
      role: "user",
      agent: "explore",
      time: { created: 1001 },
    });
    const empty = await f.reader.read({
      rootSessionId: "root",
      subagentId: "a",
      anchorExecutionId: "e1",
    });
    expect(empty.messages[0]?.parts).toMatchObject([
      { type: "text", text: "Prompt e1" },
    ]);
    const persistedUser = await f.store.getMessage(a.childUserMessageId);
    if (!persistedUser) throw new Error("Missing persisted user message");
    await f.store.appendPart({
      message: persistedUser,
      partId: "real-text",
      data: { type: "text", text: "Persisted prompt" },
      updatedAt: 1002,
    });
    await f.executions.start(a, "run-1", 1003);
    const persisted = await f.reader.read({
      rootSessionId: "root",
      subagentId: "a",
      anchorExecutionId: "e1",
    });
    expect(persisted.messages.map((m) => m.id)).toEqual([a.childUserMessageId]);
    expect(persisted.messages[0]?.parts).toMatchObject([
      { type: "text", text: "Persisted prompt" },
    ]);
    await f.accept("foreign", "b");
    await expect(
      f.reader.read({
        rootSessionId: "root",
        subagentId: "a",
        anchorExecutionId: "foreign",
      }),
    ).rejects.toThrow();
    const tail = await f.reader.read({
      rootSessionId: "root",
      subagentId: "a",
    });
    await expect(
      f.reader.read({
        rootSessionId: "root",
        subagentId: "b",
        before: tail.history.before,
      }),
    ).rejects.toThrow();
  });

  it("does not assign scope messages to a legacy execution without a run ID", async () => {
    const f = await fixture();
    const accepted = await f.accept("legacy");
    await f.executions.start(accepted, "run-old", 1002);
    await f.add("a", "run-old");
    await f.add("b", "run-new");
    const legacy = (
      record: Awaited<ReturnType<SubagentExecutionStore["getForRoot"]>>,
    ) =>
      record && {
        ...record,
        childUserMessageId: undefined,
        delegationSequence: undefined,
        childRunId: undefined,
      };
    const executions = {
      list: async (input: Parameters<SubagentExecutionStore["list"]>[0]) =>
        (await f.executions.list(input)).map((record) => {
          const result = legacy(record);
          if (!result) throw new Error("Missing legacy record");
          return result;
        }),
      getForRoot: async (id: string, root: string) =>
        legacy(await f.executions.getForRoot(id, root)),
    };
    const reader = createSubagentConversationHistory({
      executions,
      messages: f.messages,
      project: messageToUiMessage,
    });
    const latest = await reader.read({
      rootSessionId: "root",
      subagentId: "a",
      limit: 1,
    });
    expect(latest.messages).toEqual([]);
    expect(latest.messages.some((m) => m.role === "user")).toBe(false);
    expect(latest.history.hasMore).toBe(false);
    const anchored = await reader.read({
      rootSessionId: "root",
      subagentId: "a",
      anchorExecutionId: accepted.executionId,
    });
    expect(anchored.anchorMessageId).toBeUndefined();
    expect(anchored.anchorFound).toBe(false);
  });

  it("walks past an empty legacy execution between populated segments", async () => {
    const f = await fixture();
    const first = await f.accept("first");
    await f.executions.start(first, "first-run", 1002);
    await f.add("first-answer", "first-run");
    await f.accept("gap");
    const last = await f.accept("last");
    await f.executions.start(last, "last-run", 1003);
    await f.add("last-answer", "last-run");
    const withoutGapPrompt = (
      record: NonNullable<
        Awaited<ReturnType<SubagentExecutionStore["getForRoot"]>>
      >,
    ) =>
      record.executionId === "gap"
        ? { ...record, childUserMessageId: undefined }
        : record;
    const reader = createSubagentConversationHistory({
      executions: {
        list: async (input: Parameters<SubagentExecutionStore["list"]>[0]) =>
          (await f.executions.list(input)).map(withoutGapPrompt),
        getForRoot: async (id: string, root: string) => {
          const record = await f.executions.getForRoot(id, root);
          return record ? withoutGapPrompt(record) : null;
        },
      },
      messages: f.messages,
      project: messageToUiMessage,
    });
    const latest = await reader.read({
      rootSessionId: "root",
      subagentId: "a",
      limit: 2,
    });
    expect(latest.messages.map((m) => m.id)).toEqual([
      last.childUserMessageId,
      "last-answer",
    ]);
    const older = await reader.read({
      rootSessionId: "root",
      subagentId: "a",
      before: latest.history.before,
      limit: 2,
    });
    expect(older.messages.map((m) => m.id)).toEqual([
      first.childUserMessageId,
      "first-answer",
    ]);
    expect(older.executions.map((record) => record.executionId)).toContain(
      "gap",
    );
  });
});
