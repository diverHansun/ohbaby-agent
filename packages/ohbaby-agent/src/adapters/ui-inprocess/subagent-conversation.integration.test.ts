import { describe, expect, it } from "vitest";
import { createBus } from "../../bus/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../../core/message/index.js";
import { InMemorySubagentExecutionStore } from "../../agents/subagents/execution-store.js";
import { SourceSessionProjection } from "../ui-state/source-session-projection.js";
import { SubagentConversationProjection } from "./subagent-conversation.js";
import type { UiEvent } from "ohbaby-sdk";

function required(value: string | undefined): string {
  if (!value) throw new Error("Expected reserved user message ID");
  return value;
}

function fixture() {
  const messages = createMessageManager({
    bus: createBus(),
    store: createInMemoryMessageStore(),
  });
  const executions = new InMemorySubagentExecutionStore();
  const events: UiEvent[] = [];
  const source = new SourceSessionProjection({
    runtimeEpoch: "epoch",
    messageManager: messages,
    metadata: (id) =>
      Promise.resolve({
        id,
        title: id,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      }),
    runs: () => Promise.resolve([]),
    prompts: () => Promise.resolve([]),
    publish: () => undefined,
  });
  const conversations = new SubagentConversationProjection({
    runtimeEpoch: "epoch",
    executions,
    instances: {
      get: ({
        subagentId,
      }): Promise<{
        parentSessionId: string;
        name: string | undefined;
        description: string | undefined;
      }> =>
        Promise.resolve({
          parentSessionId: "root",
          name:
            subagentId === "a"
              ? "Researcher\nalpha"
              : subagentId === "long"
                ? "Researcher ".repeat(20)
                : undefined,
          description: subagentId === "b" ? "First task B" : undefined,
        }),
    },
    messages,
    source,
    publish: (event) => {
      events.push(event);
    },
    validateRoot: (id) => {
      return id === "root"
        ? Promise.resolve()
        : Promise.reject(new Error("Wrong root"));
    },
    runs: () => Promise.resolve([]),
  });
  async function accept(id: string, subagentId = "a") {
    const { record } = await executions.accept({
      executionId: id,
      requestId: id,
      requesterRunId: "root-run",
      requesterScopeId: "primary",
      rootSessionId: "root",
      rootRunId: "root-run",
      parentSessionId: "root",
      subagentId,
      mode: "background",
      prompt: `Prompt ${id}`,
      createdAt: 1,
    });
    await executions.bindChild(
      record,
      { sessionId: "shared-child", contextScopeId: subagentId },
      2,
    );
    return record;
  }
  return { messages, executions, events, source, conversations, accept };
}

