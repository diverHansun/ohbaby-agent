import { expect, it, vi } from "vitest";
import { resubmitRetainedPromptForClient } from "./prompt-backend.js";
import type { UiSnapshot } from "ohbaby-sdk";

it("owns a retained re-admission before it can emit runtime events and releases after completion", async () => {
  const input = {
    promptId: "p",
    editLeaseId: "lease",
    operationId: "op",
    text: "edited",
  };
  const receipt = {
    operationId: "op",
    promptId: "p",
    userMessageId: "u",
    sessionId: "s",
    acceptedAt: 1,
  };
  const snapshot: UiSnapshot = {
    activeSessionId: "s",
    sessions: [],
    permissions: [],
    runs: [],
    status: { kind: "idle" },
    prompts: [
      {
        promptId: "p",
        clientRequestId: "old",
        userMessageId: "u",
        scopeKey: "scope",
        sessionId: "s",
        text: "old",
        status: "retained",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ],
  };
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<never>((_resolve, reject) => {
    rejectCompletion = reject;
  });
  const views = { promptStarted: vi.fn(), promptSettled: vi.fn() };
  const backend = {
    getSnapshot: (): Promise<UiSnapshot> => Promise.resolve(snapshot),
    waitForPrompt: vi.fn(() => completion),
    resubmitRetainedPromptForOwner: vi.fn(() => {
      expect(views.promptStarted).toHaveBeenCalledWith({
        clientId: "trusted",
        sessionId: "s",
        text: "edited",
      });
      return Promise.resolve(receipt);
    }),
  };
  await expect(
    resubmitRetainedPromptForClient(backend, input, "trusted", views),
  ).resolves.toEqual(receipt);
  expect(backend.resubmitRetainedPromptForOwner).toHaveBeenCalledWith(
    input,
    "trusted",
  );
  expect(views.promptSettled).not.toHaveBeenCalled();
  rejectCompletion(new Error("runtime disposed"));
  await completion.catch(() => undefined);
  await Promise.resolve();
  expect(views.promptSettled).toHaveBeenCalledOnce();
  backend.resubmitRetainedPromptForOwner.mockRejectedValueOnce(
    new Error("QUEUE_FULL"),
  );
  await expect(
    resubmitRetainedPromptForClient(backend, input, "trusted", views),
  ).rejects.toThrow("QUEUE_FULL");
  expect(views.promptSettled).toHaveBeenCalledTimes(2);
});
