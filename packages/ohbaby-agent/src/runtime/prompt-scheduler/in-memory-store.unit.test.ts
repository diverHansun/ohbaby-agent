import { describe, expect, it } from "vitest";
import { PromptQueueFullError } from "./errors.js";
import { InMemoryPromptSubmissionStore } from "./in-memory-store.js";

describe("InMemoryPromptSubmissionStore", () => {
  it("rejects the 101st queued prompt without changing the queue", async () => {
    let now = 0;
    const store = new InMemoryPromptSubmissionStore({
      now: (): number => ++now,
    });
    for (let index = 0; index < 100; index += 1) {
      await store.accept({
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
      maxQueuedPrompts: 100,
      promptId: "prompt_active",
      scopeKey: "/workspace",
      sessionId: "session_1",
      text: "active",
      userMessageId: "message_active",
    });
    await store.claim(active.promptId);
    await store.markRunning(active.promptId, "run_1");
    await store.accept({
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
});
