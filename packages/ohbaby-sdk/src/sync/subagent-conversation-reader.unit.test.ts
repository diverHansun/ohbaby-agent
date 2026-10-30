import { describe, expect, it, vi } from "vitest";
import type { UiMessage } from "../contract/snapshot.js";
import type { UiEvent } from "../contract/events.js";
import {
  compareSubagentMessages,
  createSubagentConversationReader,
} from "./subagent-conversation-reader.js";
import type {
  UiSubagentConversationQuery,
  UiSubagentConversationSelection,
  UiSubagentConversationView,
  UiSubagentExecution,
} from "../contract/subagent.js";

function execution(id: string, sequence = 1): UiSubagentExecution {
  return {
    executionId: id,
    subagentId: "child",
    rootSessionId: "root",
    rootRunId: "root-run",
    childRunId: `run-${id}`,
    childUserMessageId: `parent-${id}`,
    delegationSequence: sequence,
    status: "running",
    createdAt: sequence,
    updatedAt: sequence,
    resultStored: false,
    delivery: "none",
  };
}

function message(id: string, text: string, runId = "run-a") {
  return {
    id,
    createdAt: "2026-01-01T00:00:00Z",
    role: "assistant" as const,
    runId,
    parts: [{ id: "part", type: "text" as const, text }],
  };
}

function conversation(
  displayed: readonly UiMessage[] = [message("live", "one")],
  revision = 1,
  hasLater = false,
): UiSubagentConversationView {
  return {
    rootSessionId: "root",
    subagentId: "child",
    view: {
      version: {
        runtimeEpoch: "epoch",
        sessionId: "real-session",
        viewGeneration: "scope-generation",
        sessionRevision: revision,
      },
      session: {
        id: "real-session",
        title: "child",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        messages: [message("live", "one")],
      },
      runs: [],
      prompts: [],
      history: { hasMore: false },
      reasoningMissing: false,
      todo: { status: "ready", value: null },
      goal: { status: "ready", value: null },
      context: { status: "ready", value: null },
    },
    messages: displayed,
    history: {
      before: "before",
      hasMore: true,
      after: hasLater ? "after" : undefined,
      hasLater,
    },
    executions: [execution("a")],
    anchorFound: true,
    readOnly: true,
  };
}

function selection(watchId: string): UiSubagentConversationSelection {
  return {
    rootSessionId: "root",
    subagentId: "child",
    runtimeEpoch: "epoch",
    bindingGeneration: 1,
    watchId,
  };
}

