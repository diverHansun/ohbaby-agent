import { describe, expect, it } from "vitest";
import {
  PromptEditLeaseHeldError,
  PromptEditLeaseLostError,
  PromptQueueFullError,
} from "./errors.js";
import { InMemoryPromptSubmissionStore } from "./in-memory-store.js";

describe("InMemoryPromptSubmissionStore", () => {
  it("rejects the 101st queued prompt without changing the queue", async () => {
    let now = 0;
    const store = new InMemoryPromptSubmissionStore({
      now: (): number => ++now,
    });
    for (let index = 0; index < 100; index += 1) {
      await store.accept({
        clientRequestId: `request_${String(index)}`,
        maxQueuedPrompts: 100,
        promptId: `prompt_${String(index)}`,
        scopeKey: "/workspace",
        sessionId: `session_${String(index)}`,
        text: "hello",
        userMessageId: `message_${String(index)}`,
      });
    }
    await expect(
      store.accept({
        clientRequestId: "request_101",
        maxQueuedPrompts: 100,
        promptId: "prompt_101",
        scopeKey: "/workspace",
        sessionId: "session_101",
        text: "overflow",
        userMessageId: "message_101",
      }),
    ).rejects.toBeInstanceOf(PromptQueueFullError);
    expect(await store.listQueued("/workspace")).toHaveLength(100);
  });

  it("marks active records interrupted while preserving queued records", async () => {
    let now = 0;
    const store = new InMemoryPromptSubmissionStore({
      now: (): number => ++now,
    });
    const active = await store.accept({
      clientRequestId: "request_active",
      maxQueuedPrompts: 100,
      promptId: "prompt_active",
      scopeKey: "/workspace",
      sessionId: "session_1",
      text: "active",
      userMessageId: "message_active",
    });
    await store.claim(active.record.promptId);
    await store.markRunning(active.record.promptId, "run_1");
    await store.accept({
      clientRequestId: "request_queued",
      maxQueuedPrompts: 100,
      promptId: "prompt_queued",
      scopeKey: "/workspace",
      sessionId: "session_2",
      text: "queued",
      userMessageId: "message_queued",
    });

    expect(await store.recoverInterrupted("/workspace")).toBe(1);
    expect(await store.get("prompt_active")).toMatchObject({
      status: "interrupted",
    });
    expect(await store.get("prompt_queued")).toMatchObject({
      status: "queued",
    });
  });

  it("deduplicates client requests and enforces edit leases", async () => {
    let now = 1_000;
    const store = new InMemoryPromptSubmissionStore({ now: (): number => now });
    const input = {
      clientRequestId: "request_1",
      maxQueuedPrompts: 100,
      promptId: "prompt_1",
      scopeKey: "/workspace",
      sessionId: "session_1",
      text: "before",
      userMessageId: "message_1",
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
      record: { promptId: "prompt_1" },
    });

    const lease = await store.acquireEditLease("prompt_1", "client_1", 60);
    await expect(store.claim("prompt_1")).resolves.toBeNull();
    await expect(
      store.acquireEditLease("prompt_1", "client_2", 60),
    ).rejects.toBeInstanceOf(PromptEditLeaseHeldError);
    await expect(store.cancelQueued("prompt_1")).rejects.toBeInstanceOf(
      PromptEditLeaseHeldError,
    );
    await expect(
      store.releaseEditLease("prompt_1", "wrong_lease"),
    ).rejects.toBeInstanceOf(PromptEditLeaseLostError);
    const renewed = await store.renewEditLease(
      "prompt_1",
      lease.editLeaseId,
      "client_2",
      60,
    );
    expect(renewed.ownerClientId).toBe("client_2");
    const edited = await store.commitEdit(
      "prompt_1",
      lease.editLeaseId,
      "after",
    );
    expect(edited).toMatchObject({ text: "after", editLeaseId: undefined });

    const expiring = await store.acquireEditLease("prompt_1", "client_1", 60);
    now = expiring.expiresAt;
    await expect(
      store.commitEdit("prompt_1", expiring.editLeaseId, "too late"),
    ).rejects.toBeInstanceOf(PromptEditLeaseLostError);
    await expect(store.claim("prompt_1")).resolves.toMatchObject({
      status: "starting",
    });
  });
});
