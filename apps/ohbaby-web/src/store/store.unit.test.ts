import { describe, expect, it, vi } from "vitest";
import type {
  UiSessionView,
  UiMessage,
  UiRun,
  SessionSyncState,
} from "ohbaby-sdk";
import { projectRunProcesses } from "../ui/conversation/run-process.js";
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
      runs: [],
      version: view().version,
      messages: [message("1")],
      prompts: [prompt],
      hasMore: false,
      reasoningMissing: false,
    });
    store.setSessionSync(ready(view(1)));
    expect(store.getSnapshot().view.snapshot?.prompts).toEqual([prompt]);
  });
  it("keeps the runs of older history pages behind the live view's copies (turn-projection T13)", () => {
    const store = createOhbabyWebStore();
    const live = {
      id: "live",
      sessionId: "s",
      status: { kind: "idle" as const },
      startedAt: "2026-01-01T00:02:00Z",
      updatedAt: "2026-01-01T00:02:00Z",
      outcome: "succeeded" as const,
    };
    store.setSessionSync(ready({ ...view(), runs: [live] }));
    const old = { ...live, id: "old", startedAt: "2026-01-01T00:00:00Z" };
    store.installSessionHistory({
      runs: [old, { ...live, outcome: "failed" as const }],
      version: view().version,
      messages: [{ ...message("1"), runId: "old" }],
      prompts: [],
      hasMore: false,
      reasoningMissing: false,
    });
    store.setSessionSync(ready({ ...view(1), runs: [live] }));
    expect(store.getSnapshot().view.snapshot?.runs).toEqual([{ ...live }, old]);
  });
  describe("turns of messages that left the live window (copy improve-2)", () => {
    const at = (minute: number): string =>
      `2026-01-01T00:${String(minute).padStart(2, "0")}:00Z`;
    const endedRun = (id: string, trigger: "user" | "subagent") => ({
      id,
      sessionId: "s",
      trigger,
      status: { kind: "idle" as const },
      outcome: "succeeded" as const,
      startedAt: at(1),
      endedAt: at(2),
      updatedAt: at(2),
    });
    const runningRun = (id: string): UiRun => ({
      id,
      sessionId: "s",
      trigger: "user",
      status: { kind: "running", runId: id },
      startedAt: at(1),
      updatedAt: at(1),
    });
    const said = (
      id: string,
      role: "user" | "assistant",
      runId?: string,
    ): UiMessage => ({
      id,
      role,
      createdAt: at(Number(id)),
      parts: [{ type: "text", text: `text ${id}` }],
      ...(runId ? { runId } : {}),
      ...(role === "assistant" ? { status: "completed" as const } : {}),
    });
    const liveView = (
      revision: number,
      messages: UiMessage[],
      runs: UiSessionView["runs"],
      prompts: UiSessionView["prompts"] = [],
    ): UiSessionView => ({
      ...view(revision),
      session: { ...view(revision).session, messages },
      runs,
      prompts,
    });
    const turns = (store: ReturnType<typeof createOhbabyWebStore>) => {
      const snapshot = store.getSnapshot().view.snapshot;
      const messages = snapshot?.sessions[0]?.messages ?? [];
      return projectRunProcesses(
        messages,
        snapshot?.prompts ?? [],
        "s",
        {},
        snapshot?.runs ?? [],
      ).map(({ runId, trigger, answerId }) => ({ runId, trigger, answerId }));
    };
    const next = said("9", "user");

    it("keeps a subagent turn's run once its answer leaves the window (T1)", () => {
      const store = createOhbabyWebStore();
      const run = endedRun("R", "subagent");
      store.setSessionSync(
        ready(liveView(0, [said("3", "assistant", "R")], [run])),
      );
      store.setSessionSync(ready(liveView(1, [next], [])));
      expect(store.getSnapshot().view.snapshot?.runs).toEqual([run]);
      expect(turns(store)).toEqual([
        { runId: "R", trigger: "subagent", answerId: "3" },
      ]);
    });

    it("keeps a user turn's run and prompt once they leave the window (T2)", () => {
      const store = createOhbabyWebStore();
      const run = endedRun("R", "user");
      const prompt = {
        promptId: "P",
        clientRequestId: "c",
        scopeKey: "k",
        sessionId: "s",
        userMessageId: "3",
        text: "text 3",
        status: "succeeded" as const,
        runId: "R",
        createdAt: at(1),
        updatedAt: at(2),
        endedAt: at(2),
      };
      store.setSessionSync(
        ready(
          liveView(
            0,
            [said("3", "user"), said("4", "assistant", "R")],
            [run],
            [prompt],
          ),
        ),
      );
      store.setSessionSync(ready(liveView(1, [next], [])));
      const snapshot = store.getSnapshot().view.snapshot;
      expect(snapshot?.runs).toEqual([run]);
      expect(snapshot?.prompts).toEqual([prompt]);
      expect(turns(store)).toEqual([
        { runId: "R", trigger: "user", answerId: "4" },
      ]);
    });

    it("drops remembered turns once no shown message belongs to them (T3)", () => {
      const store = createOhbabyWebStore();
      const prompt = {
        promptId: "P",
        clientRequestId: "c",
        scopeKey: "k",
        sessionId: "s",
        userMessageId: "3",
        text: "text 3",
        status: "succeeded" as const,
        runId: "R",
        createdAt: at(1),
        updatedAt: at(2),
        endedAt: at(2),
      };
      const live = runningRun("L");
      store.setSessionSync(
        ready(
          liveView(
            0,
            [said("3", "user"), said("4", "assistant", "R")],
            [endedRun("R", "user")],
            [prompt],
          ),
        ),
      );
      store.setSessionSync(ready(liveView(1, [next], [live])));
      store.invalidateSessionHistory({
        type: "session.changed",
        version: { ...view().version, sessionRevision: 2 },
        removedMessageIds: ["3", "4"],
      });
      store.setSessionSync(ready(liveView(2, [next], [live])));
      const snapshot = store.getSnapshot().view.snapshot;
      expect(snapshot?.runs).toEqual([live]);
      expect(snapshot?.prompts).toEqual([]);
      expect(turns(store)).toEqual([]);
    });

    it("never keeps a running copy, from the live view or a page (T4)", () => {
      const store = createOhbabyWebStore();
      const running = runningRun("R");
      const answer = said("3", "assistant", "R");
      store.setSessionSync(ready(liveView(0, [answer], [running])));
      expect(store.getSnapshot().view.snapshot?.status).toEqual(running.status);
      store.setSessionSync(ready(liveView(1, [next], [])));
      expect(store.getSnapshot().view.snapshot?.runs).toEqual([]);
      expect(store.getSnapshot().view.snapshot?.status).toEqual({
        kind: "idle",
      });

      const ended = endedRun("R", "user");
      store.setSessionSync(ready(liveView(2, [answer], [ended])));
      store.setSessionSync(ready(liveView(3, [next], [])));
      store.installSessionHistory({
        runs: [running],
        version: { ...view().version, sessionRevision: 3 },
        messages: [answer],
        prompts: [],
        hasMore: false,
        reasoningMissing: false,
      });
      expect(store.getSnapshot().view.snapshot?.runs).toEqual([ended]);
    });
  });
  it("keeps loaded pages across deltas and reconnect, rejects stale page overwrites", () => {
    const store = createOhbabyWebStore();
    store.setSessionSync(ready(view()));
    store.installSessionHistory({
      runs: [],
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
      runs: [],
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
      runs: [],
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
      runs: [],
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
      runs: [],
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
      runs: [],
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
      runs: [],
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
      runs: [],
      version: view().version,
      messages: [message("1", "old")],
      prompts: [],
      hasMore: false,
      reasoningMissing: false,
    });
    store.setSessionSync(ready(view(2)));
    store.installSessionHistory({
      runs: [],
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
      runs: [],
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
    runs: [],
    version: cached.version,
    messages: [],
    prompts: [],
    hasMore: false,
    reasoningMissing: false,
  });
  expect(store.getSnapshot().durationSample).toBe(received);
});

