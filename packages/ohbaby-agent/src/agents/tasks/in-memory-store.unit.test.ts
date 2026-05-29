import { describe, expect, it } from "vitest";
import { InMemoryAgentTaskStore } from "./in-memory-store.js";
import type { AgentTaskRecord } from "./types.js";

const baseRecord: AgentTaskRecord = {
  createdAt: 100,
  parentSessionId: "parent",
  pendingInputCount: 0,
  prompt: "Inspect files",
  role: "explore",
  sessionId: "child",
  status: "pending",
  taskId: "task_1",
  updatedAt: 100,
};

describe("InMemoryAgentTaskStore", () => {
  it("creates, reads, updates, and lists task records", async () => {
    const store = new InMemoryAgentTaskStore();

    await expect(store.create(baseRecord)).resolves.toEqual(baseRecord);
    await expect(store.get("task_1")).resolves.toEqual(baseRecord);
    await expect(
      store.update("task_1", {
        output: "done",
        status: "completed",
        updatedAt: 101,
      }),
    ).resolves.toMatchObject({
      output: "done",
      status: "completed",
      updatedAt: 101,
    });
    await expect(store.list()).resolves.toMatchObject([
      expect.objectContaining({ taskId: "task_1" }),
    ]);
  });

  it("rejects updates for unknown tasks", async () => {
    const store = new InMemoryAgentTaskStore();

    await expect(store.update("missing", { status: "failed" })).rejects.toThrow(
      "Agent task not found: missing",
    );
  });
});
