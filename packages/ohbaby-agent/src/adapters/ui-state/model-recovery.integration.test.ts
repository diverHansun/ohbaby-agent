/* eslint-disable @typescript-eslint/require-await -- Read-only fixture callbacks implement the asynchronous projection contract. */
import { describe, expect, it } from "vitest";
import {
  applySessionChange,
  type UiSessionChangedEvent,
  type UiSession,
  type UiPromptSubmission,
  type UiRun,
} from "ohbaby-sdk";
import { createBus } from "../../bus/index.js";
import {
  createMessageManager,
  createInMemoryMessageStore,
} from "../../core/message/index.js";
import { SourceSessionProjection } from "./source-session-projection.js";

describe("model observation recovery", () => {
  it("reconstructs the same zero-part activity from saved facts and live revisions, excluding child scope and ended attempts", async () => {
    const manager = createMessageManager({
      bus: createBus(),
      store: createInMemoryMessageStore(),
    });
    const events: UiSessionChangedEvent[] = [];
    const runs: UiRun[] = [
      {
        id: "run",
        sessionId: "s",
        status: { kind: "running", runId: "run" },
        startedAt: "2026",
        updatedAt: "2026",
      },
    ];
    const options: ConstructorParameters<typeof SourceSessionProjection>[0] = {
      runtimeEpoch: "e",
      messageManager: manager,
      metadata: async () => ({
        id: "s",
        title: "s",
        createdAt: "2026",
        updatedAt: "2026",
      }),
      currentRuns: async () => runs,
      runsByIds: async () => runs,
      prompts: async () => [],
      publish: (
        event: Parameters<
          ConstructorParameters<typeof SourceSessionProjection>[0]["publish"]
        >[0],
      ) => {
        if (event.type === "session.changed") events.push(event);
      },
    };
    const source = new SourceSessionProjection(options);
    await source.owner.initialize("s");
    const seed = source.owner.read("s");
    const message = await manager.createMessage({
      role: "assistant",
      agent: "default",
      runId: "run",
      sessionId: "s",
    });
    const request = {
      requestId: "r",
      runId: "run",
      messageId: message.id,
      step: 1,
      attempt: 1,
      purpose: "agent-step" as const,
      startedAt: 100,
      outcome: "running" as const,
    };
    await manager.updateMessage(message.id, { modelRequests: [request] });
    const child = await manager.createMessage({
      role: "assistant",
      agent: "child",
      runId: "child-run",
      sessionId: "s",
      contextScopeId: "child",
    });
    await manager.updateMessage(child.id, {
      modelRequests: [
        {
          ...request,
          requestId: "child-r",
          runId: "child-run",
          messageId: child.id,
          firstTextAt: 110,
        },
      ],
    });
    expect(source.owner.read("s").runs[0].modelActivity).toEqual({
      ...request,
      phase: "requesting",
      waitingStartedAt: 100,
    });
    expect(
      source.owner.read("s").session.messages.map((value) => value.id),
    ).toEqual([message.id]);
    let replay = seed;
    for (const event of events) {
      const next = applySessionChange(replay, event);
      if (!next) throw new Error("Expected consecutive session revision");
      replay = next;
    }
    expect(replay).toEqual(source.owner.read("s"));
    const recovered = new SourceSessionProjection(options);
    await recovered.owner.initialize("s");
    expect(recovered.owner.read("s").runs).toEqual(source.owner.read("s").runs);
    await manager.updateMessage(message.id, {
      modelRequests: [{ ...request, endedAt: 200, outcome: "error" }],
    });
    expect(recovered.owner.read("s").runs[0].modelActivity).toBeUndefined();
    await manager.updateMessage(message.id, {
      modelRequests: [{ ...request, firstTextAt: 300 }],
    });
    expect(recovered.owner.read("s").runs[0].modelActivity).toBeUndefined();
    expect(
      recovered.owner.read("s").session.messages[0].modelRequests?.[0],
    ).toMatchObject({ endedAt: 200, outcome: "error" });
    await manager.updateMessage(message.id, {
      modelRequests: [
        { ...request, requestId: "retry", attempt: 2, startedAt: 400 },
      ],
    });
    expect(recovered.owner.read("s").runs[0].modelActivity).toMatchObject({
      requestId: "retry",
      startedAt: 400,
      attempt: 2,
    });
    expect(recovered.owner.read("s").runs).toHaveLength(1);
    expect(
      applySessionChange(recovered.owner.read("s"), events[0]),
    ).toBeUndefined();
  });

  it.each(["reasoning", "text", "tool"] as const)(
    "recovers retry waiting and publishes one activity change for %s progress",
    async (progress) => {
      const manager = createMessageManager({
        bus: createBus(),
        store: createInMemoryMessageStore(),
      });
      const events: UiSessionChangedEvent[] = [];
      const run: UiRun = {
        id: "run",
        sessionId: "s",
        status: { kind: "running", runId: "run" },
        startedAt: "2026",
        updatedAt: "2026",
      };
      const source = new SourceSessionProjection({
        runtimeEpoch: "e",
        messageManager: manager,
        metadata: async (): Promise<Omit<UiSession, "messages">> => ({
          id: "s",
          title: "s",
          createdAt: "2026",
          updatedAt: "2026",
        }),
        currentRuns: async (): Promise<readonly UiRun[]> => [run],
        runsByIds: async (): Promise<readonly UiRun[]> => [run],
        prompts: async (): Promise<readonly UiPromptSubmission[]> => [],
        publish: (event): void => {
          if (event.type === "session.changed") events.push(event);
        },
      });
      try {
        await source.owner.initialize("s");
        const message = await manager.createMessage({
          role: "assistant",
          agent: "default",
          runId: "run",
          sessionId: "s",
        });
        const failed = {
          requestId: "first",
          runId: "run",
          messageId: message.id,
          step: 1,
          attempt: 1,
          purpose: "agent-step" as const,
          startedAt: 100,
          endedAt: 150,
          outcome: "error" as const,
          retryScheduled: true as const,
        };
        await manager.updateMessage(message.id, { modelRequests: [failed] });
        const waiting = source.owner.read("s").runs[0].modelActivity;
        expect(waiting).toMatchObject({
          requestId: "first",
          outcome: "error",
          endedAt: 150,
          phase: "retrying",
          waitingStartedAt: 100,
        });
        await source.owner.rebuild("s");
        expect(source.owner.read("s").runs[0].modelActivity).toEqual(waiting);
        const seed = source.owner.read("s");
        events.length = 0;
        const retry = {
          ...failed,
          requestId: "retry",
          attempt: 2,
          startedAt: 200,
          endedAt: undefined,
          outcome: "running" as const,
          retryScheduled: undefined,
        };
        await manager.updateMessage(message.id, { modelRequests: [retry] });
        expect(source.owner.read("s").runs[0].modelActivity).toMatchObject({
          requestId: "retry",
          phase: "retrying",
          waitingStartedAt: 100,
        });
        const beforeProgress = events.length;
        if (progress === "reasoning") {
          const identity = {
            sessionId: "s",
            messageId: message.id,
            partId: "reasoning",
          };
          await source.reasoning.update(identity, "Thinking");
          await source.reasoning.update(identity, "Thinking further");
          expect((await manager.listBySession("s"))[0].parts).toEqual([]);
        } else if (progress === "text") {
          const part = await manager.appendPart(message.id, {
            type: "text",
            text: "Answer",
          });
          await manager.updatePart(part.id, { text: "Answer continues" });
        } else {
          const part = await manager.appendPart(message.id, {
            type: "tool",
            tool: "bash",
            callId: "call",
            state: { status: "pending", input: {}, raw: "{}" },
          });
          await manager.updatePart(part.id, {
            state: { status: "running", input: {} },
          });
        }
        expect(source.owner.read("s").runs[0].modelActivity).toMatchObject({
          requestId: "retry",
          phase: "requesting",
          waitingStartedAt: 100,
        });
        expect(
          events.slice(beforeProgress).filter((event) => event.runs),
        ).toHaveLength(1);
        let replay = seed;
        for (const event of events) {
          const next = applySessionChange(replay, event);
          if (!next) throw new Error("Expected consecutive session revision");
          replay = next;
        }
        expect(replay).toEqual(source.owner.read("s"));
        await source.commitEvent({
          type: "run.updated",
          run: { ...run, status: { kind: "idle" }, outcome: "cancelled" },
        });
        expect(source.owner.read("s").runs[0].modelActivity).toBeUndefined();
      } finally {
        source.reasoning.dispose();
        source.owner.dispose();
      }
    },
  );
});
