import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBus } from "../../bus/index.js";
import {
  createDatabaseMessageStore,
  createMessageManager,
} from "../../core/message/index.js";
import { SUMMARY_AGENT_NAME } from "../../core/context/index.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
  schema,
} from "../../services/database/index.js";
import {
  createDatabaseSessionStore,
  createSessionManager,
  type ProjectResolver,
} from "../../services/session/index.js";
import { createDatabaseRunLedger } from "../../runtime/run-ledger/index.js";
import {
  createDatabaseUiAppStateStore,
  createPersistentUiStateStore,
} from "./persistent-store.js";
import { createInProcessUiBackendClient } from "../ui-inprocess.js";

const cleanupPaths: string[] = [];

const PROJECT_RESOLVER: ProjectResolver = {
  fromDirectory(directory: string) {
    return {
      id: `project:${directory}`,
      rootPath: directory,
    };
  },
};

beforeEach(async () => {
  const directory = await mkdtemp(join(tmpdir(), "ohbaby-ui-state-db-"));
  cleanupPaths.push(directory);
  initDatabase({ dbPath: join(directory, "agent.db") });
});

afterEach(async () => {
  closeDatabase();
  await Promise.all(
    cleanupPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("createPersistentUiStateStore", () => {
  it("restores sessions, messages, tool parts, active session, and runs from database services", async () => {
    const messageStore = createDatabaseMessageStore();
    const messageManager = createMessageManager({
      bus: createBus(),
      store: messageStore,
      idGenerator: createDeterministicMessageIds(),
      now: createClock(2_000),
    });
    const sessionManager = createSessionManager({
      bus: createBus(),
      createSessionId: () => "session_1",
      messageCleaner: {
        removeMessages(sessionId: string) {
          return messageManager.removeMessages(sessionId);
        },
      },
      now: createClock(1_000),
      projectResolver: PROJECT_RESOLVER,
      store: createDatabaseSessionStore(),
    });
    const runLedger = createDatabaseRunLedger({ now: createClock(10_000) });
    const appState = createDatabaseUiAppStateStore({ now: () => 20_000 });

    const session = await sessionManager.create("D:/repo", {
      title: "Recovered session",
    });
    const user = await messageManager.createMessage({
      agent: "default",
      role: "user",
      sessionId: session.id,
    });
    await messageManager.appendPart(user.id, {
      text: "Inspect database state",
      type: "text",
    });
    const assistant = await messageManager.createMessage({
      agent: "default",
      parentId: user.id,
      role: "assistant",
      sessionId: session.id,
    });
    await messageManager.appendPart(assistant.id, {
      callId: "call_read",
      state: {
        input: { path: "README.md" },
        output: "file contents",
        status: "completed",
      },
      tool: "read",
      type: "tool",
    });
    await messageManager.appendPart(assistant.id, {
      text: "Done",
      type: "text",
    });
    await runLedger.createPending({
      runId: "run_1",
      sessionId: session.id,
      triggerSource: "user",
    });
    await runLedger.markRunning("run_1");
    await runLedger.markSucceeded("run_1");
    await appState.setActiveSessionId(session.id);

    const restoredStore = createPersistentUiStateStore({
      appState,
      messageManager: createMessageManager({
        bus: createBus(),
        store: createDatabaseMessageStore(),
      }),
      runLedger: createDatabaseRunLedger(),
      sessionManager: createSessionManager({
        bus: createBus(),
        messageCleaner: {
          removeMessages(sessionId: string) {
            return messageStore.deleteBySession(sessionId);
          },
        },
        projectResolver: PROJECT_RESOLVER,
        store: createDatabaseSessionStore(),
      }),
    });

    const client = createInProcessUiBackendClient({
      stateStore: restoredStore,
    });

    await expect(client.getSnapshot()).resolves.toMatchObject({
      activeSessionId: "session_1",
      runs: [
        {
          id: "run_1",
          sessionId: "session_1",
          status: { kind: "idle" },
        },
      ],
      sessions: [
        {
          id: "session_1",
          messages: [
            {
              id: "message_1",
              parts: [{ text: "Inspect database state", type: "text" }],
              role: "user",
            },
            {
              id: "message_2",
              parts: [
                {
                  call: {
                    id: "call_read",
                    input: { path: "README.md" },
                    name: "read",
                    status: "completed",
                  },
                  type: "tool-call",
                },
                {
                  result: {
                    callId: "call_read",
                    output: "file contents",
                  },
                  type: "tool-result",
                },
                { text: "Done", type: "text" },
              ],
              role: "assistant",
            },
          ],
          title: "Recovered session",
        },
      ],
      status: { kind: "idle" },
    });
  });

  it("restores cancelled runs as idle instead of errors", async () => {
    const messageStore = createDatabaseMessageStore();
    const sessionManager = createSessionManager({
      bus: createBus(),
      messageCleaner: {
        removeMessages(sessionId: string) {
          return messageStore.deleteBySession(sessionId);
        },
      },
      projectResolver: PROJECT_RESOLVER,
      store: createDatabaseSessionStore(),
    });
    const runLedger = createDatabaseRunLedger({ now: createClock(10_000) });
    const appState = createDatabaseUiAppStateStore({ now: () => 20_000 });
    const session = await sessionManager.create("D:/repo", {
      title: "Cancelled session",
    });
    await runLedger.createPending({
      runId: "run_cancelled",
      sessionId: session.id,
      triggerSource: "user",
    });
    await runLedger.markRunning("run_cancelled");
    await runLedger.markCancelled("run_cancelled", "run aborted");
    await appState.setActiveSessionId(session.id);

    const store = createPersistentUiStateStore({
      appState,
      messageManager: createMessageManager({
        bus: createBus(),
        store: createDatabaseMessageStore(),
      }),
      runLedger,
      sessionManager,
    });

    await expect(store.readSnapshot()).resolves.toMatchObject({
      runs: [
        {
          id: "run_cancelled",
          status: { kind: "idle" },
        },
      ],
      status: { kind: "idle" },
    });
  });

  it("derives a display title for persisted placeholder sessions from the first user message", async () => {
    const messageManager = createMessageManager({
      bus: createBus(),
      store: createDatabaseMessageStore(),
      idGenerator: createDeterministicMessageIds(),
      now: createClock(2_000),
    });
    const sessionManager = createSessionManager({
      bus: createBus(),
      createSessionId: () => "session_1",
      messageCleaner: {
        removeMessages(sessionId: string) {
          return messageManager.removeMessages(sessionId);
        },
      },
      now: createClock(1_000),
      projectResolver: PROJECT_RESOLVER,
      store: createDatabaseSessionStore(),
    });
    const session = await sessionManager.create("D:/repo", {
      title: "New session",
    });
    const user = await messageManager.createMessage({
      agent: "default",
      role: "user",
      sessionId: session.id,
    });
    await messageManager.appendPart(user.id, {
      text: "请修复 sessions 标题 OPENAI_API_KEY=sk-secret-value",
      type: "text",
    });
    const store = createPersistentUiStateStore({
      appState: createDatabaseUiAppStateStore(),
      messageManager,
      runLedger: createDatabaseRunLedger(),
      sessionManager,
    });

    await expect(store.readSnapshot()).resolves.toMatchObject({
      sessions: [
        {
          id: "session_1",
          title: "请修复 sessions 标题 OPENAI_API_KEY=[redacted]",
        },
      ],
    });
  });

  it("projects active context summaries as compact boundaries without leaking summary text", async () => {
    const messageManager = createMessageManager({
      bus: createBus(),
      store: createDatabaseMessageStore(),
      idGenerator: createDeterministicMessageIds(),
      now: createClock(2_000),
    });
    const sessionManager = createSessionManager({
      bus: createBus(),
      createSessionId: () => "session_1",
      messageCleaner: {
        removeMessages(sessionId: string) {
          return messageManager.removeMessages(sessionId);
        },
      },
      now: createClock(1_000),
      projectResolver: PROJECT_RESOLVER,
      store: createDatabaseSessionStore(),
    });
    const session = await sessionManager.create("D:/repo", {
      title: "Compacted session",
    });
    const summary = await messageManager.createMessage({
      agent: SUMMARY_AGENT_NAME,
      role: "assistant",
      sessionId: session.id,
    });
    await messageManager.appendPart(summary.id, {
      metadata: { kind: "context-summary" },
      synthetic: true,
      text: "Goal\n- raw summary text that belongs only in model context",
      type: "text",
    });
    const appState = createDatabaseUiAppStateStore();
    await appState.setActiveSessionId(session.id);
    const store = createPersistentUiStateStore({
      appState,
      messageManager,
      runLedger: createDatabaseRunLedger(),
      sessionManager,
    });

    const snapshot = await store.readSnapshot();
    const messages = snapshot.sessions[0]?.messages ?? [];

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("assistant");
    expect(messages[0]?.parts).toEqual([
      { text: "Context compacted", type: "text" },
    ]);
    expect(JSON.stringify(messages)).not.toContain("raw summary text");
  });

  it("omits compacted message parts from persistent UI snapshots", async () => {
    const messageManager = createMessageManager({
      bus: createBus(),
      store: createDatabaseMessageStore(),
      idGenerator: createDeterministicMessageIds(),
      now: createClock(2_000),
    });
    const sessionManager = createSessionManager({
      bus: createBus(),
      createSessionId: () => "session_1",
      messageCleaner: {
        removeMessages(sessionId: string) {
          return messageManager.removeMessages(sessionId);
        },
      },
      now: createClock(1_000),
      projectResolver: PROJECT_RESOLVER,
      store: createDatabaseSessionStore(),
    });
    const session = await sessionManager.create("D:/repo", {
      title: "Compacted history",
    });
    const compactedUser = await messageManager.createMessage({
      agent: "default",
      role: "user",
      sessionId: session.id,
    });
    const compactedPart = await messageManager.appendPart(compactedUser.id, {
      text: "already compacted prompt",
      type: "text",
    });
    await messageManager.updatePart(compactedPart.id, {
      time: { compacted: 5_000 },
    });
    const activeUser = await messageManager.createMessage({
      agent: "default",
      role: "user",
      sessionId: session.id,
    });
    await messageManager.appendPart(activeUser.id, {
      text: "still visible prompt",
      type: "text",
    });
    const appState = createDatabaseUiAppStateStore();
    await appState.setActiveSessionId(session.id);
    const store = createPersistentUiStateStore({
      appState,
      messageManager,
      runLedger: createDatabaseRunLedger(),
      sessionManager,
    });

    const snapshot = await store.readSnapshot();
    const messages = snapshot.sessions[0]?.messages ?? [];

    expect(messages).toHaveLength(1);
    expect(messages[0]?.parts).toEqual([
      { text: "still visible prompt", type: "text" },
    ]);
    expect(JSON.stringify(messages)).not.toContain("already compacted prompt");
  });

  it("persists active session id in app_state", async () => {
    const appState = createDatabaseUiAppStateStore({ now: () => 1_000 });

    await appState.setActiveSessionId("session_persisted");
    const recreatedAppState = createDatabaseUiAppStateStore();

    await expect(recreatedAppState.getActiveSessionId()).resolves.toBe(
      "session_persisted",
    );
    expect(
      getDatabase()
        .prepare<{
          name: string;
        }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(schema.appState.tableName),
    ).toEqual({ name: schema.appState.tableName });
  });

  it("scopes active session id in app_state", async () => {
    const projectA = createDatabaseUiAppStateStore({
      now: () => 1_000,
      scope: "project_a",
    });
    const projectB = createDatabaseUiAppStateStore({
      now: () => 2_000,
      scope: "project_b",
    });

    await projectA.setActiveSessionId("session_a");

    await expect(projectA.getActiveSessionId()).resolves.toBe("session_a");
    await expect(projectB.getActiveSessionId()).resolves.toBeNull();
  });

  it("includes the active session even when it falls outside the recent session limit", async () => {
    let nextSession = 1;
    const messageManager = createMessageManager({
      bus: createBus(),
      store: createDatabaseMessageStore(),
    });
    const sessionManager = createSessionManager({
      bus: createBus(),
      createSessionId: () => {
        const id = `session_${String(nextSession)}`;
        nextSession += 1;
        return id;
      },
      messageCleaner: {
        removeMessages(sessionId: string) {
          return messageManager.removeMessages(sessionId);
        },
      },
      now: createClock(1_000),
      projectResolver: PROJECT_RESOLVER,
      store: createDatabaseSessionStore(),
    });
    const older = await sessionManager.create("D:/repo", {
      title: "Older active",
    });
    await sessionManager.create("D:/repo", {
      title: "Newer recent",
    });
    const appState = createDatabaseUiAppStateStore();
    await appState.setActiveSessionId(older.id);
    const store = createPersistentUiStateStore({
      appState,
      messageManager,
      runLedger: createDatabaseRunLedger(),
      sessionLimit: 1,
      sessionManager,
    });

    await expect(store.readSnapshot()).resolves.toMatchObject({
      activeSessionId: "session_1",
      sessions: [
        { id: "session_2", title: "Newer recent" },
        { id: "session_1", title: "Older active" },
      ],
    });
  });

  it("converts stored tool error JSON into a user-facing SDK tool result error", async () => {
    const messageManager = createMessageManager({
      bus: createBus(),
      store: createDatabaseMessageStore(),
      idGenerator: createDeterministicMessageIds(),
      now: createClock(2_000),
    });
    const sessionManager = createSessionManager({
      bus: createBus(),
      createSessionId: () => "session_1",
      messageCleaner: {
        removeMessages(sessionId: string) {
          return messageManager.removeMessages(sessionId);
        },
      },
      now: createClock(1_000),
      projectResolver: PROJECT_RESOLVER,
      store: createDatabaseSessionStore(),
    });
    const session = await sessionManager.create("D:/repo", {
      title: "Tool error",
    });
    const assistant = await messageManager.createMessage({
      agent: "default",
      role: "assistant",
      sessionId: session.id,
    });
    await messageManager.appendPart(assistant.id, {
      callId: "call_failed",
      state: {
        error:
          '{"status":"error","error":{"type":"ExecutionError","message":"Tool scheduler failed: batch exploded"}}',
        input: { path: "README.md" },
        status: "error",
      },
      tool: "read",
      type: "tool",
    });
    const store = createPersistentUiStateStore({
      appState: createDatabaseUiAppStateStore(),
      messageManager,
      runLedger: createDatabaseRunLedger(),
      sessionManager,
    });

    await expect(store.readSnapshot()).resolves.toMatchObject({
      sessions: [
        {
          messages: [
            {
              parts: [
                {
                  call: { status: "failed" },
                  type: "tool-call",
                },
                {
                  result: {
                    callId: "call_failed",
                    error: "Tool scheduler failed: batch exploded",
                  },
                  type: "tool-result",
                },
              ],
            },
          ],
        },
      ],
    });
  });
});

function createClock(startAt: number): () => number {
  let current = startAt;
  return () => {
    const value = current;
    current += 1_000;
    return value;
  };
}

function createDeterministicMessageIds(): {
  readonly messageId: () => string;
  readonly partId: () => string;
} {
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
