import { describe, expect, it } from "vitest";
import type { UiSnapshot } from "ohbaby-sdk";
import { createInMemoryUiStateStore } from "./memory-store.js";

const BASE_SNAPSHOT: UiSnapshot = {
  activeSessionId: null,
  sessions: [],
  runs: [],
  permissions: [],
  status: { kind: "idle" },
};

describe("createInMemoryUiStateStore", () => {
  it("returns cloned snapshots instead of exposing mutable state", async () => {
    const store = createInMemoryUiStateStore(BASE_SNAPSHOT);

    await store.upsertSession({
      id: "session_1",
      title: "Session",
      messages: [],
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
    });

    const snapshot = await store.readSnapshot();
    const mutableSnapshot = snapshot as unknown as {
      sessions: { title: string }[];
    };
    mutableSnapshot.sessions[0].title = "Mutated by caller";

    await expect(store.readSnapshot()).resolves.toMatchObject({
      sessions: [{ id: "session_1", title: "Session" }],
    });
  });

  it("stores session, run, active session, and status through async methods", async () => {
    const store = createInMemoryUiStateStore(BASE_SNAPSHOT);

    await store.upsertSession({
      id: "session_1",
      title: "Session",
      messages: [],
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
    });
    await store.setActiveSessionId("session_1");
    await store.addRun({
      id: "run_1",
      sessionId: "session_1",
      status: { kind: "running", runId: "run_1" },
      startedAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
    });
    await store.setStatus({ kind: "running", runId: "run_1" });

    await expect(store.readSnapshot()).resolves.toMatchObject({
      activeSessionId: "session_1",
      sessions: [{ id: "session_1" }],
      runs: [{ id: "run_1", sessionId: "session_1" }],
      status: { kind: "running", runId: "run_1" },
    });
  });
});
