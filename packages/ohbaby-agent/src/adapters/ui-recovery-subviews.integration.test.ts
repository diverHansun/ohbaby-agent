import { describe, expect, it, vi } from "vitest";
import { createBus } from "../bus/index.js";
import {
  createMessageManager,
  createInMemoryMessageStore,
} from "../core/message/index.js";
import { InMemoryGoalPersistence } from "../goals/index.js";
import { createInProcessUiBackendClient } from "./ui-inprocess.js";

describe("recovery subview initialization", () => {
  it("samples server time on every cached session view and snapshot delivery", async () => {
    const backend = createInProcessUiBackendClient();
    try {
      const session = await backend.createSession();
      await backend.initializeSession(session.id);
      const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
      try {
        const first = await backend.getSessionView({ sessionId: session.id });
        clock.mockReturnValue(2000);
        const second = await backend.getSessionView({ sessionId: session.id });
        expect(first.serverNow).toBe(1000);
        expect(second.serverNow).toBe(2000);
        expect(second.version).toEqual(first.version);
        expect((await backend.getSnapshot()).serverNow).toBe(2000);
      } finally {
        clock.mockRestore();
      }
    } finally {
      await backend.dispose();
    }
  });
  it("retains known todo and goal facts after a notification failure without repeating initialization", async () => {
    const bus = createBus();
    const messageManager = createMessageManager({
      bus,
      store: createInMemoryMessageStore(),
    });
    const goals = new InMemoryGoalPersistence();
    const goalReads = vi.spyOn(goals, "list");
    const backend = createInProcessUiBackendClient({
      bus,
      messageManager,
      goalPersistence: goals,
    });
    try {
      const session = await backend.createSession();
      await backend.initializeSession(session.id);
      const baseline = await backend.getSessionView({ sessionId: session.id });
      expect(baseline.todo.status).toBe("ready");
      expect(baseline.goal.status).toBe("ready");
      goalReads.mockClear();
      const unsubscribe = backend.subscribeEvents((event) => {
        if (event.type === "session.changed")
          throw new Error("broken observer");
      });
      await messageManager.createMessage({
        sessionId: session.id,
        role: "assistant",
        agent: "test",
      });
      unsubscribe();
      const rebuilt = await backend.getSessionView({ sessionId: session.id });
      expect(rebuilt.version.viewGeneration).not.toBe(
        baseline.version.viewGeneration,
      );
      expect(rebuilt.todo).toEqual(baseline.todo);
      expect(rebuilt.goal).toEqual(baseline.goal);
      expect(goalReads).not.toHaveBeenCalled();
    } finally {
      await backend.dispose();
    }
  });
  it("keeps todo recovery readable with blocked control and rejected execution after failed goal initialization", async () => {
    const persistence = new InMemoryGoalPersistence();
    vi.spyOn(persistence, "list").mockRejectedValue(
      new Error("goal storage failed"),
    );
    const backend = createInProcessUiBackendClient({
      goalPersistence: persistence,
      initialSnapshot: {
        activeSessionId: "root",
        sessions: [
          {
            id: "root",
            title: "Root",
            createdAt: "2026",
            updatedAt: "2026",
            messages: [],
          },
        ],
        runs: [],
        permissions: [],
        status: { kind: "idle" },
      },
    });
    try {
      await backend.initialize();
      await expect(backend.initializeSession("root")).rejects.toThrow(
        "goal storage failed",
      );
      const view = await backend.getSessionView({ sessionId: "root" });
      expect(view.goal).toEqual({
        status: "unavailable",
        reason: "goal storage failed",
      });
      expect(view.todo.status).toBe("ready");
      await expect(
        backend.getSessionControl({ sessionId: "root" }),
      ).resolves.toMatchObject({
        sessionId: "root",
        rootSessionId: "root",
        runId: null,
        driver: null,
        executionRecovery: {
          status: "blocked",
          message: "goal storage failed",
        },
      });
      await expect(
        backend.submitPromptAccepted("do not execute", {
          sessionId: "root",
          clientRequestId: "blocked-goal",
        }),
      ).rejects.toThrow("goal storage failed");
      expect(
        await backend.getPermissionSnapshot({ rootSessionId: "root" }),
      ).toMatchObject({ rootSessionId: "root", requests: [] });
    } finally {
      await backend.dispose();
    }
  });
});
