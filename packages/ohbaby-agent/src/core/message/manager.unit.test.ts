import { describe, expect, it } from "vitest";
import { createBus } from "../../bus/index.js";
import type { BusEventPayload } from "../../bus/index.js";
import { createMessageManager, Message } from "./index.js";
import { createInMemoryMessageStore } from "./store.js";
import type { MessageIdGenerator, MessageStore } from "./types.js";

describe("MessageManager", () => {
  it("rejects malformed message event payloads at runtime", () => {
    const bus = createBus();
    const invalidPayload = {
      info: {
        id: "message_bad",
        role: "assistant",
      },
    } as unknown as BusEventPayload<typeof Message.Event.Updated>;

    expect(() => {
      bus.publish(Message.Event.Updated, invalidPayload);
    }).toThrow();
  });

  it("creates messages, persists them, and publishes message update events", async () => {
    const bus = createBus();
    const store = createInMemoryMessageStore();
    const manager = createMessageManager({
      bus,
      store,
      idGenerator: createDeterministicIds(),
      now: () => 1_700_000_000_000,
    });
    const events: unknown[] = [];
    bus.subscribe(Message.Event.Updated, (payload) => {
      events.push(payload);
    });

    const message = await manager.createMessage({
      sessionId: "session_1",
      role: "user",
      agent: "default",
    });

    expect(message).toMatchObject({
      id: "message_1",
      sessionId: "session_1",
      role: "user",
      agent: "default",
      time: { created: 1_700_000_000_000 },
    });
    await expect(manager.listBySession("session_1")).resolves.toMatchObject([
      { info: { id: "message_1" }, parts: [] },
    ]);
    expect(events).toEqual([{ info: message }]);
  });

  it("appends and updates ordered parts while publishing part update events", async () => {
    const bus = createBus();
    const manager = createMessageManager({
      bus,
      store: createInMemoryMessageStore(),
      idGenerator: createDeterministicIds(),
      now: () => 1_700_000_000_000,
    });
    const partEvents: unknown[] = [];
    bus.subscribe(Message.Event.PartUpdated, (payload) => {
      partEvents.push(payload);
    });
    const assistant = await manager.createMessage({
      sessionId: "session_1",
      role: "assistant",
      agent: "default",
      parentId: "message_parent",
    });

    const firstPart = await manager.appendPart(assistant.id, {
      type: "text",
      text: "Hello",
    });
    const secondPart = await manager.appendPart(assistant.id, {
      type: "reasoning",
      text: "thinking",
    });
    const updatedPart = await manager.updatePart(firstPart.id, {
      text: "Hello world",
      delta: " world",
    });

    await expect(manager.listBySession("session_1")).resolves.toMatchObject([
      {
        info: { id: assistant.id },
        parts: [
          { id: firstPart.id, type: "text", text: "Hello world" },
          { id: secondPart.id, type: "reasoning", text: "thinking" },
        ],
      },
    ]);
    expect(updatedPart).toMatchObject({
      id: firstPart.id,
      text: "Hello world",
    });
    expect(partEvents).toEqual([
      { part: firstPart },
      { part: secondPart },
      { part: updatedPart, delta: " world" },
    ]);
  });

  it("allocates distinct part order indexes during concurrent appends", async () => {
    const manager = createMessageManager({
      bus: createBus(),
      store: createInMemoryMessageStore(),
      idGenerator: createDeterministicIds(),
      now: () => 1_700_000_000_000,
    });
    const message = await manager.createMessage({
      sessionId: "session_1",
      role: "assistant",
      agent: "default",
      parentId: "message_parent",
    });

    const [firstPart, secondPart] = await Promise.all([
      manager.appendPart(message.id, { type: "text", text: "A" }),
      manager.appendPart(message.id, { type: "text", text: "B" }),
    ]);

    expect([firstPart.orderIndex, secondPart.orderIndex].sort()).toEqual([
      0, 1,
    ]);
    await expect(manager.listBySession("session_1")).resolves.toMatchObject([
      {
        parts: [
          { type: "text", orderIndex: 0 },
          { type: "text", orderIndex: 1 },
        ],
      },
    ]);
  });

  it("does not publish message events when the store write fails", async () => {
    const bus = createBus();
    const manager = createMessageManager({
      bus,
      store: createRejectingMessageStore(new Error("insert failed")),
      idGenerator: createDeterministicIds(),
      now: () => 1_700_000_000_000,
    });
    const events: unknown[] = [];
    bus.subscribe(Message.Event.Updated, (payload) => {
      events.push(payload);
    });

    await expect(
      manager.createMessage({
        sessionId: "session_1",
        role: "user",
        agent: "default",
      }),
    ).rejects.toThrow("insert failed");
    expect(events).toEqual([]);
  });

  it("does not feed reasoning parts to provider model messages", async () => {
    const manager = createMessageManager({
      bus: createBus(),
      store: createInMemoryMessageStore(),
      idGenerator: createDeterministicIds(),
      now: () => 1_700_000_000_000,
    });
    const user = await manager.createMessage({
      sessionId: "session_1",
      role: "user",
      agent: "default",
    });
    const assistant = await manager.createMessage({
      sessionId: "session_1",
      role: "assistant",
      agent: "default",
      parentId: user.id,
    });

    await manager.appendPart(user.id, { type: "text", text: "Say hello" });
    await manager.appendPart(assistant.id, {
      type: "reasoning",
      text: "briefly",
    });
    await manager.appendPart(assistant.id, {
      type: "text",
      text: "Hello",
    });
    await manager.appendPart(assistant.id, {
      type: "tool",
      callId: "call_1",
      tool: "read_file",
      state: {
        status: "completed",
        input: {},
        output: "file contents",
      },
    });
    const compacted = await manager.appendPart(assistant.id, {
      type: "tool",
      callId: "call_2",
      tool: "read_file",
      state: {
        status: "completed",
        input: {},
        output: "old file contents",
      },
    });
    await manager.updatePart(compacted.id, {
      time: { compacted: 1_700_000_000_001 },
    });

    await expect(manager.toModelMessages("session_1")).resolves.toEqual([
      { role: "user", content: "Say hello" },
      { role: "assistant", content: "Hellofile contents" },
    ]);
  });

  it("orders context summaries before remaining active history", async () => {
    const manager = createMessageManager({
      bus: createBus(),
      store: createInMemoryMessageStore(),
      idGenerator: createDeterministicIds(),
      now: () => 1_700_000_000_000,
    });
    const old = await manager.createMessage({
      sessionId: "session_1",
      role: "user",
      agent: "default",
    });
    const recent = await manager.createMessage({
      sessionId: "session_1",
      role: "assistant",
      agent: "default",
    });
    const summary = await manager.createMessage({
      sessionId: "session_1",
      role: "assistant",
      agent: "context",
    });
    const oldPart = await manager.appendPart(old.id, {
      type: "text",
      text: "old history",
    });
    await manager.updatePart(oldPart.id, {
      time: { compacted: 1_700_000_000_001 },
    });
    await manager.appendPart(recent.id, {
      type: "text",
      text: "recent history",
    });
    await manager.appendPart(summary.id, {
      type: "text",
      text: "<state_snapshot>summary</state_snapshot>",
      synthetic: true,
      metadata: { kind: "context-summary" },
    });

    await expect(manager.toModelMessages("session_1")).resolves.toEqual([
      {
        role: "assistant",
        content: "<state_snapshot>summary</state_snapshot>",
      },
      { role: "assistant", content: "recent history" },
    ]);
  });

  it("keeps partial aborted tool output before the abort notice in model messages", async () => {
    const manager = createMessageManager({
      bus: createBus(),
      store: createInMemoryMessageStore(),
      idGenerator: createDeterministicIds(),
      now: () => 1_700_000_000_000,
    });
    const assistant = await manager.createMessage({
      sessionId: "session_1",
      role: "assistant",
      agent: "default",
    });
    await manager.appendPart(assistant.id, {
      callId: "call_bash",
      state: {
        error: "Tool execution aborted by user",
        input: {},
        output: "partial stdout before abort",
        status: "aborted",
      },
      tool: "bash",
      type: "tool",
    });

    await expect(manager.toModelMessages("session_1")).resolves.toEqual([
      {
        content: "partial stdout before abort\n\nTool execution aborted by user",
        role: "assistant",
      },
    ]);
  });
});

function createDeterministicIds(): MessageIdGenerator {
  let nextMessageId = 1;
  let nextPartId = 1;

  return {
    messageId(): string {
      const id = `message_${String(nextMessageId)}`;
      nextMessageId += 1;
      return id;
    },
    partId(): string {
      const id = `part_${String(nextPartId)}`;
      nextPartId += 1;
      return id;
    },
  };
}

function createRejectingMessageStore(error: Error): MessageStore {
  const store = createInMemoryMessageStore();
  return {
    ...store,
    insertMessage(): Promise<void> {
      return Promise.reject(error);
    },
  };
}
