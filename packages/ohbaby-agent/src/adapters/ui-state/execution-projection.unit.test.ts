import { describe, it, expect } from "vitest";
import { messageToUiMessage } from "./persistent-store.js";
import type { MessageWithParts } from "../../core/message/types.js";
const request = {
  requestId: "r",
  runId: "run",
  messageId: "m",
  step: 1,
  attempt: 1,
  purpose: "agent-step",
  startedAt: 100,
  outcome: "running" as const,
};
describe("durable execution projection", () => {
  it("retains model activity on zero-part assistant messages", () => {
    const record: MessageWithParts = {
      info: {
        id: "m",
        sessionId: "s",
        role: "assistant",
        agent: "default",
        runId: "run",
        time: { created: 100 },
        modelRequests: [request],
      },
      parts: [],
    };
    expect(messageToUiMessage(record)).toMatchObject({
      id: "m",
      modelRequests: [request],
    });
  });
  it("projects exact tool admission and cleanup without inventing execution start", () => {
    const execution = {
      runId: "run",
      phase: "queued" as const,
      createdAt: 100,
      phaseStartedAt: 200,
      waitReason: "resource" as const,
    };
    const record: MessageWithParts = {
      info: {
        id: "m",
        sessionId: "s",
        role: "assistant",
        agent: "default",
        runId: "run",
        time: { created: 100 },
      },
      parts: [
        {
          id: "p",
          messageId: "m",
          sessionId: "s",
          orderIndex: 0,
          type: "tool",
          callId: "call",
          tool: "bash",
          state: { status: "pending", input: {}, raw: "{}" },
          metadata: { execution },
        },
      ],
    };
    expect(messageToUiMessage(record)?.parts[0]).toMatchObject({
      call: { status: "pending", execution },
    });
  });
});
