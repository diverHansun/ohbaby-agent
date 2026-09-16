import { describe, expect, it } from "vitest";
import { MessageEvent } from "./events.js";

describe("persisted interruption errors", () => {
  it.each(["MessageContentFilterError", "MessageStreamInterruptedError"])(
    "preserves %s through the event boundary",
    (name) => {
      const info = {
        id: "assistant",
        sessionId: "session",
        role: "assistant",
        agent: "test",
        time: { created: 1, completed: 2 },
        finish: "error",
        error: { name },
      };
      expect(MessageEvent.Updated.schema.parse({ info })).toEqual({ info });
    },
  );
});
