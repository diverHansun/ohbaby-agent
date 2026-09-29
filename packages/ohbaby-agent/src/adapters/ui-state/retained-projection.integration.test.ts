import { describe, expect, it } from "vitest";
import {
  applySessionChange,
  type UiPromptSubmission,
  type UiSessionChangedEvent,
  type UiSession,
  type UiRun,
} from "ohbaby-sdk";
import { createBus } from "../../bus/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../../core/message/index.js";
import { SourceSessionProjection } from "./source-session-projection.js";

describe("retained prompt source projection", () => {
  it("keeps unmaterialized retained siblings through lease, resubmit, and delete events", async () => {
    const prompts: UiPromptSubmission[] = ["b", "c"].map((id) => ({
      promptId: id,
      clientRequestId: id,
      userMessageId: `message-${id}`,
      sessionId: "s",
      scopeKey: "/repo",
      text: id,
      status: "retained",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }));
    const events: UiSessionChangedEvent[] = [];
    const source = new SourceSessionProjection({
      runtimeEpoch: "epoch",
      messageManager: createMessageManager({
        bus: createBus(),
        store: createInMemoryMessageStore(),
      }),
      metadata: (id): Promise<Omit<UiSession, "messages">> =>
        Promise.resolve({
          id,
          title: id,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        }),
      runs: (): Promise<readonly UiRun[]> => Promise.resolve([]),
      prompts: (): Promise<readonly UiPromptSubmission[]> =>
        Promise.resolve(prompts),
      publish: (event): void => {
        if (event.type === "session.changed") events.push(event);
      },
    });
    await source.owner.initialize("s");
    let replay = source.owner.read("s");
    expect(replay.session.messages).toEqual([]);
    expect(replay.runs).toEqual([]);
    await source.commitEvent({
      type: "prompt.updated",
      prompt: {
        ...prompts[0],
        editLeaseOwnerId: "client",
        editLeaseExpiresAt: "2026-01-01T00:01:00Z",
      },
    });
    expect(
      source.owner
        .read("s")
        .prompts.map((p) => p.promptId)
        .sort(),
    ).toEqual(["b", "c"]);
    await source.commitEvent({
      type: "prompt.updated",
      prompt: {
        ...prompts[0],
        text: "b resent",
        status: "queued",
        acceptedAt: "2026-01-01T00:02:00Z",
        admissionOrder: 3,
      },
    });
    expect(
      source.owner.read("s").prompts.find((p) => p.promptId === "c")?.status,
    ).toBe("retained");
    await source.commitEvent({
      type: "prompt.updated",
      prompt: {
        ...prompts[0],
        status: "cancelled",
        endedAt: "2026-01-01T00:03:00Z",
      },
    });
    expect(source.owner.read("s").prompts.map((p) => p.promptId)).toEqual([
      "c",
    ]);
    for (const event of events) {
      const next = applySessionChange(replay, event);
      if (!next) throw new Error("Expected consecutive session revision");
      replay = next;
    }
    expect(replay).toEqual(source.owner.read("s"));
  });
});
