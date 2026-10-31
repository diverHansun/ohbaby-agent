import { describe, expect, it, vi } from "vitest";
import type {
  UiMessage,
  UiPromptSubmission,
  UiRun,
  UiSession,
} from "ohbaby-sdk";
import { createBus } from "../../bus/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../../core/message/index.js";
import { ensureInterruptionFact } from "../../core/message/interruption.js";
import { messageToUiMessage } from "./persistent-store.js";
import { SourceSessionProjection } from "./source-session-projection.js";

describe("interruption display ordering", () => {
  it.each([
    { contextScopeId: undefined, body: "saved body" },
    { contextScopeId: undefined, body: "" },
    { contextScopeId: "child", body: "saved body" },
    { contextScopeId: "child", body: "" },
  ])(
    "keeps the notice last with pending reasoning: %j",
    async ({ contextScopeId, body }): Promise<void> => {
      const manager = createMessageManager({
        bus: createBus(),
        store: createInMemoryMessageStore(),
      });
      const message = await manager.createMessage({
        sessionId: "session",
        contextScopeId,
        role: "assistant",
        agent: "default",
      });
      if (message.role !== "assistant") throw new Error("Expected assistant");
      if (body)
        await manager.appendPart(message.id, {
          type: "text",
          text: body,
          metadata: { sourceOrder: 8 },
        });
      let releaseSave!: () => void;
      const saveGate = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      const saveReasoning = manager.saveReasoningPart.bind(manager);
      vi.spyOn(manager, "saveReasoningPart").mockImplementation(
        async (part): ReturnType<typeof manager.saveReasoningPart> => {
          await saveGate;
          return saveReasoning(part);
        },
      );
      const source = new SourceSessionProjection({
        runtimeEpoch: "epoch",
        messageManager: manager,
        metadata: (id): Promise<Omit<UiSession, "messages">> =>
          Promise.resolve({
            id,
            title: id,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          }),
        runs: (): Promise<readonly UiRun[]> => Promise.resolve([]),
        prompts: (): Promise<readonly UiPromptSubmission[]> =>
          Promise.resolve([]),
        publish: (): void => undefined,
      });
      const text = (
        projected: UiMessage | undefined,
      ): readonly (string | undefined)[] =>
        (projected?.parts ?? []).map((part) =>
          "text" in part ? part.text : undefined,
        );
      const read = async (): Promise<UiMessage | undefined> => {
        const [record] = await manager.listBySession("session", {
          contextScopeId,
        });
        return contextScopeId
          ? source.projectComplete(record)
          : source.owner.read("session").session.messages[0];
      };
      try {
        await source.owner.initialize("session");
        await source.reasoning.update(
          {
            sessionId: "session",
            contextScopeId,
            messageId: message.id,
            partId: "reasoning",
            metadata: { sourceOrder: 7 },
          },
          "saved thought",
        );
        await source.reasoning.finish("reasoning", "interrupted");
        await ensureInterruptionFact(manager, message, "MessageAbortedError");
        const expected = [
          "saved thought",
          ...(body ? [body] : []),
          "[Response cancelled by the user.]",
        ];
        expect(text(await read())).toEqual(expected);
        releaseSave();
        await vi.waitFor(async (): Promise<void> => {
          const [record] = await manager.listBySession("session", {
            contextScopeId,
          });
          expect(record.parts.some((part) => part.type === "reasoning")).toBe(
            true,
          );
          expect(source.reasoning.pendingPartIds("session")).toEqual([]);
          expect(text(await read())).toEqual(expected);
        });
        const [saved] = await manager.listBySession("session", {
          contextScopeId,
        });
        // Reloaded history has no live reasoning owner, including old notices
        // without sourceOrder and reasoning persisted after the notice.
        expect(text(messageToUiMessage(saved))).toEqual(expected);
      } finally {
        releaseSave();
        source.reasoning.dispose();
      }
    },
  );
});
