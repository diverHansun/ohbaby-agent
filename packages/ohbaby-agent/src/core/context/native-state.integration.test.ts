import { describe, expect, it } from "vitest";
import { serializeHistoryMessages } from "./serializer.js";
import type { MessageWithParts } from "../message/types.js";

const state = {
  version: 1,
  origin: {
    provider: "openai",
    model: "gpt-5.6-luna",
    protocol: "openai-responses",
    endpoint: "https://api.openai.com/v1",
  },
  output: {
    protocol: "openai-responses",
    items: [
      { type: "reasoning", id: "r1", summary: [], encrypted_content: "opaque" },
    ],
  },
  estimate: { tokens: 80, source: "reasoning" },
};
function history(): MessageWithParts[] {
  return [
    {
      info: {
        id: "m1",
        role: "assistant",
        agent: "test",
        sessionId: "s",
        time: { created: 1, completed: 2 },
        finish: "stop",
      },
      parts: [
        {
          id: "p1",
          messageId: "m1",
          sessionId: "s",
          orderIndex: 0,
          type: "model-state",
          modelState: state,
        },
      ],
    },
  ] as unknown as MessageWithParts[];
}
describe("native continuation history", () => {
  it("retains reasoning-only accepted state for the next user Run", () => {
    expect(serializeHistoryMessages(history())).toEqual([
      { role: "assistant", content: null, modelState: state },
    ]);
  });
  it("never revives compacted native state", () => {
    const messages = history();
    messages[0] = {
      ...messages[0],
      parts: messages[0].parts.map((part) => ({
        ...part,
        time: { compacted: 3 },
      })),
    };
    expect(serializeHistoryMessages(messages)).toEqual([]);
  });
  it("does not replay an uncommitted native collection", () => {
    const messages = history();
    messages[0] = {
      ...messages[0],
      info: { ...messages[0].info, time: { created: 1 } },
    };
    expect(serializeHistoryMessages(messages)).toEqual([]);
  });
});
