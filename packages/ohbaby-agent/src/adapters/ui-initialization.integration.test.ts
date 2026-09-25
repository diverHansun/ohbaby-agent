import { describe, expect, it, vi } from "vitest";
import type { UiSnapshot } from "ohbaby-sdk";
import { createBus } from "../bus/index.js";
import {
  createMessageManager,
  createInMemoryMessageStore,
} from "../core/message/index.js";
import { InMemoryGoalPersistence } from "../goals/index.js";
import { InMemoryPromptSubmissionStore } from "../runtime/prompt-scheduler/index.js";
import { createInProcessUiBackendClient } from "./ui-inprocess.js";

const snapshot: UiSnapshot = {
  activeSessionId: "root",
  sessions: [
    {
      id: "root",
      title: "Root",
      createdAt: "2026-09-25",
      updatedAt: "2026-09-25",
      messages: [],
    },
  ],
  runs: [],
  permissions: [],
  status: { kind: "idle" },
};

describe("backend explicit initialization", () => {
  it("keeps latest unopened in-memory metadata for its eventual explicit seed", async () => {
    const bus = createBus();
    const messages = createMessageManager({
      bus,
      store: createInMemoryMessageStore(),
    });
    const reads = vi.spyOn(messages, "listPageBySession");
    const client = createInProcessUiBackendClient({
      bus,
      messageManager: messages,
      initialSnapshot: {
        ...snapshot,
        activeSessionId: null,
        sessions: snapshot.sessions.map((session) => ({
          ...session,
          reasoning: { effort: "high" },
        })),
      },
    });
    try {
      await client.initialize();
      await client.updateSessionReasoning({
        sessionId: "root",
        reasoning: null,
      });
      expect(reads).not.toHaveBeenCalled();
      await client.initializeSession("root");
      expect(
        (await client.getSessionView({ sessionId: "root" })).session.reasoning,
      ).toBeUndefined();
    } finally {
      await client.dispose();
    }
  });

  it("drains durable queued work despite an unhealthy display before goal initialization completes, without a view query", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const persistence = new InMemoryGoalPersistence();
    const list = persistence.list.bind(persistence);
    const goalRead = vi
      .spyOn(persistence, "list")
      .mockImplementation(async (id) => {
        await gate;
        return list(id);
      });
    const store = new InMemoryPromptSubmissionStore();
    await store.accept({
      scopeKey: "headless",
      sessionId: "root",
      promptId: "queued",
      clientRequestId: "queued-request",
      userMessageId: "queued-message",
      text: "queued",
      maxQueuedPrompts: 100,
    });
    const bus = createBus();
    const messages = createMessageManager({
      bus,
      store: createInMemoryMessageStore(),
    });
    const execute = vi.fn(() => Promise.reject(new Error("runtime reached")));
    const client = createInProcessUiBackendClient({
      initialSnapshot: snapshot,
      goalPersistence: persistence,
      bus,
      messageManager: messages,
      promptScopeKey: "headless",
      promptSubmissionStore: store,
      createLLMClient: execute,
    });
    const events: string[] = [];
    const unsubscribe = client.subscribeEvents((event) => {
      events.push(event.type);
      if (event.type === "session.changed")
        throw new Error("display observer failed");
    });
    try {
      await client.initialize();
      await vi.waitFor(() => {
        expect(goalRead).toHaveBeenCalledOnce();
      });
      await messages.createMessage({
        sessionId: "root",
        role: "assistant",
        agent: "test",
      });
      expect(events).toContain("session.unavailable");
      release();
      await vi.waitFor(async () => {
        expect((await store.get("queued"))?.status).toBe("failed");
      });
      expect(execute).toHaveBeenCalledOnce();
      expect((await store.get("queued"))?.error?.message).toBe(
        "runtime reached",
      );
    } finally {
      release();
      unsubscribe();
      await client.dispose();
    }
  });

  it("allows cancelling a durable queue item while goal recovery remains unavailable", async () => {
    const persistence = new InMemoryGoalPersistence();
    vi.spyOn(persistence, "list").mockRejectedValue(
      new Error("goal unavailable"),
    );
    const store = new InMemoryPromptSubmissionStore();
    await store.accept({
      scopeKey: "cancel-workspace",
      sessionId: "root",
      promptId: "cancel-me",
      clientRequestId: "cancel-request",
      userMessageId: "cancel-message",
      text: "queued",
      maxQueuedPrompts: 100,
    });
    const client = createInProcessUiBackendClient({
      initialSnapshot: snapshot,
      goalPersistence: persistence,
      promptScopeKey: "cancel-workspace",
      promptSubmissionStore: store,
    });
    try {
      await client.initialize();
      await expect(client.initializeSession("root")).rejects.toThrow(
        "goal unavailable",
      );
      expect(
        (await client.cancelQueuedPrompt({ promptId: "cancel-me" })).status,
      ).toBe("cancelled");
      expect((await store.get("cancel-me"))?.status).toBe("cancelled");
      expect(
        (await client.getSessionView({ sessionId: "root" })).prompts.find(
          (prompt) => prompt.promptId === "cancel-me",
        ),
      ).toBeUndefined();
    } finally {
      await client.dispose();
    }
  });

  it("identifies invalid reasoning as a definite pre-admission rejection", async () => {
    const client = createInProcessUiBackendClient({
      initialSnapshot: snapshot,
    });
    try {
      await client.initialize();
      await expect(
        client.submitPromptAccepted("invalid", {
          sessionId: "root",
          clientRequestId: "invalid-reasoning",
          reasoning: { effort: "" },
        }),
      ).rejects.toMatchObject({ code: "PROMPT_SUBMISSION_REJECTED" });
      expect(
        (
          await client.getPromptReceipt({
            clientRequestId: "invalid-reasoning",
          })
        ).receipt,
      ).toBeNull();
    } finally {
      await client.dispose();
    }
  });

  it("recovers a failed goal seed on explicit initialization and keeps concurrent retries shared", async () => {
    const persistence = new InMemoryGoalPersistence();
    const original = persistence.list.bind(persistence);
    const list = vi
      .spyOn(persistence, "list")
      .mockRejectedValue(new Error("temporary goal failure"));
    const client = createInProcessUiBackendClient({
      initialSnapshot: snapshot,
      goalPersistence: persistence,
    });
    try {
      await client.initialize();
      await expect(client.initializeSession("root")).rejects.toThrow(
        "temporary goal failure",
      );
      const before = list.mock.calls.length;
      list.mockImplementation(original);
      await Promise.all([
        client.initializeSession("root"),
        client.initializeSession("root"),
      ]);
      expect(list).toHaveBeenCalledTimes(before + 1);
      expect(
        (await client.getSessionView({ sessionId: "root" })).goal.status,
      ).toBe("ready");
      expect(
        (await client.getSessionControl({ sessionId: "root" })).runId,
      ).toBeNull();
    } finally {
      await client.dispose();
    }
  });

  it("reports an expired exact Stop target instead of successful no-op", async () => {
    const client = createInProcessUiBackendClient({
      initialSnapshot: snapshot,
    });
    try {
      await client.initialize();
      await expect(client.abortRun("already-finished")).rejects.toMatchObject({
        code: "SESSION_SCOPE_CHANGED",
      });
    } finally {
      await client.dispose();
    }
  });

  it("keeps approval selection available while that session initialization is waiting", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const persistence = new InMemoryGoalPersistence();
    const original = persistence.list.bind(persistence);
    vi.spyOn(persistence, "list").mockImplementation(async (sessionId) => {
      await blocked;
      return original(sessionId);
    });
    const client = createInProcessUiBackendClient({
      initialSnapshot: snapshot,
      goalPersistence: persistence,
    });
    try {
      await client.initialize();
      await client.selectSession("root");
      expect(
        await client.getPermissionSnapshot({ rootSessionId: "root" }),
      ).toMatchObject({ rootSessionId: "root", requests: [] });
    } finally {
      release();
      await client.dispose();
    }
  });
  it("normalizes a selected goal without a page and never repeats recovery on reads", async () => {
    const persistence = new InMemoryGoalPersistence();
    await persistence.append("root", {
      actor: "user",
      goalId: "goal",
      objective: "saved",
      type: "create",
    });
    const list = vi.spyOn(persistence, "list");
    const createLLMClient = vi.fn(() =>
      Promise.reject(new Error("Runtime must remain lazy")),
    );
    const client = createInProcessUiBackendClient({
      initialSnapshot: snapshot,
      goalPersistence: persistence,
      createLLMClient,
    });
    try {
      await client.initialize();
      await vi.waitFor(() => {
        expect(list).toHaveBeenCalledTimes(1);
      });
      for (let i = 0; i < 3; i++) {
        expect((await client.getSnapshot()).goals?.[0]?.goal.status).toBe(
          "paused",
        );
        await client.getSessionIndex();
        expect(
          await client.getContextWindowUsage({ sessionId: "root" }),
        ).toBeNull();
      }
      expect(list).toHaveBeenCalledTimes(1);
      expect(createLLMClient).not.toHaveBeenCalled();
    } finally {
      await client.dispose();
    }
  });

  it("starts queued work only after the prestarted startup barrier, without a query", async () => {
    let release!: () => void;
    const startupReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = new InMemoryPromptSubmissionStore();
    await store.accept({
      clientRequestId: "request",
      promptId: "prompt",
      sessionId: "root",
      scopeKey: "workspace",
      text: "queued",
      userMessageId: "message",
      maxQueuedPrompts: 100,
    });
    const createLLMClient = vi.fn(() =>
      Promise.reject(new Error("Expected fixture failure")),
    );
    const client = createInProcessUiBackendClient({
      initialSnapshot: snapshot,
      startupReady,
      promptScopeKey: "workspace",
      promptSubmissionStore: store,
      createLLMClient,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect((await store.get("prompt"))?.status).toBe("queued");
      expect(createLLMClient).not.toHaveBeenCalled();
      release();
      await client.initialize();
      await vi.waitFor(async () => {
        expect((await store.get("prompt"))?.status).toBe("failed");
      });
      expect(createLLMClient).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await client.dispose();
    }
  });
});
