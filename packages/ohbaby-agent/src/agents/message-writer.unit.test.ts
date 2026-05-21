import { describe, expect, it, vi } from "vitest";
import { createSubagentMessageWriter } from "./message-writer.js";
import type { CoreMessage, Part } from "../core/message/index.js";

function message(
  input: Pick<CoreMessage, "id" | "role" | "sessionId">,
): CoreMessage {
  if (input.role === "user") {
    return {
      agent: "explore",
      id: input.id,
      role: "user",
      sessionId: input.sessionId,
      time: { created: 1 },
    };
  }
  return {
    agent: "explore",
    id: input.id,
    role: "assistant",
    sessionId: input.sessionId,
    time: { created: 1 },
  };
}

const textPart: Part = {
  id: "part",
  messageId: "message",
  orderIndex: 0,
  sessionId: "child",
  text: "text",
  type: "text",
};

describe("createSubagentMessageWriter", () => {
  it("writes child user prompts and returns the created message id", async () => {
    const createMessage = vi.fn(() =>
      Promise.resolve(
        message({ id: "message_user", role: "user", sessionId: "child" }),
      ),
    );
    const appendPart = vi.fn(() => Promise.resolve(textPart));
    const writer = createSubagentMessageWriter({
      appendPart,
      createMessage,
      updateMessage: vi.fn(),
    });

    await expect(
      writer.writeUserMessage({
        agentName: "explore",
        parentSessionId: "parent",
        prompt: "Find auth code",
        sessionId: "child",
      }),
    ).resolves.toEqual({ messageId: "message_user" });

    expect(createMessage).toHaveBeenCalledWith({
      agent: "explore",
      role: "user",
      sessionId: "child",
    });
    expect(appendPart).toHaveBeenCalledWith("message_user", {
      text: "Find auth code",
      type: "text",
    });
  });

  it("writes assistant error turns linked to the child user message", async () => {
    const createMessage = vi.fn(() =>
      Promise.resolve(
        message({
          id: "message_assistant",
          role: "assistant",
          sessionId: "child",
        }),
      ),
    );
    const appendPart = vi.fn(() => Promise.resolve(textPart));
    const updateMessage = vi.fn(() =>
      Promise.resolve(
        message({
          id: "message_assistant",
          role: "assistant",
          sessionId: "child",
        }),
      ),
    );
    const writer = createSubagentMessageWriter({
      appendPart,
      createMessage,
      updateMessage,
    });

    await writer.writeAssistantMessage?.({
      agentName: "explore",
      output: "child failed",
      parentMessageId: "message_user",
      parentSessionId: "parent",
      sessionId: "child",
    });

    expect(createMessage).toHaveBeenCalledWith({
      agent: "explore",
      parentId: "message_user",
      role: "assistant",
      sessionId: "child",
    });
    expect(appendPart).toHaveBeenCalledWith("message_assistant", {
      text: "child failed",
      type: "text",
    });
    expect(updateMessage).toHaveBeenCalledWith("message_assistant", {
      error: {
        message: "child failed",
        name: "Unknown",
      },
      finish: "error",
    });
  });
});
