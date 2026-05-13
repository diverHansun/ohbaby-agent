import { streamChatCompletion } from "../llm-client/index.js";
import type { ChatCompletionMessage } from "../llm-client/index.js";
import type { CoreMessage, Part } from "../message/index.js";
import type {
  LifecycleDeps,
  LifecycleEvent,
  LifecycleResult,
  LifecycleRunParams,
} from "./types.js";

function getTextContent(message: ChatCompletionMessage): string {
  const { content } = message;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if ("text" in part && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .join("");
  }

  return "";
}

function toUsage(
  tokenUsage: LifecycleEvent & { type: "llm:complete" },
): LifecycleResult["usage"] {
  if (!tokenUsage.tokenUsage) {
    return undefined;
  }

  return {
    inputTokens: tokenUsage.tokenUsage.prompt_tokens,
    outputTokens: tokenUsage.tokenUsage.completion_tokens,
    totalTokens: tokenUsage.tokenUsage.total_tokens,
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export class Lifecycle {
  private readonly deps: LifecycleDeps;

  constructor(deps: LifecycleDeps) {
    this.deps = deps;
  }

  async *run(
    params: LifecycleRunParams,
  ): AsyncGenerator<LifecycleEvent, LifecycleResult, void> {
    yield {
      type: "llm:start",
      sessionId: params.sessionId,
      timestamp: Date.now(),
    };

    let finalEvent:
      | Extract<LifecycleEvent, { type: "llm:complete" }>
      | undefined;
    let previousContent = "";
    let assistantMessage: CoreMessage | undefined;
    let assistantTextPart: Part | undefined;

    async function markAssistantMessageError(
      messageManager: LifecycleDeps["messageManager"],
      message: CoreMessage | undefined,
      error: unknown,
    ): Promise<void> {
      if (!messageManager || message?.role !== "assistant") {
        return;
      }
      await messageManager.updateMessage(message.id, {
        finish: "error",
        error: {
          name: "Unknown",
          message: getErrorMessage(error),
        },
        time: {
          ...message.time,
          completed: Date.now(),
        },
      });
    }

    if (this.deps.messageManager) {
      assistantMessage = await this.deps.messageManager.createMessage({
        sessionId: params.sessionId,
        role: "assistant",
        agent: params.agent ?? "default",
        parentId: params.parentMessageId,
      });
    }

    try {
      for await (const response of streamChatCompletion(
        this.deps.llmClient,
        [...params.messages],
        {
          signal: params.signal,
          tools: params.tools,
        },
      )) {
        const content = getTextContent(response.completeMessage);

        if (content !== "") {
          const delta = content.startsWith(previousContent)
            ? content.slice(previousContent.length)
            : content;
          previousContent = content;

          if (this.deps.messageManager && assistantMessage) {
            if (assistantTextPart) {
              assistantTextPart = await this.deps.messageManager.updatePart(
                assistantTextPart.id,
                {
                  text: content,
                  delta,
                },
              );
            } else {
              assistantTextPart = await this.deps.messageManager.appendPart(
                assistantMessage.id,
                {
                  type: "text",
                  text: content,
                },
              );
            }
          }

          yield {
            type: "llm:delta",
            sessionId: params.sessionId,
            timestamp: Date.now(),
            delta,
            content,
            completeMessage: response.completeMessage,
          };
        }

        if (response.isComplete) {
          finalEvent = {
            type: "llm:complete",
            sessionId: params.sessionId,
            timestamp: Date.now(),
            finishReason: response.finishReason,
            completeMessage: response.completeMessage,
            parsedToolCalls: response.parsedToolCalls,
            tokenUsage: response.tokenUsage,
          };
          yield finalEvent;
        }
      }
    } catch (error) {
      await markAssistantMessageError(
        this.deps.messageManager,
        assistantMessage,
        error,
      );
      throw error;
    }

    if (!finalEvent) {
      await markAssistantMessageError(
        this.deps.messageManager,
        assistantMessage,
        new Error("Lifecycle did not complete successfully"),
      );
      return {
        success: false,
        finishReason: "error",
        finalResponse: "",
      };
    }

    if (this.deps.messageManager && assistantMessage) {
      await this.deps.messageManager.updateMessage(assistantMessage.id, {
        finish: finalEvent.finishReason,
        time: {
          ...assistantMessage.time,
          completed: Date.now(),
        },
      });
    }

    return {
      success: true,
      finishReason: finalEvent.finishReason ?? "stop",
      finalResponse: getTextContent(finalEvent.completeMessage),
      toolCalls: finalEvent.parsedToolCalls,
      usage: toUsage(finalEvent),
    };
  }
}
