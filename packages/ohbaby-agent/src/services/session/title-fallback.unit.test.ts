import { describe, expect, it } from "vitest";
import type { MessageWithParts } from "../../core/message/index.js";
import { createFallbackSessionTitleFromMessages } from "./title-fallback.js";

describe("fallback session title", () => {
  it("ignores model-only runtime context attached to the user turn", () => {
    const message: MessageWithParts = {
      info: {
        agent: "build",
        id: "user_1",
        role: "user",
        sessionId: "session_1",
        time: { created: 1 },
      },
      parts: [
        {
          id: "part_user",
          messageId: "user_1",
          orderIndex: 0,
          sessionId: "session_1",
          text: "Fix the cache prefix",
          type: "text",
        },
        {
          id: "part_runtime",
          messageId: "user_1",
          metadata: { kind: "model-context:runtime:v1" },
          orderIndex: 1,
          sessionId: "session_1",
          synthetic: true,
          text: "<environment_context>/secret/path</environment_context>",
          type: "text",
        },
      ],
    };

    expect(createFallbackSessionTitleFromMessages([message])).toBe(
      "Fix the cache prefix",
    );
  });
});
