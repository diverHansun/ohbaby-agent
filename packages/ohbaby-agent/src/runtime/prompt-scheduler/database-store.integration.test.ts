import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../../services/database/index.js";
import { DatabasePromptSubmissionStore } from "./database-store.js";
import { PromptNotQueuedError, PromptQueueFullError } from "./errors.js";

describe("DatabasePromptSubmissionStore", () => {
  let directory: string;
  let now: number;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ohbaby-prompt-store-"));
    now = 100;
    initDatabase({ dbPath: join(directory, "agent.db"), now: () => ++now });
    getDatabase()
      .prepare(
        `INSERT INTO session
          (id, project_id, project_root, title, status, created_at, updated_at, data)
         VALUES (?, ?, ?, ?, 'active', ?, ?, '{}')`,
      )
      .run("session_1", "project_1", "/workspace", "Test", now, now);
  });

  afterEach(async () => {
    closeDatabase();
    await rm(directory, { recursive: true, force: true });
  });

  it("persists edit, cancel, claim and recovery transitions", async () => {
    const store = new DatabasePromptSubmissionStore({
      now: (): number => ++now,
    });
    const first = await store.accept({
      maxQueuedPrompts: 100,
      promptId: "prompt_1",
      scopeKey: "/workspace",
      sessionId: "session_1",
      text: "before",
      userMessageId: "message_1",
    });
    const edited = await store.editQueued(
      first.promptId,
      first.updatedAt,
      "after",
    );
    expect(edited).toMatchObject({ text: "after", status: "queued" });
    const claimed = await store.claim(first.promptId);
    expect(claimed?.status).toBe("starting");
    await expect(
      store.cancelQueued(first.promptId, edited.updatedAt),
    ).rejects.toBeInstanceOf(PromptNotQueuedError);
    await store.markRunning(first.promptId, "run_1");

    expect(await store.recoverInterrupted("/workspace")).toBe(1);
    expect(await store.get(first.promptId)).toMatchObject({
      runId: "run_1",
      status: "interrupted",
      text: "after",
    });
  });

  it("recovers all active submissions once at daemon startup and reports queued scopes", async () => {
    getDatabase()
      .prepare(
        `INSERT INTO session
          (id, project_id, project_root, title, status, created_at, updated_at, data)
         VALUES (?, ?, ?, ?, 'active', ?, ?, '{}')`,
      )
      .run("session_2", "project_2", "/workspace-2", "Test 2", now, now);
    const store = new DatabasePromptSubmissionStore({
      now: (): number => ++now,
    });
    const running = await store.accept({
      maxQueuedPrompts: 100,
      promptId: "prompt_running",
      scopeKey: "/workspace",
      sessionId: "session_1",
      text: "running",
      userMessageId: "message_running",
    });
    await store.claim(running.promptId);
    await store.markRunning(running.promptId, "run_running");
    await store.accept({
      maxQueuedPrompts: 100,
      promptId: "prompt_queued",
      scopeKey: "/workspace-2",
      sessionId: "session_2",
      text: "queued",
      userMessageId: "message_queued",
    });

    const liveStore = new DatabasePromptSubmissionStore({
      isOwnerAlive: (pid): boolean => pid === 42,
      now: (): number => ++now,
      ownerId: "live-owner",
      ownerPid: 42,
    });
    const live = await liveStore.accept({
      maxQueuedPrompts: 100,
      promptId: "prompt_live",
      scopeKey: "/workspace-2",
      sessionId: "session_2",
      text: "live",
      userMessageId: "message_live",
    });
    await liveStore.claim(live.promptId);

    expect(await liveStore.recoverAllInterrupted()).toBe(1);
    expect(await store.get(running.promptId)).toMatchObject({
      status: "interrupted",
    });
    expect(await store.get(live.promptId)).toMatchObject({
      ownerId: "live-owner",
      ownerPid: 42,
      status: "starting",
    });
    await expect(store.listScopesWithQueued()).resolves.toEqual([
      "/workspace-2",
    ]);
  });

  it("enforces the durable queued-record limit inside the acceptance transaction", async () => {
    const store = new DatabasePromptSubmissionStore({
      now: (): number => ++now,
    });
    for (let index = 0; index < 100; index += 1) {
      await store.accept({
        maxQueuedPrompts: 100,
        promptId: `prompt_${String(index)}`,
        scopeKey: "/workspace",
        sessionId: "session_1",
        text: `queued ${String(index)}`,
        userMessageId: `message_${String(index)}`,
      });
    }
    await expect(
      store.accept({
        maxQueuedPrompts: 100,
        promptId: "prompt_overflow",
        scopeKey: "/workspace",
        sessionId: "session_1",
        text: "overflow",
        userMessageId: "message_overflow",
      }),
    ).rejects.toBeInstanceOf(PromptQueueFullError);
  });

  it("terminally fails queued records when their recovered workspace is unavailable", async () => {
    const store = new DatabasePromptSubmissionStore({
      now: (): number => ++now,
    });
    const queued = await store.accept({
      maxQueuedPrompts: 100,
      promptId: "prompt_unavailable",
      scopeKey: "/missing-workspace",
      sessionId: "session_1",
      text: "queued",
      userMessageId: "message_unavailable",
    });
    await expect(
      store.failQueuedScope("/missing-workspace", {
        code: "WORKSPACE_UNAVAILABLE",
        message: "workspace unavailable",
        retryable: true,
        source: "runtime",
      }),
    ).resolves.toBe(1);
    await expect(store.get(queued.promptId)).resolves.toMatchObject({
      error: { code: "WORKSPACE_UNAVAILABLE" },
      status: "failed",
    });
  });
});