describe("continuous subagent live projection", () => {
  it("uses stable instance names for different anchors sharing one physical session", async () => {
    const f = fixture();
    await f.accept("a1");
    await f.accept("a2");
    await f.accept("b1", "b");
    const read = (
      subagentId: string,
      anchorExecutionId: string,
    ): ReturnType<SubagentConversationProjection["read"]> =>
      f.conversations.read({
        rootSessionId: "root",
        subagentId,
        anchorExecutionId,
      });
    expect((await read("a", "a1")).displayName).toBe("Researcher alpha");
    expect((await read("a", "a2")).displayName).toBe("Researcher alpha");
    expect((await read("b", "b1")).displayName).toBe("First task B");
    await f.conversations.retain({
      rootSessionId: "root",
      subagentId: "a",
      watchId: "watch",
    });
    await f.conversations.release({
      rootSessionId: "root",
      subagentId: "a",
      watchId: "watch",
    });
    expect((await read("a", "a1")).displayName).toBe("Researcher alpha");
    await f.accept("missing", "missing");
    expect((await read("missing", "missing")).displayName).toBe("Subagent");
    await f.accept("long", "long");
    const longName = (await read("long", "long")).displayName;
    expect(longName?.length).toBeLessThanOrEqual(80);
    expect(longName).toMatch(/^Researcher .*\.\.\.$/u);
    f.conversations.dispose();
  });

  it("exposes stored output only for the selected execution without a child run", async () => {
    const f = fixture();
    const a = await f.accept("stored-a");
    const b = await f.accept("stored-b", "b");
    await f.executions.finish(a, {
      status: "completed",
      output: "Stored answer A",
      completedAt: 3,
    });
    await f.executions.finish(b, {
      status: "completed",
      output: "Private answer B",
      completedAt: 3,
    });
    const selected = await f.conversations.read({
      rootSessionId: "root",
      subagentId: "a",
      anchorExecutionId: a.executionId,
    });
    expect(selected.storedResult).toBe("Stored answer A");
    expect(JSON.stringify(selected)).not.toContain("Private answer B");
    const latest = await f.conversations.read({
      rootSessionId: "root",
      subagentId: "a",
    });
    expect(latest.storedResult).toBeUndefined();
    f.conversations.dispose();
  });

  it("keeps accepted prompts display-only, streams scoped messages and reasoning", async () => {
    const f = fixture();
    const a = await f.accept("a1");
    await f.executions.start(a, "run-a", 3);
    await f.accept("b1", "b");
    const first = await f.conversations.read({
      rootSessionId: "root",
      subagentId: "a",
      anchorExecutionId: "a1",
    });
    expect(first.messages.map((m) => m.id)).toContain(a.childUserMessageId);
    expect(
      await f.messages.listByIds("shared-child", [
        required(a.childUserMessageId),
      ]),
    ).toEqual([]);
    await f.messages.createMessage({
      id: "assistant-a",
      sessionId: "shared-child",
      contextScopeId: "a",
      runId: "run-a",
      role: "assistant",
      agent: "explore",
    });
    const part = await f.messages.appendPart("assistant-a", {
      type: "text",
      text: "first",
    });
    await f.messages.createMessage({
      id: "assistant-b",
      sessionId: "shared-child",
      contextScopeId: "b",
      runId: "run-b",
      role: "assistant",
      agent: "explore",
    });
    await f.messages.appendPart("assistant-b", {
      type: "text",
      text: "PRIVATE B",
    });
    await f.source.reasoning.update(
      {
        sessionId: "shared-child",
        contextScopeId: "a",
        runId: "run-a",
        messageId: "assistant-a",
        partId: "reason-a",
      },
      "thinking now",
    );
    await f.messages.updatePart(part.id, { text: "first second" });
    const last = await f.conversations.read({
      rootSessionId: "root",
      subagentId: "a",
    });
    expect(
      last.view.session.messages.find((m) => m.id === "assistant-a")?.parts,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: "first second" }),
        expect.objectContaining({ type: "reasoning", text: "thinking now" }),
      ]),
    );
    expect(JSON.stringify(last)).not.toContain("PRIVATE B");
    expect(last.view.version.sessionRevision).toBeGreaterThan(
      first.view.version.sessionRevision,
    );
    expect(
      f.events.some((e) => e.type === "subagent.conversation.changed"),
    ).toBe(true);
    f.conversations.dispose();
    f.source.reasoning.dispose();
    f.source.owner.dispose();
  });

  it("retains queued parent identity when the real message starts and rejects foreign anchors", async () => {
    const f = fixture();
    const a = await f.accept("a1");
    const before = await f.conversations.read({
      rootSessionId: "root",
      subagentId: "a",
    });
    await f.executions.start(a, "run-a", 4);
    await f.messages.createMessage({
      id: required(a.childUserMessageId),
      sessionId: "shared-child",
      contextScopeId: "a",
      role: "user",
      agent: "explore",
    });
    await f.messages.appendPart(required(a.childUserMessageId), {
      type: "text",
      text: "Prompt a1",
    });
    const after = await f.conversations.read({
      rootSessionId: "root",
      subagentId: "a",
    });
    expect(before.messages[0]?.id).toBe(after.messages[0]?.id);
    expect(
      after.messages.filter((m) => m.id === a.childUserMessageId),
    ).toHaveLength(1);
    await f.accept("b1", "b");
    await expect(
      f.conversations.read({
        rootSessionId: "root",
        subagentId: "a",
        anchorExecutionId: "b1",
      }),
    ).rejects.toThrow();
    await expect(
      f.conversations.read({ rootSessionId: "other", subagentId: "a" }),
    ).rejects.toThrow();
    f.conversations.dispose();
    f.source.reasoning.dispose();
    f.source.owner.dispose();
  });
  it("publishes only changed execution metadata and keeps an empty real prompt visible", async () => {
    const f = fixture();
    const a = await f.accept("a1");
    await f.conversations.retain({
      rootSessionId: "root",
      subagentId: "a",
      watchId: "watch-a",
    });
    f.events.length = 0;
    const a2 = await f.accept("a2");
    await f.conversations.read({ rootSessionId: "root", subagentId: "a" });
    const accepted = f.events.filter(
      (e) => e.type === "subagent.conversation.changed",
    );
    expect(
      accepted.some((e) => e.executions?.some((r) => r.executionId === "a2")),
    ).toBe(true);
    expect(accepted.every((e) => (e.executions?.length ?? 0) <= 1)).toBe(true);
    await f.executions.start(a, "run-a", 4);
    await f.messages.createMessage({
      id: required(a.childUserMessageId),
      sessionId: "shared-child",
      contextScopeId: "a",
      role: "user",
      agent: "explore",
    });
    const snapshot = await f.conversations.read({
      rootSessionId: "root",
      subagentId: "a",
      anchorExecutionId: "a1",
    });
    expect(
      snapshot.messages.find((m) => m.id === a.childUserMessageId)?.parts,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "Prompt a1" })]),
    );
    f.events.length = 0;
    await f.messages.appendPart(required(a.childUserMessageId), {
      type: "text",
      text: "Prompt a1",
    });
    await f.conversations.read({ rootSessionId: "root", subagentId: "a" });
    expect(
      f.events
        .filter((e) => e.type === "subagent.conversation.changed")
        .every((e) => e.executions === undefined),
    ).toBe(true);
    expect(a2.childUserMessageId).not.toBe(a.childUserMessageId);
    f.conversations.dispose();
    f.source.reasoning.dispose();
    f.source.owner.dispose();
  });

  it("releases only the matching watch and stops projecting after the last viewer closes", async () => {
    const f = fixture();
    const a = await f.accept("a1");
    await f.conversations.retain({
      rootSessionId: "root",
      subagentId: "a",
      watchId: "old",
    });
    await f.conversations.retain({
      rootSessionId: "root",
      subagentId: "a",
      watchId: "new",
    });
    await f.conversations.release({
      rootSessionId: "root",
      subagentId: "a",
      watchId: "old",
    });
    f.events.length = 0;
    await f.executions.start(a, "run-a", 4);
    await f.conversations.read({ rootSessionId: "root", subagentId: "a" });
    expect(
      f.events.some((e) => e.type === "subagent.conversation.changed"),
    ).toBe(true);
    await f.conversations.release({
      rootSessionId: "root",
      subagentId: "a",
      watchId: "new",
    });
    f.events.length = 0;
    await f.accept("a2");
    await f.source.owner.runControl("shared-child", () =>
      Promise.resolve(undefined),
    );
    expect(f.events).toEqual([]);
    f.conversations.dispose();
    f.source.reasoning.dispose();
    f.source.owner.dispose();
  });
  it("never treats the root as a transcript source while a new child is unbound", async () => {
    const f = fixture();
    await f.executions.accept({
      executionId: "unbound",
      requestId: "unbound",
      requesterRunId: "root-run",
      requesterScopeId: "primary",
      rootSessionId: "root",
      rootRunId: "root-run",
      parentSessionId: "root",
      subagentId: "new",
      mode: "background",
      prompt: "Queued child prompt",
      createdAt: 1,
    });
    await f.conversations.retain({
      rootSessionId: "root",
      subagentId: "new",
      watchId: "unbound-watch",
    });
    await f.messages.createMessage({
      id: "root-answer",
      sessionId: "root",
      role: "assistant",
      agent: "primary",
    });
    await f.messages.appendPart("root-answer", {
      type: "text",
      text: "ROOT_ONLY_TEXT",
    });
    const child = await f.conversations.read({
      rootSessionId: "root",
      subagentId: "new",
    });
    expect(JSON.stringify(child)).not.toContain("ROOT_ONLY_TEXT");
    expect(child.messages).toHaveLength(1);
    expect(child.view.session.messages).toHaveLength(1);
    f.conversations.dispose();
    f.source.reasoning.dispose();
    f.source.owner.dispose();
  });
});
