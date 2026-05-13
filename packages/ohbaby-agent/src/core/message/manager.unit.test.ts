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

  it("converts text and reasoning parts to provider model messages", async () => {
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

    await expect(manager.toModelMessages("session_1")).resolves.toEqual([
      { role: "user", content: "Say hello" },
      { role: "assistant", content: "brieflyHello" },
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