describe("subagent conversation reader", () => {
  it("opens a pending instance without inventing an execution and follows its first execution", async () => {
    let receive!: (event: UiEvent) => void;
    const read = vi.fn<
      (
        query: UiSubagentConversationQuery,
      ) => Promise<UiSubagentConversationView>
    >(() => Promise.resolve({ ...conversation([]), executions: [] }));
    const reader = createSubagentConversationReader(
      {
        subscribeEvents: (handler): (() => void) => {
          receive = handler;
          return () => undefined;
        },
        watchSubagentConversation: () => Promise.resolve(selection("watch")),
        getSubagentConversationView: read,
      },
      "root",
    );
    await reader.selectInstance({ subagentId: "child" });
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ subagentId: "child" }),
    );
    expect(read.mock.calls[0]?.[0]).not.toHaveProperty("anchorExecutionId");
    expect(reader.getSnapshot()).toMatchObject({
      selectedInstance: { subagentId: "child" },
      loading: false,
    });
    expect(reader.getSnapshot().selected).toBeUndefined();
    receive({
      type: "subagent.conversation.changed",
      rootSessionId: "root",
      subagentId: "child",
      watchId: "watch",
      executions: [execution("first")],
      change: {
        type: "session.changed",
        bindingGeneration: 1,
        version: { ...conversation().view.version, sessionRevision: 2 },
        messages: [message("first", "started")],
      },
    });
    expect(reader.getSnapshot().selected?.executionId).toBe("first");
    expect(reader.getSnapshot().conversation?.messages.at(-1)?.id).toBe(
      "first",
    );
    reader.dispose();
  });

  it("preserves an instance's reading window but repeats each explicit anchor request", async () => {
    const read = vi.fn((query: UiSubagentConversationQuery) =>
      Promise.resolve({
        ...conversation(),
        anchorMessageId: query.anchorExecutionId
          ? `parent-${query.anchorExecutionId}`
          : undefined,
        executions: [execution("a"), execution("b", 2)],
      }),
    );
    const watch = vi.fn(() => Promise.resolve(selection("watch")));
    const reader = createSubagentConversationReader(
      { getSubagentConversationView: read, watchSubagentConversation: watch },
      "root",
    );
    await reader.selectInstance({ subagentId: "child" });
    expect(reader.getSnapshot().selected?.executionId).toBe("b");
    await reader.loadEarlier();
    const window = reader.getSnapshot().conversation;
    await reader.selectInstance({ subagentId: "child" });
    expect(reader.getSnapshot().conversation).toBe(window);
    expect(read).toHaveBeenCalledTimes(2);
    await reader.selectInstance({
      subagentId: "child",
      anchorExecutionId: "a",
    });
    await reader.selectInstance({
      subagentId: "child",
      anchorExecutionId: "a",
    });
    expect(read).toHaveBeenCalledTimes(4);
    expect(read).toHaveBeenLastCalledWith(
      expect.objectContaining({ anchorExecutionId: "a" }),
    );
    expect(reader.getSnapshot().selected?.executionId).toBe("a");
    const messages = reader.getSnapshot().conversation?.messages;
    await reader.selectInstance({ subagentId: "child" });
    expect(reader.getSnapshot().selected?.executionId).toBe("b");
    expect(reader.getSnapshot().conversation?.anchorMessageId).toBeUndefined();
    expect(reader.getSnapshot().conversation?.messages).toBe(messages);
    expect(read).toHaveBeenCalledTimes(4);
    reader.dispose();
  });

  it("keeps a late instance read from replacing a newer selection", async () => {
    let finishRead!: (view: UiSubagentConversationView) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const unwatch = vi.fn(() => Promise.resolve());
    const reader = createSubagentConversationReader(
      {
        watchSubagentConversation: (query) =>
          Promise.resolve({
            ...selection(query.watchId ?? "missing"),
            subagentId: query.subagentId,
          }),
        unwatchSubagentConversation: unwatch,
        getSubagentConversationView: (query) =>
          query.subagentId === "child"
            ? new Promise((resolve) => {
                finishRead = resolve;
                entered();
              })
            : Promise.resolve({
                ...conversation(),
                subagentId: "other",
                executions: [{ ...execution("other"), subagentId: "other" }],
              }),
      },
      "root",
    );
    const old = reader.selectInstance({ subagentId: "child" });
    await started;
    await reader.selectInstance({ subagentId: "other" });
    finishRead(conversation());
    await old;
    expect(reader.getSnapshot().selectedInstance?.subagentId).toBe("other");
    expect(reader.getSnapshot().conversation?.subagentId).toBe("other");
    expect(unwatch).toHaveBeenCalledWith(
      expect.objectContaining({ subagentId: "child" }),
    );
    reader.dispose();
  });

  it("releases a late instance watch without releasing the newer instance's watch", async () => {
    let finishWatch!: (value: UiSubagentConversationSelection) => void;
    const unwatch = vi.fn(() => Promise.resolve());
    const read = vi.fn(() =>
      Promise.resolve({
        ...conversation(),
        subagentId: "other",
        executions: [{ ...execution("other"), subagentId: "other" }],
      }),
    );
    const reader = createSubagentConversationReader(
      {
        watchSubagentConversation: (query) =>
          query.subagentId === "child"
            ? new Promise((resolve) => {
                finishWatch = resolve;
              })
            : Promise.resolve({
                ...selection("other-watch"),
                subagentId: "other",
              }),
        getSubagentConversationView: read,
        unwatchSubagentConversation: unwatch,
      },
      "root",
    );
    const old = reader.selectInstance({ subagentId: "child" });
    await reader.selectInstance({ subagentId: "other" });
    finishWatch(selection("old-watch"));
    await old;
    expect(reader.getSnapshot().selectedInstance?.subagentId).toBe("other");
    expect(reader.getSnapshot().conversation?.subagentId).toBe("other");
    expect(read).toHaveBeenCalledTimes(1);
    expect(unwatch).toHaveBeenCalledWith(
      expect.objectContaining({ watchId: "old-watch" }),
    );
    expect(unwatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ watchId: "other-watch" }),
    );
    reader.dispose();
  });

  it("does not reopen a closed or disposed instance through selectInstance", async () => {
    const read = vi.fn(() =>
      Promise.reject(
        Object.assign(new Error("closed"), { code: "SUBAGENT_CLOSED" }),
      ),
    );
    const watch = vi.fn(() => Promise.resolve(selection("watch")));
    const reader = createSubagentConversationReader(
      { getSubagentConversationView: read, watchSubagentConversation: watch },
      "root",
    );
    await reader.selectInstance({ subagentId: "child" });
    await reader.selectInstance({ subagentId: "child" });
    expect(reader.getSnapshot().error).toBe("closed");
    expect(watch).toHaveBeenCalledTimes(1);
    reader.dispose();
    await reader.selectInstance({ subagentId: "other" });
    expect(watch).toHaveBeenCalledTimes(1);
  });

  it("does not reinstall a late baseline after its instance closes", async () => {
    let receive: (event: UiEvent) => void = () => undefined;
    let finish!: (view: UiSubagentConversationView) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const unwatch = vi.fn(() => Promise.resolve());
    const reader = createSubagentConversationReader(
      {
        subscribeEvents: (handler): (() => void) => {
          receive = handler;
          return () => undefined;
        },
        watchSubagentConversation: () => Promise.resolve(selection("watch")),
        unwatchSubagentConversation: unwatch,
        getSubagentConversationView: () =>
          new Promise((resolve) => {
            finish = resolve;
            entered();
          }),
      },
      "root",
    );
    const reading = reader.select(execution("a"));
    await started;
    receive({
      type: "subagent.conversation.unavailable",
      rootSessionId: "root",
      subagentId: "child",
      watchId: "watch",
      code: "SUBAGENT_CLOSED",
      unavailable: {
        type: "session.unavailable",
        runtimeEpoch: "epoch",
        sessionId: "real-session",
        bindingGeneration: 1,
        reason: "Subagent instance is closed",
      },
    });
    finish(conversation());
    await reading;
    expect(reader.getSnapshot().conversation).toBeUndefined();
    expect(reader.getSnapshot().error).toBe("Subagent instance is closed");
    expect(unwatch).toHaveBeenCalledWith(
      expect.objectContaining({ watchId: "watch" }),
    );
    reader.dispose();
  });
  it.each(["event", "read"] as const)(
    "releases its watch and stops reconnecting after a closed-instance %s",
    async (kind) => {
      let receive: (event: UiEvent) => void = () => undefined;
      const watch = vi.fn(() => Promise.resolve(selection("watch")));
      const unwatch = vi.fn(() => Promise.resolve());
      const read = vi.fn(() => Promise.resolve(conversation()));
      const reader = createSubagentConversationReader(
        {
          subscribeEvents: (handler): (() => void) => {
            receive = handler;
            return () => undefined;
          },
          watchSubagentConversation: watch,
          unwatchSubagentConversation: unwatch,
          getSubagentConversationView: read,
        },
        "root",
      );
      await reader.select(execution("a"));
      if (kind === "event")
        receive({
          type: "subagent.conversation.unavailable",
          rootSessionId: "root",
          subagentId: "child",
          watchId: "watch",
          code: "SUBAGENT_CLOSED",
          unavailable: {
            type: "session.unavailable",
            runtimeEpoch: "epoch",
            sessionId: "real-session",
            bindingGeneration: 1,
            reason: "Subagent instance is closed",
          },
        });
      else {
        read.mockRejectedValueOnce(
          Object.assign(new Error("Subagent instance is closed"), {
            code: "SUBAGENT_CLOSED",
          }),
        );
        await reader.loadEarlier();
      }
      expect(unwatch).toHaveBeenCalledWith(
        expect.objectContaining({ watchId: "watch" }),
      );
      expect(reader.getSnapshot()).toMatchObject({
        loading: false,
        locating: false,
        reconnecting: false,
        error: "Subagent instance is closed",
      });
      expect(reader.getSnapshot().conversation).toBeUndefined();
      const reads = read.mock.calls.length;
      receive({
        type: "session.resync-required",
        runtimeEpoch: "new-epoch",
        sessionId: "root",
        disconnected: false,
      });
      await reader.refresh();
      await reader.jumpToLatest();
      expect(watch).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledTimes(reads);
      reader.dispose();
    },
  );
  it("cancels an in-flight watch by its preallocated ID before its response arrives", async () => {
    let finish: (selection: UiSubagentConversationSelection) => void = () =>
      undefined;
    let requested:
      | { rootSessionId: string; subagentId: string; watchId?: string }
      | undefined;
    const released: string[] = [];
    const reader = createSubagentConversationReader(
      {
        watchSubagentConversation: (query) => {
          requested = query;
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
        unwatchSubagentConversation: (query) => {
          released.push(query.watchId);
          return Promise.resolve();
        },
        getSubagentConversationView: () => Promise.resolve(conversation()),
      },
      "root",
    );
    const pending = reader.select(execution("a"));
    reader.close();
    expect(requested?.watchId).toEqual(expect.any(String));
    expect(released).toContain(requested?.watchId);
    finish(selection(requested?.watchId ?? "missing"));
    await pending;
    expect(reader.getSnapshot().selected).toBeUndefined();
    reader.dispose();
  });

  it("cancels a watch whose response was lost and never releases the next pending ID", async () => {
    const ids: string[] = [];
    const released: string[] = [];
    const reader = createSubagentConversationReader(
      {
        watchSubagentConversation: (query) => {
          const watchId = (query as { watchId?: string }).watchId ?? "missing";
          ids.push(watchId);
          if (ids.length === 1)
            return Promise.reject(new Error("Response lost"));
          return Promise.resolve(selection(watchId));
        },
        unwatchSubagentConversation: (query) => {
          released.push(query.watchId);
          return Promise.resolve();
        },
        getSubagentConversationView: () => Promise.resolve(conversation()),
      },
      "root",
    );
    await reader.select(execution("a"));
    expect(reader.getSnapshot().error).toBe("Response lost");
    expect(released).toContain(ids[0]);
    await reader.select(execution("a"));
    expect(ids[1]).not.toBe(ids[0]);
    expect(released).not.toContain(ids[1]);
    reader.dispose();
  });

  it.each(["refresh", "reconnect"] as const)(
    "preserves loaded earlier history during %s and updates overlapping live content",
    async (kind) => {
      let receive: (event: UiEvent) => void = () => undefined;
      let latest = conversation();
      const reader = createSubagentConversationReader(
        {
          subscribeEvents: (handler) => {
            receive = handler;
            return () => undefined;
          },
          watchSubagentConversation: () => Promise.resolve(selection("w")),
          unwatchSubagentConversation: () => Promise.resolve(),
          getSubagentConversationView: (query) =>
            Promise.resolve(
              query.before
                ? {
                    ...conversation([message("earlier", "earlier")]),
                    history: {
                      before: "start",
                      hasMore: false,
                      hasLater: false,
                    },
                  }
                : latest,
            ),
        },
        "root",
      );
      await reader.select(execution("a"));
      await reader.loadEarlier();
      latest = conversation(
        [message("live", "updated"), message("new", "new")],
        2,
      );
      latest = {
        ...latest,
        view: {
          ...latest.view,
          session: { ...latest.view.session, messages: latest.messages },
        },
        history: {
          before: "tail-start",
          after: "tail-end",
          hasMore: true,
          hasLater: false,
        },
      };
      if (kind === "refresh") await reader.refresh();
      else {
        receive({
          type: "session.resync-required",
          runtimeEpoch: "epoch",
          sessionId: "root",
        });
        await vi.waitFor(() => {
          expect(reader.getSnapshot().loading).toBe(false);
        });
      }
      const result = reader.getSnapshot().conversation;
      expect(result?.messages.map((item) => item.id)).toEqual([
        "earlier",
        "live",
        "new",
      ]);
      expect(result?.messages[1].parts[0]).toMatchObject({ text: "updated" });
      expect(result?.history).toEqual({
        before: "start",
        after: "tail-end",
        hasMore: false,
        hasLater: false,
      });
      reader.dispose();
    },
  );

  it("keeps a gap when the recovered tail no longer overlaps the reading window", async () => {
    let latest = {
      ...conversation([message("old", "old")]),
      history: {
        before: "old-start",
        after: "old-end",
        hasMore: false,
        hasLater: false,
      },
    };
    const reader = createSubagentConversationReader(
      {
        watchSubagentConversation: () => Promise.resolve(selection("w")),
        unwatchSubagentConversation: () => Promise.resolve(),
        getSubagentConversationView: () => Promise.resolve(latest),
      },
      "root",
    );
    await reader.select(execution("a"));
    latest = {
      ...conversation([message("new", "new")], 2),
      history: {
        before: "new-start",
        after: "new-end",
        hasMore: true,
        hasLater: false,
      },
    };
    await reader.refresh();
    expect(
      reader.getSnapshot().conversation?.messages.map((item) => item.id),
    ).toEqual(["old"]);
    expect(reader.getSnapshot().conversation?.history).toMatchObject({
      after: "old-end",
      hasLater: true,
    });
    latest = {
      ...latest,
      view: {
        ...latest.view,
        version: { ...latest.view.version, viewGeneration: "rebuilt" },
      },
    };
    await reader.refresh();
    expect(
      reader.getSnapshot().conversation?.messages.map((item) => item.id),
    ).toEqual(["new"]);
    expect(reader.getSnapshot().conversation?.history).toEqual(latest.history);
    reader.dispose();
  });

  it("buffers scoped changes across watch and snapshot installation", async () => {
    let receive: (event: UiEvent) => void = () => undefined;
    let resolveSnapshot: (value: UiSubagentConversationView) => void = () =>
      undefined;
    const reader = createSubagentConversationReader(
      {
        subscribeEvents: (handler) => {
          receive = handler;
          return () => undefined;
        },
        watchSubagentConversation: () => Promise.resolve(selection("watch-1")),
        unwatchSubagentConversation: () => Promise.resolve(),
        getSubagentConversationView: () =>
          new Promise((resolve) => {
            resolveSnapshot = resolve;
          }),
      },
      "root",
    );
    const selected = reader.select(execution("a"));
    await Promise.resolve();
    receive({
      type: "subagent.conversation.changed",
      rootSessionId: "root",
      subagentId: "child",
      watchId: "watch-1",
      change: {
        type: "session.changed",
        bindingGeneration: 1,
        version: {
          runtimeEpoch: "epoch",
          sessionId: "real-session",
          viewGeneration: "scope-generation",
          sessionRevision: 2,
        },
        textAppends: [
          { messageId: "live", partId: "part", offset: 3, text: " two" },
        ],
      },
    });
    resolveSnapshot(conversation());
    await selected;
    expect(
      reader.getSnapshot().conversation?.view.version.sessionRevision,
    ).toBe(2);
    expect(
      reader.getSnapshot().conversation?.messages[0].parts[0],
    ).toMatchObject({
      text: "one two",
    });
    reader.dispose();
  });

  it("releases a late watch without cancelling a newer watch of the same child", async () => {
    let finishFirst: (value: UiSubagentConversationSelection) => void = () =>
      undefined;
    const releases: string[] = [];
    let watches = 0;
    const reader = createSubagentConversationReader(
      {
        subscribeEvents: () => () => undefined,
        watchSubagentConversation: () => {
          watches += 1;
          return watches === 1
            ? new Promise((resolve) => {
                finishFirst = resolve;
              })
            : Promise.resolve(selection(`watch-${String(watches)}`));
        },
        unwatchSubagentConversation: (query) => {
          releases.push(query.watchId);
          return Promise.resolve();
        },
        getSubagentConversationView: () => Promise.resolve(conversation()),
      },
      "root",
    );
    const old = reader.select(execution("a"));
    const current = reader.select(execution("a", 2));
    await current;
    finishFirst(selection("watch-1"));
    await old;
    await Promise.resolve();
    expect(releases).toContain("watch-1");
    expect(releases).not.toContain("watch-2");
    expect(reader.getSnapshot().selected?.delegationSequence).toBe(2);
    reader.dispose();
  });

  it("keeps an anchor window separate from the live tail and pages forward", async () => {
    let receive: (event: UiEvent) => void = () => undefined;
    const read = vi.fn(
      (query: { after?: string; anchorExecutionId?: string }) => {
        if (query.after) {
          return Promise.resolve({
            ...conversation([message("middle", "middle")], 2, false),
            history: { hasMore: true, before: "before", hasLater: false },
          });
        }
        return Promise.resolve(
          conversation([message("parent-a", "old")], 1, true),
        );
      },
    );
    const reader = createSubagentConversationReader(
      {
        subscribeEvents: (handler) => {
          receive = handler;
          return () => undefined;
        },
        watchSubagentConversation: () => Promise.resolve(selection("watch-1")),
        unwatchSubagentConversation: () => Promise.resolve(),
        getSubagentConversationView: read,
      },
      "root",
    );
    await reader.select(execution("a"));
    expect(read.mock.calls[0][0]).toMatchObject({ anchorExecutionId: "a" });
    receive({
      type: "subagent.conversation.changed",
      rootSessionId: "root",
      subagentId: "child",
      watchId: "watch-1",
      change: {
        type: "session.changed",
        bindingGeneration: 1,
        version: {
          runtimeEpoch: "epoch",
          sessionId: "real-session",
          viewGeneration: "scope-generation",
          sessionRevision: 2,
        },
        messages: [message("latest", "latest")],
      },
    });
    expect(
      reader.getSnapshot().conversation?.messages.map((m) => m.id),
    ).toEqual(["parent-a"]);
    expect(
      reader.getSnapshot().conversation?.view.session.messages.map((m) => m.id),
    ).toContain("latest");
    await reader.loadLater();
    expect(read.mock.calls[1][0]).toMatchObject({ after: "after" });
    expect(
      reader.getSnapshot().conversation?.messages.map((m) => m.id),
    ).toEqual(["parent-a", "middle"]);
    reader.dispose();
  });

  it.each([true, false])(
    "keeps a runless compaction notice inside its delegation segment (request facts %s)",
    (withRequest) => {
      const first = {
        ...execution("a", 1),
        startedAt: 1000,
        completedAt: 2000,
      };
      const second = { ...execution("b", 2), startedAt: 2000 };
      const notice: UiMessage = {
        id: "summary-a",
        role: "system",
        createdAt: new Date(withRequest ? 2000 : 1500).toISOString(),
        parts: [
          {
            type: "text",
            text: "Context compacted",
            metadata: { kind: "context-compaction" },
          },
        ],
        ...(withRequest
          ? {
              modelRequests: [
                {
                  purpose: "context-summary" as const,
                  requestId: "request-summary",
                  messageId: "summary-a",
                  compactionId: "compact-a",
                  attempt: 1,
                  startedAt: 1500,
                  endedAt: 1900,
                  outcome: "success" as const,
                },
              ],
            }
          : {}),
      };
      const timed = (id: string, at: number, runId: string): UiMessage => ({
        ...message(id, "", runId),
        createdAt: new Date(at).toISOString(),
      });
      const ordered = compareSubagentMessages(
        [
          timed("parent-a", 900, "run-a"),
          timed("body-a", 1100, "run-a"),
          notice,
          timed("parent-b", 950, "run-b"),
          timed("body-b", 2200, "run-b"),
        ],
        [second, first],
      );
      expect(ordered.map((item) => item.id)).toEqual([
        "parent-a",
        "body-a",
        "summary-a",
        "parent-b",
        "body-b",
      ]);
      expect(
        ordered.find((item) => item.id === "summary-a"),
      ).not.toHaveProperty("runId");
    },
  );

  it("does not assign a compaction notice to a legacy execution without a child run", () => {
    const active = { ...execution("a", 1), startedAt: 1000, completedAt: 2000 };
    const legacy = {
      ...execution("legacy", 2),
      childRunId: undefined,
      startedAt: 1200,
    };
    const notice: UiMessage = {
      id: "summary-a",
      role: "system",
      createdAt: new Date(1500).toISOString(),
      parts: [
        {
          type: "text",
          text: "Context compacted",
          metadata: { kind: "context-compaction" },
        },
      ],
    };
    const parentLegacy = { ...message("parent-legacy", ""), runId: undefined };
    const ordered = compareSubagentMessages(
      [
        message("parent-a", ""),
        { ...message("body-a", ""), createdAt: new Date(1100).toISOString() },
        notice,
        parentLegacy,
      ],
      [active, legacy],
    );
    expect(ordered.map((item) => item.id)).toEqual([
      "parent-a",
      "body-a",
      "summary-a",
      "parent-legacy",
    ]);
  });

  it("sorts parent before its process and preserves delegation segments", () => {
    const first = execution("a", 1);
    const second = execution("b", 2);
    const ordered = compareSubagentMessages(
      [
        message("body-b", "", "run-b"),
        message("parent-b", "", "run-b"),
        message("body-a", "", "run-a"),
        message("parent-a", "", "run-a"),
      ],
      [first, second],
    );
    expect(ordered.map((m) => m.id)).toEqual([
      "parent-a",
      "body-a",
      "parent-b",
      "body-b",
    ]);
  });

  it("merges metadata-only execution updates by execution ID", async () => {
    let receive: (event: UiEvent) => void = () => undefined;
    const reader = createSubagentConversationReader(
      {
        subscribeEvents: (handler) => {
          receive = handler;
          return () => undefined;
        },
        watchSubagentConversation: () => Promise.resolve(selection("watch-1")),
        unwatchSubagentConversation: () => Promise.resolve(),
        getSubagentConversationView: () => Promise.resolve(conversation()),
      },
      "root",
    );
    await reader.select(execution("a"));
    receive({
      type: "subagent.conversation.changed",
      rootSessionId: "root",
      subagentId: "child",
      watchId: "watch-1",
      change: {
        type: "session.changed",
        bindingGeneration: 1,
        version: {
          runtimeEpoch: "epoch",
          sessionId: "real-session",
          viewGeneration: "scope-generation",
          sessionRevision: 2,
        },
      },
      executions: [{ ...execution("a"), status: "completed", completedAt: 5 }],
    });
    expect(reader.getSnapshot().conversation?.executions).toMatchObject([
      { executionId: "a", status: "completed" },
    ]);
    expect(
      reader.getSnapshot().conversation?.view.version.sessionRevision,
    ).toBe(2);
    reader.dispose();
  });

  it("rebuilds from a fresh snapshot on a scoped revision gap", async () => {
    let receive: (event: UiEvent) => void = () => undefined;
    const reads = vi
      .fn()
      .mockResolvedValueOnce(conversation())
      .mockResolvedValueOnce(conversation([message("live", "fresh")], 4));
    const reader = createSubagentConversationReader(
      {
        subscribeEvents: (handler) => {
          receive = handler;
          return () => undefined;
        },
        watchSubagentConversation: () => Promise.resolve(selection("watch-1")),
        unwatchSubagentConversation: () => Promise.resolve(),
        getSubagentConversationView: reads,
      },
      "root",
    );
    await reader.select(execution("a"));
    receive({
      type: "subagent.conversation.changed",
      rootSessionId: "root",
      subagentId: "child",
      watchId: "watch-1",
      change: {
        type: "session.changed",
        bindingGeneration: 1,
        version: {
          runtimeEpoch: "epoch",
          sessionId: "real-session",
          viewGeneration: "scope-generation",
          sessionRevision: 4,
        },
      },
    });
    await vi.waitFor(() => {
      expect(
        reader.getSnapshot().conversation?.view.version.sessionRevision,
      ).toBe(4);
    });
    expect(reads).toHaveBeenCalledTimes(2);
    reader.dispose();
  });

  it("reestablishes the watch after transport resync", async () => {
    let receive: (event: UiEvent) => void = () => undefined;
    let watchCount = 0;
    const released: string[] = [];
    const reads = vi
      .fn()
      .mockResolvedValueOnce(conversation())
      .mockResolvedValueOnce(conversation([message("live", "two")], 2));
    const reader = createSubagentConversationReader(
      {
        subscribeEvents: (handler) => {
          receive = handler;
          return () => undefined;
        },
        watchSubagentConversation: () => {
          watchCount += 1;
          return Promise.resolve(selection(`watch-${String(watchCount)}`));
        },
        unwatchSubagentConversation: (input) => {
          released.push(input.watchId);
          return Promise.resolve();
        },
        getSubagentConversationView: reads,
      },
      "root",
    );
    await reader.select(execution("a"));
    receive({
      type: "session.resync-required",
      runtimeEpoch: "epoch",
      sessionId: "root",
      disconnected: true,
    });
    expect(watchCount).toBe(1);
    receive({
      type: "session.resync-required",
      runtimeEpoch: "epoch",
      sessionId: "root",
      disconnected: false,
    });
    await vi.waitFor(() => {
      expect(
        reader.getSnapshot().conversation?.view.version.sessionRevision,
      ).toBe(2);
    });
    expect(watchCount).toBe(2);
    expect(released).toContain("watch-1");
    reader.dispose();
  });
  it("ignores stale execution metadata and removes deleted messages from the visible window", async () => {
    let receive: (event: UiEvent) => void = () => undefined;
    const reader = createSubagentConversationReader(
      {
        subscribeEvents: (handler) => {
          receive = handler;
          return () => undefined;
        },
        watchSubagentConversation: () => Promise.resolve(selection("w")),
        unwatchSubagentConversation: () => Promise.resolve(),
        getSubagentConversationView: () => Promise.resolve(conversation()),
      },
      "root",
    );
    await reader.select(execution("a"));
    const event = (
      revision: number,
      status: "queued" | "completed",
      removedMessageIds?: string[],
    ): UiEvent => ({
      type: "subagent.conversation.changed",
      rootSessionId: "root",
      subagentId: "child",
      watchId: "w",
      change: {
        type: "session.changed",
        bindingGeneration: 1,
        version: { ...conversation().view.version, sessionRevision: revision },
        removedMessageIds,
      },
      executions: [{ ...execution("a"), status }],
    });
    receive(event(2, "completed"));
    receive(event(1, "queued"));
    expect(reader.getSnapshot().conversation?.executions[0].status).toBe(
      "completed",
    );
    receive(event(3, "completed", ["live"]));
    expect(reader.getSnapshot().conversation?.messages).toEqual([]);
    reader.dispose();
  });
  it("does not revive Queued from a history page captured before a live completion", async () => {
    let receive: (event: UiEvent) => void = () => undefined;
    let finishPage: (value: UiSubagentConversationView) => void = () =>
      undefined;
    const reader = createSubagentConversationReader(
      {
        subscribeEvents: (handler) => {
          receive = handler;
          return () => undefined;
        },
        watchSubagentConversation: () => Promise.resolve(selection("w")),
        unwatchSubagentConversation: () => Promise.resolve(),
        getSubagentConversationView: (query) =>
          query.before
            ? new Promise((resolve) => {
                finishPage = resolve;
              })
            : Promise.resolve(conversation()),
      },
      "root",
    );
    await reader.select(execution("a"));
    const loading = reader.loadEarlier();
    receive({
      type: "subagent.conversation.changed",
      rootSessionId: "root",
      subagentId: "child",
      watchId: "w",
      change: {
        type: "session.changed",
        bindingGeneration: 1,
        version: { ...conversation().view.version, sessionRevision: 2 },
      },
      executions: [{ ...execution("a"), status: "completed" }],
    });
    finishPage({
      ...conversation([message("old", "older")]),
      executions: [{ ...execution("a"), status: "queued" }],
    });
    await loading;
    expect(reader.getSnapshot().conversation?.executions[0].status).toBe(
      "completed",
    );
    expect(
      reader.getSnapshot().conversation?.messages.map((message) => message.id),
    ).toContain("old");
    reader.dispose();
  });
  it("does not prepend updates from an older run ahead of a selected queued anchor", async () => {
    let receive: (event: UiEvent) => void = () => undefined;
    const queued = { ...execution("b", 2), status: "queued" as const };
    const parent = {
      ...message("parent-b", "queued", "run-b"),
      role: "user" as const,
    };
    const initial = {
      ...conversation([parent]),
      executions: [execution("a"), queued],
    };
    const reader = createSubagentConversationReader(
      {
        subscribeEvents: (handler) => {
          receive = handler;
          return () => undefined;
        },
        watchSubagentConversation: () => Promise.resolve(selection("w")),
        unwatchSubagentConversation: () => Promise.resolve(),
        getSubagentConversationView: () => Promise.resolve(initial),
      },
      "root",
    );
    await reader.select(queued);
    receive({
      type: "subagent.conversation.changed",
      rootSessionId: "root",
      subagentId: "child",
      watchId: "w",
      change: {
        type: "session.changed",
        bindingGeneration: 1,
        version: { ...initial.view.version, sessionRevision: 2 },
        messages: [message("live", "finished first run")],
      },
    });
    expect(
      reader.getSnapshot().conversation?.messages.map((message) => message.id),
    ).toEqual(["parent-b"]);
    reader.dispose();
  });
});
