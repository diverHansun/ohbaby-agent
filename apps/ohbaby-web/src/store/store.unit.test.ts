import { describe, expect, it, vi } from "vitest";
import type { UiSessionView, UiMessage, SessionSyncState } from "ohbaby-sdk";
import { createOhbabyWebStore } from "./store.js";
const message = (id: string, text = id): UiMessage => ({
  id,
  role: "assistant" as const,
  createdAt: id,
  parts: [{ type: "text" as const, text }],
});
function view(revision = 0): UiSessionView {
  return {
    version: {
      runtimeEpoch: "e",
      sessionId: "s",
      viewGeneration: "g",
      sessionRevision: revision,
    },
    session: {
      id: "s",
      title: "session",
      createdAt: "0",
      updatedAt: "0",
      messages: [message("2", `live${String(revision)}`)],
    },
    runs: [],
    prompts: [],
    history: { before: "cursor", hasMore: true },
    reasoningMissing: false,
    todo: { status: "ready", value: null },
    goal: { status: "ready", value: null },
    context: { status: "ready", value: null },
  };
}
const ready = (v: UiSessionView): SessionSyncState => ({
  status: "ready" as const,
  scope: { sessionId: "s", runtimeEpoch: "e" },
  view: v,
  attempts: 1,
});
describe("session view store", () => {
  it("retains terminal prompt duration associations from older history pages", () => {
    const store = createOhbabyWebStore();
    store.setSessionSync(ready(view()));
    const prompt = {
      promptId: "p",
      clientRequestId: "c",
      scopeKey: "k",
      sessionId: "s",
      userMessageId: "1",
      text: "hello",
      status: "succeeded" as const,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:01:00Z",
      endedAt: "2026-01-01T00:01:00Z",
    };
    store.installSessionHistory({
      version: view().version,
      messages: [message("1")],
      prompts: [prompt],
      hasMore: false,
      reasoningMissing: false,
    });
    store.setSessionSync(ready(view(1)));
    expect(store.getSnapshot().view.snapshot?.prompts).toEqual([prompt]);
  });
  it("keeps loaded pages across deltas and reconnect, rejects stale page overwrites", () => {
    const store = createOhbabyWebStore();
    store.setSessionSync(ready(view()));
    store.installSessionHistory({
      version: view().version,
      messages: [message("1"), message("2", "stale")],
      prompts: [],
      hasMore: false,
      reasoningMissing: false,
    });
    store.setSessionSync(ready(view(2)));
    expect(
      store
        .getSnapshot()
        .view.snapshot?.sessions[0]?.messages.map((m) => m.parts),
    ).toEqual([message("1").parts, message("2", "live2").parts]);
    expect(store.getSnapshot().historyHasMore).toBe(false);
    store.installSessionHistory({
      version: { ...view().version, viewGeneration: "wrong" },
      messages: [message("0")],
      prompts: [],
      hasMore: false,
      reasoningMissing: false,
    });
    expect(
      store.getSnapshot().view.snapshot?.sessions[0]?.messages,
    ).toHaveLength(2);
  });
  it("marks history stale on invalidation while preserving readable content and approvals", () => {
    const store = createOhbabyWebStore();
    store.setSessionSync(ready(view()));
    store.installSessionHistory({
      version: view().version,
      messages: [message("1")],
      prompts: [],
      hasMore: false,
      reasoningMissing: false,
    });
    const permissions = store.getSnapshot().permissionSync;
    store.invalidateSessionHistory({
      type: "session.changed",
      version: { ...view().version, sessionRevision: 1 },
      historyInvalidated: true,
    });
    expect(store.getSnapshot().historyStale).toBe(true);
    expect(
      store.getSnapshot().view.snapshot?.sessions[0]?.messages,
    ).toHaveLength(2);
    expect(store.getSnapshot().permissionSync).toBe(permissions);
  });
  it("rejects legacy replacement and isolates throwing listeners", () => {
    const store = createOhbabyWebStore();
    const observed = vi.fn();
    const diagnostic = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    store.subscribe(() => {
      throw new Error("observer");
    });
    store.subscribe(observed);
    try {
      store.setSessionSync(ready(view()));
      expect(observed).toHaveBeenCalledOnce();
      const snapshot = store.getSnapshot().view.snapshot;
      if (!snapshot) throw new Error("Missing snapshot");
      expect(
        store.applyEvent(
          { type: "snapshot.replaced", snapshot },
          99,
          "snapshot-barrier",
        ),
      ).toBe(false);
    } finally {
      diagnostic.mockRestore();
    }
  });
  it("does not revive a deleted message from a late history page", () => {
    const store = createOhbabyWebStore();
    store.setSessionSync(ready(view()));
    store.installSessionHistory({
      version: view().version,
      messages: [message("1")],
      prompts: [],
      hasMore: false,
      reasoningMissing: false,
    });
    store.invalidateSessionHistory({
      type: "session.changed",
      version: view(1).version,
      removedMessageIds: ["1"],
    });
    store.setSessionSync(ready(view(1)));
    store.installSessionHistory({
      version: view().version,
      messages: [message("1", "old deleted")],
      prompts: [],
      hasMore: false,
      reasoningMissing: false,
    });
    expect(
      store.getSnapshot().view.snapshot?.sessions[0]?.messages.map((m) => m.id),
    ).toEqual(["2"]);
  });
  it("preserves a newer live entity outside the hot window during stale-page replacement", () => {
    const store = createOhbabyWebStore();
    store.setSessionSync(ready(view()));
    store.installSessionHistory({
      version: view().version,
      messages: [message("1")],
      prompts: [],
      hasMore: false,
      reasoningMissing: false,
    });
    store.invalidateSessionHistory({
      type: "session.changed",
      version: view(1).version,
      historyInvalidated: true,
    });
    store.setSessionSync(
      ready({
        ...view(2),
        session: { ...view().session, messages: [message("1", "new live")] },
      }),
    );
    store.setSessionSync(ready(view(3)));
    store.installSessionHistory({
      version: view(1).version,
      messages: [message("1", "old page")],
      prompts: [],
      hasMore: false,
      reasoningMissing: false,
    });
    expect(
      store
        .getSnapshot()
        .view.snapshot?.sessions[0]?.messages.find((m) => m.id === "1")?.parts,
    ).toEqual(message("1", "new live").parts);
  });
  it("replaces older cached entities with newer history and rejects pages ahead of the installed version", () => {
    const store = createOhbabyWebStore();
    store.setSessionSync(ready(view()));
    store.installSessionHistory({
      version: view().version,
      messages: [message("1", "old")],
      prompts: [],
      hasMore: false,
      reasoningMissing: false,
    });
    store.setSessionSync(ready(view(2)));
    store.installSessionHistory({
      version: view(1).version,
      messages: [message("1", "updated")],
      prompts: [],
      hasMore: false,
      reasoningMissing: false,
    });
    expect(
      store.getSnapshot().view.snapshot?.sessions[0]?.messages[0]?.parts,
    ).toEqual(message("1", "updated").parts);
    store.installSessionHistory({
      version: view(9).version,
      messages: [message("0", "future")],
      prompts: [],
      hasMore: false,
      reasoningMissing: false,
    });
    expect(
      store
        .getSnapshot()
        .view.snapshot?.sessions[0]?.messages.some((m) => m.id === "0"),
    ).toBe(false);
  });
});

