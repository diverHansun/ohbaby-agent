import { describe, expect, it, vi } from "vitest";
import type { UiEvent } from "./events.js";
import {
  compareSubagentMessages,
  createSubagentConversationReader,
} from "./subagent-conversation-reader.js";
import type {
  UiSubagentConversationSelection,
  UiSubagentConversationView,
  UiSubagentExecution,
} from "./subagent.js";

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
  displayed = [message("live", "one")],
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
});
