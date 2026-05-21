import type { MessageManager } from "../core/message/index.js";
import type { SubagentMessageWriter } from "./types.js";

export function createSubagentMessageWriter(
  messageManager: Pick<
    MessageManager,
    "appendPart" | "createMessage" | "updateMessage"
  >,
): SubagentMessageWriter {
  return {
    async writeUserMessage(input): Promise<{ readonly messageId: string }> {
      const message = await messageManager.createMessage({
        agent: input.agentName,
        role: "user",
        sessionId: input.sessionId,
      });
      await messageManager.appendPart(message.id, {
        text: input.prompt,
        type: "text",
      });
      return { messageId: message.id };
    },

    async writeAssistantMessage(input): Promise<void> {
      const message = await messageManager.createMessage({
        agent: input.agentName,
        parentId: input.parentMessageId,
        role: "assistant",
        sessionId: input.sessionId,
      });
      await messageManager.appendPart(message.id, {
        text: input.output,
        type: "text",
      });
      await messageManager.updateMessage(message.id, {
        error: {
          message: input.output,
          name: "Unknown",
        },
        finish: "error",
      });
    },
  };
}