describe("command invocation presentation", () => {
  const invocation = {
    clientInvocationId: "i",
    commandId: "help",
    path: ["help"],
    raw: "/help",
    rawArgs: "",
    argv: [],
    surface: "tui",
    sessionId: "s",
  };
  const result = (
    text: string,
  ): Extract<
    import("ohbaby-sdk").UiEvent,
    { type: "command.result.delivered" }
  > => ({
    type: "command.result.delivered" as const,
    commandRunId: "r",
    clientInvocationId: "i",
    timestamp: 1,
    output: { kind: "text" as const, text },
  });
  it("bounds unresolved commands and releases capacity on completion, timeout and scope change", () => {
    vi.useFakeTimers();
    try {
      const store = createOhbabyWebStore();
      store.setSessionSync(ready(view()));
      for (let i = 0; i < 128; i += 1)
        store.beginCommand({ ...invocation, clientInvocationId: String(i) });
      expect(store.getSnapshot().view.commandNotices).toHaveLength(64);
      expect(() => {
        store.beginCommand(invocation);
      }).toThrow("Too many pending commands");
      store.completeCommand({
        status: "completed",
        commandRunId: "r",
        clientInvocationId: "0",
        outputCount: 0,
        eventCount: 0,
      });
      expect(() => {
        store.beginCommand(invocation);
      }).not.toThrow();
      vi.advanceTimersByTime(60_000);
      expect(
        store
          .getSnapshot()
          .view.commandNotices.every((notice) => notice.kind === "error"),
      ).toBe(true);
      expect(() => {
        store.beginCommand(invocation);
      }).not.toThrow();
      store.setSessionSync({ status: "idle", scope: null, attempts: 0 });
      expect(store.getSnapshot().view.commandNotices).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("retains action correlation after outputs until the final result event", () => {
    const store = createOhbabyWebStore();
    store.setSessionSync(ready(view()));
    store.beginCommand({ ...invocation, commandId: "resume" });
    store.applyEvent(result("selected session"), 1);
    store.consumeCommand("i");
    store.completeCommand({
      status: "completed",
      commandRunId: "r",
      clientInvocationId: "i",
      outputCount: 1,
      eventCount: 2,
    });
    store.applyEvent(
      {
        ...result(""),
        output: undefined,
        action: { kind: "session.selected", data: { choiceId: "target" } },
      },
      2,
    );
    expect(store.getSnapshot().view.snapshot?.activeSessionId).toBe("target");
    expect(store.getSnapshot().view.commandNotices).toEqual([]);
  });
  it("keeps accurate errors when receipt/output delivery times out and releases old runtime associations", () => {
    vi.useFakeTimers();
    try {
      const store = createOhbabyWebStore();
      store.setSessionSync(ready(view()));
      store.beginCommand(invocation);
      store.applyEvent(
        {
          ...result(""),
          type: "command.failed",
          error: { code: "ACTUAL", message: "actual error" },
        },
        1,
      );
      store.completeCommand({
        status: "failed",
        commandRunId: "r",
        clientInvocationId: "i",
        outputCount: 1,
        eventCount: 2,
        error: { code: "ACTUAL", message: "actual error" },
      });
      vi.advanceTimersByTime(60_000);
      expect(store.getSnapshot().view.commandNotices[0]?.text).toBe(
        "actual error",
      );
      store.reset();
      store.setSessionSync(ready(view()));
      store.beginCommand(invocation);
      store.applyEvent(result("new runtime"), 1);
      expect(store.getSnapshot().view.commandNotices[0]?.outputs).toEqual([
        result("new runtime").output,
      ]);
      store.clearCommands();
    } finally {
      vi.useRealTimers();
    }
  });
  it("associates missing started, preserves every output and ignores pure action presentation", () => {
    const store = createOhbabyWebStore();
    store.setSessionSync(ready(view()));
    store.beginCommand(invocation);
    store.completeCommand({
      status: "completed",
      commandRunId: "r",
      clientInvocationId: "i",
      sessionId: "s",
      outputCount: 2,
      eventCount: 3,
    });
    store.applyEvent(result("first"), 1);
    store.applyEvent(
      { ...result("ignored"), output: undefined, action: { kind: "noop" } },
      2,
    );
    store.applyEvent(result("second"), 3);
    expect(store.getSnapshot().view.commandNotices[0]?.outputs).toEqual([
      result("first").output,
      result("second").output,
    ]);
    store.consumeCommand("i");
    store.applyEvent(result("replayed"), 4);
    store.setSessionSync(ready(view(2)));
    expect(store.getSnapshot().view.commandNotices).toEqual([]);
  });
  it("consumes pending results and discards late events after a session switch", () => {
    const store = createOhbabyWebStore();
    store.setSessionSync(ready(view()));
    store.beginCommand(invocation);
    store.consumeCommand("i");
    store.applyEvent(result("late"), 1);
    expect(store.getSnapshot().view.commandNotices).toEqual([]);
    store.setSessionSync({
      ...ready(view()),
      scope: { sessionId: "b", runtimeEpoch: "e" },
    });
    store.applyEvent(result("wrong session"), 2);
    store.setSessionSync(ready(view()));
    expect(store.getSnapshot().view.commandNotices).toEqual([]);
  });
  it("shows no skill or overlay cards and bounds missing completion as unknown", () => {
    vi.useFakeTimers();
    try {
      const store = createOhbabyWebStore();
      store.setSessionSync(ready(view()));
      store.beginCommand({ ...invocation, commandId: "skill.demo" });
      expect(store.getSnapshot().view.commandNotices).toEqual([]);
      vi.advanceTimersByTime(60_000);
      expect(store.getSnapshot().view.commandNotices[0]?.kind).toBe("error");
      expect(store.getSnapshot().view.commandNotices[0]?.text).toContain(
        "unconfirmed",
      );
      store.consumeCommand("i");
      store.beginCommand({ ...invocation, commandId: "goal" }, true);
      store.applyEvent(
        {
          ...result(""),
          type: "command.failed",
          error: { code: "FAILED", message: "actual failure" },
        },
        1,
      );
      store.completeCommand({
        status: "failed",
        commandRunId: "r",
        clientInvocationId: "i",
        outputCount: 0,
        eventCount: 1,
        error: { code: "FAILED", message: "actual failure" },
      });
      expect(store.getSnapshot().view.commandNotices).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
