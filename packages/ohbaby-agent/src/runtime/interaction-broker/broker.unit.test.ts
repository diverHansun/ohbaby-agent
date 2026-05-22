import { describe, expect, it } from "vitest";
import { createBus } from "../../bus/index.js";
import { createInteractionBroker, InteractionEvent } from "./index.js";

describe("InteractionBroker", () => {
  it("creates pending interactions and publishes requested events", () => {
    const bus = createBus();
    const events: unknown[] = [];
    bus.subscribe(InteractionEvent.Requested, (event) => {
      events.push(event);
    });
    const broker = createInteractionBroker({
      bus,
      createInteractionId: () => "interaction_1",
      now: () => 1_000,
    });

    void broker.request(
      {
        kind: "select-one",
        options: [{ id: "gpt", label: "GPT" }],
        prompt: "Choose model",
        subject: "model",
      },
      {
        clientInvocationId: "inv_1",
        commandRunId: "cmd_1",
        sessionId: "session_1",
      },
    );

    expect(broker.listPending()).toEqual([
      {
        clientInvocationId: "inv_1",
        commandRunId: "cmd_1",
        createdAt: 1_000,
        interactionId: "interaction_1",
        sessionId: "session_1",
        subject: "model",
      },
    ]);
    expect(events).toEqual([
      {
        request: {
          clientInvocationId: "inv_1",
          commandRunId: "cmd_1",
          interactionId: "interaction_1",
          kind: "select-one",
          options: [{ id: "gpt", label: "GPT" }],
          prompt: "Choose model",
          sessionId: "session_1",
          subject: "model",
        },
        timestamp: 1_000,
      },
    ]);
  });

  it("resolves a pending response and publishes resolved events", async () => {
    const bus = createBus();
    const events: unknown[] = [];
    bus.subscribe(InteractionEvent.Resolved, (event) => {
      events.push(event);
    });
    const broker = createInteractionBroker({
      bus,
      createInteractionId: () => "interaction_1",
      now: () => 1_000,
    });
    const responsePromise = broker.request(
      {
        kind: "select-one",
        options: [{ id: "gpt", label: "GPT" }],
        subject: "model",
      },
      { clientInvocationId: "inv_1", commandRunId: "cmd_1" },
    );

    await broker.respond("interaction_1", {
      choiceId: "gpt",
      kind: "accepted",
    });

    await expect(responsePromise).resolves.toEqual({
      choiceId: "gpt",
      kind: "accepted",
    });
    expect(broker.listPending()).toEqual([]);
    expect(events).toEqual([
      {
        commandRunId: "cmd_1",
        clientInvocationId: "inv_1",
        interactionId: "interaction_1",
        response: { choiceId: "gpt", kind: "accepted" },
        timestamp: 1_000,
      },
    ]);
  });

  it("rejects duplicate responses", async () => {
    const broker = createInteractionBroker({
      bus: createBus(),
      createInteractionId: () => "interaction_1",
    });
    void broker.request(
      { kind: "confirm", subject: "abort-test" },
      { commandRunId: "cmd_1" },
    );

    await broker.respond("interaction_1", {
      kind: "accepted",
      value: true,
    });

    await expect(
      broker.respond("interaction_1", {
        kind: "accepted",
        value: true,
      }),
    ).rejects.toMatchObject({
      code: "INTERACTION_NOT_FOUND",
    });
  });

  it("rejects response shapes that do not match the request kind", async () => {
    const broker = createInteractionBroker({
      bus: createBus(),
      createInteractionId: () => "interaction_1",
    });
    void broker.request(
      { kind: "select-one", subject: "model" },
      { commandRunId: "cmd_1" },
    );

    await expect(
      broker.respond("interaction_1", {
        kind: "accepted",
        value: "not-a-choice-id",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INTERACTION_RESPONSE",
    });
  });

  it("aborts pending interactions by command run", async () => {
    const broker = createInteractionBroker({
      bus: createBus(),
      createInteractionId: createSequence("interaction"),
    });
    const first = broker.request(
      { kind: "confirm", subject: "first" },
      { commandRunId: "cmd_1" },
    );
    const second = broker.request(
      { kind: "confirm", subject: "second" },
      { commandRunId: "cmd_2" },
    );

    expect(broker.abortByCommandRun("cmd_1", "aborted")).toBe(1);

    await expect(first).resolves.toEqual({
      kind: "cancelled",
      reason: "aborted",
    });
    expect(broker.listPending().map((entry) => entry.commandRunId)).toEqual([
      "cmd_2",
    ]);

    await broker.respond("interaction_2", { kind: "accepted", value: true });
    await expect(second).resolves.toEqual({ kind: "accepted", value: true });
  });

  it("aborts all pending interactions", async () => {
    const broker = createInteractionBroker({
      bus: createBus(),
      createInteractionId: createSequence("interaction"),
    });
    const first = broker.request(
      { kind: "confirm", subject: "first" },
      { commandRunId: "cmd_1" },
    );
    const second = broker.request(
      { kind: "confirm", subject: "second" },
      { commandRunId: "cmd_2" },
    );

    expect(broker.abortAll("daemon-stopping")).toBe(2);

    await expect(first).resolves.toEqual({
      kind: "cancelled",
      reason: "daemon-stopping",
    });
    await expect(second).resolves.toEqual({
      kind: "cancelled",
      reason: "daemon-stopping",
    });
    expect(broker.listPending()).toEqual([]);
  });
});

function createSequence(prefix: string): () => string {
  let next = 1;
  return () => {
    const id = `${prefix}_${String(next)}`;
    next += 1;
    return id;
  };
}