it("anchors live source timestamps on receipt and keeps that anchor through unrelated updates", () => {
  let now = 10;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  try {
    const store = createOhbabyWebStore();
    store.replaceSnapshot(
      {
        serverNow: 1000,
        activeSessionId: "s",
        sessions: [],
        runs: [],
        permissions: [],
        status: { kind: "idle" },
      },
      1,
    );
    now = 100;
    store.applyEvent(
      { type: "runtime.updated", status: { kind: "idle" }, timestamp: 2000 },
      2,
    );
    expect(store.getSnapshot().durationSample).toEqual({
      serverNow: 2000,
      receivedAt: 100,
    });
    now = 5000;
    store.setError("unrelated");
    expect(store.getSnapshot().durationSample).toEqual({
      serverNow: 2000,
      receivedAt: 100,
    });
  } finally {
    clock.mockRestore();
  }
});

it("does not rewind the receipt anchor when loading history against a cached view", () => {
  const store = createOhbabyWebStore();
  const cached = { ...view(), serverNow: 1000 };
  store.setSessionSync(ready(cached));
  store.applyEvent(
    { type: "runtime.updated", status: { kind: "idle" }, timestamp: 3000 },
    1,
  );
  const received = store.getSnapshot().durationSample;
  store.installSessionHistory({
    version: cached.version,
    messages: [],
    prompts: [],
    hasMore: false,
    reasoningMissing: false,
  });
  expect(store.getSnapshot().durationSample).toBe(received);
});
