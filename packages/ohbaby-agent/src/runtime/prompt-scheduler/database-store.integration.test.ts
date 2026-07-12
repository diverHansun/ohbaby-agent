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
import {
  PromptEditLeaseHeldError,
  PromptEditLeaseLostError,
  PromptNotQueuedError,
  PromptQueueFullError,
} from "./errors.js";

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
      clientRequestId: "request_1",
      maxQueuedPrompts: 100,
      promptId: "prompt_1",
      scopeKey: "/workspace",
      sessionId: "session_1",
      text: "before",
      userMessageId: "message_1",
    });
    const lease = await store.acquireEditLease(
      first.record.promptId,
      "client_1",
      60_000,
    );
    const edited = await store.commitEdit(
      first.record.promptId,
      lease.editLeaseId,
      "after",
    );
    expect(edited).toMatchObject({ text: "after", status: "queued" });
    const claimed = await store.claim(first.record.promptId);
    expect(claimed?.status).toBe("starting");
    await expect(
      store.cancelQueued(first.record.promptId),
    ).rejects.toBeInstanceOf(PromptNotQueuedError);
    await store.markRunning(first.record.promptId, "run_1");

    expect(await store.recoverInterrupted("/workspace")).toBe(1);
    expect(await store.get(first.record.promptId)).toMatchObject({
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
      clientRequestId: "request_running",
      maxQueuedPrompts: 100,
      promptId: "prompt_running",
      scopeKey: "/workspace",
      sessionId: "session_1",
      text: "running",
      userMessageId: "message_running",
    });
    await store.claim(running.record.promptId);
    await store.markRunning(running.record.promptId, "run_running");
    await store.accept({
      clientRequestId: "request_queued",
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
      clientRequestId: "request_live",
      maxQueuedPrompts: 100,
      promptId: "prompt_live",
      scopeKey: "/workspace-2",
      sessionId: "session_2",
      text: "live",
      userMessageId: "message_live",
    });
    await liveStore.claim(live.record.promptId);

    expect(await liveStore.recoverAllInterrupted()).toBe(1);
    expect(await store.get(running.record.promptId)).toMatchObject({
      status: "interrupted",
    });
    expect(await store.get(live.record.promptId)).toMatchObject({
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
        clientRequestId: `request_${String(index)}`,
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
        clientRequestId: "request_overflow",
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
      clientRequestId: "request_unavailable",
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
    await expect(store.get(queued.record.promptId)).resolves.toMatchObject({
      error: { code: "WORKSPACE_UNAVAILABLE" },
      status: "failed",
    });
  });

  it("deduplicates requests and persists a renewable edit lease", async () => {
    const store = new DatabasePromptSubmissionStore({ now: (): number => now });
    const input = {
      clientRequestId: "request_idempotent",
      maxQueuedPrompts: 100,
      promptId: "prompt_idempotent",
      scopeKey: "/workspace",
      sessionId: "session_1",
      text: "before",
      userMessageId: "message_idempotent",
    } as const;
    const first = await store.accept(input);
    const duplicate = await store.accept({
      ...input,
      promptId: "prompt_duplicate",
      userMessageId: "message_duplicate",
    });
    expect(first.inserted).toBe(true);
    expect(duplicate).toMatchObject({
      inserted: false,
      record: { promptId: "prompt_idempotent" },
    });

    const lease = await store.acquireEditLease(
      "prompt_idempotent",
      "client_1",
      60,
    );
    await expect(store.claim("prompt_idempotent")).resolves.toBeNull();
    await expect(
      store.acquireEditLease("prompt_idempotent", "client_2", 60),
    ).rejects.toBeInstanceOf(PromptEditLeaseHeldError);
    await expect(
      store.cancelQueued("prompt_idempotent"),
    ).rejects.toBeInstanceOf(PromptEditLeaseHeldError);
    await expect(
      store.releaseEditLease("prompt_idempotent", "wrong_lease"),
    ).rejects.toBeInstanceOf(PromptEditLeaseLostError);
    const renewed = await store.renewEditLease(
      "prompt_idempotent",
      lease.editLeaseId,
      "client_2",
      60,
    );
    expect(renewed.ownerClientId).toBe("client_2");
    const edited = await store.commitEdit(
      "prompt_idempotent",
      lease.editLeaseId,
      "after",
    );
    expect(edited).toMatchObject({ text: "after", editLeaseId: undefined });
    const expiring = await store.acquireEditLease(
      "prompt_idempotent",
      "client_1",
      60,
    );
    now = expiring.expiresAt;
    await expect(
      store.commitEdit("prompt_idempotent", expiring.editLeaseId, "too late"),
    ).rejects.toBeInstanceOf(PromptEditLeaseLostError);
  });
});
