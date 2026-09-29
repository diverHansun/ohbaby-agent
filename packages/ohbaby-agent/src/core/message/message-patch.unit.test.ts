import { expect, it } from "vitest";
import { applyMessagePatch } from "./message-patch.js";
import type { AssistantMessage } from "./types.js";
const request = {
  requestId: "request",
  runId: "run",
  messageId: "message",
  step: 1,
  attempt: 1,
  purpose: "agent-step",
  startedAt: 1,
  outcome: "running" as const,
};
const message: AssistantMessage = {
  id: "message",
  runId: "run",
  sessionId: "session",
  role: "assistant",
  agent: "primary",
  time: { created: 1 },
  modelRequests: [{ ...request, inputIds: ["input-a"] }],
};
it("keeps frozen input membership through later provider observations", () => {
  const updated = applyMessagePatch(message, {
    modelRequests: [{ ...request, endedAt: 2, outcome: "success" }],
  });
  expect(
    updated.role === "assistant" && updated.modelRequests?.[0].inputIds,
  ).toEqual(["input-a"]);
  const explicitUndefined = applyMessagePatch(message, {
    modelRequests: [{ ...request, inputIds: undefined }],
  });
  expect(
    explicitUndefined.role === "assistant" &&
      explicitUndefined.modelRequests?.[0].inputIds,
  ).toEqual(["input-a"]);
});
it("rejects replacement of request membership even after request completion", () => {
  expect(() =>
    applyMessagePatch(message, {
      modelRequests: [{ ...request, inputIds: ["input-a", "late-b"] }],
    }),
  ).toThrow("membership");
  const ended = applyMessagePatch(message, {
    modelRequests: [{ ...request, endedAt: 2, outcome: "success" }],
  });
  expect(() =>
    applyMessagePatch(ended, { modelRequests: [{ ...request, inputIds: [] }] }),
  ).toThrow("membership");
});
