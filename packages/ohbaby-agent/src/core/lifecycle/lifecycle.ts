import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions/completions";
import { streamChatCompletion } from "../llm-client/index.js";
import type {
  ChatCompletionMessage,
  ParsedToolCall,
  TokenUsage,
} from "../llm-client/index.js";
import type {
  CoreMessage,
  MessageManager,
  Part,
  ToolPart,
  ToolState,
} from "../message/index.js";
import type {
  ToolCallRequest,
  ToolCallResult,
} from "../tool-scheduler/index.js";
import type {
  LifecycleDeps,
  LifecycleEvent,
  LifecycleResult,
  LifecycleRunParams,
} from "./types.js";

const DEFAULT_MAX_STEPS = 8;

interface ResolvedToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly rawArguments: string;
}

interface StepResult {
  readonly assistantMessage?: CoreMessage;
  readonly finalEvent?: Extract<LifecycleEvent, { readonly type: "llm:complete" }>;
  readonly finalResponse: string;
}

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

function toUsage(tokenUsage: TokenUsage | undefined): LifecycleResult["usage"] {
  if (!tokenUsage) {
    return undefined;
  }

  return {
    inputTokens: tokenUsage.prompt_tokens,
    outputTokens: tokenUsage.completion_tokens,
    totalTokens: tokenUsage.total_tokens,
  };
}

function addUsage(
  left: LifecycleResult["usage"],
  right: LifecycleResult["usage"],
): LifecycleResult["usage"] {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }

  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function createDefaultToolCallId(): () => string {
  let nextId = 1;

  return () => {
    const id = `tool_call_${String(nextId)}`;
    nextId += 1;
    return id;
  };
}

function normalizeToolCalls(
  toolCalls: readonly ParsedToolCall[],
  generateToolCallId: () => string,
): ResolvedToolCall[] {
  return toolCalls.map((toolCall) => {
    const rawArguments = JSON.stringify(toolCall.arguments);

    return {
      arguments: toolCall.arguments,
      id: toolCall.id.trim() === "" ? generateToolCallId() : toolCall.id,
      name: toolCall.name,
      rawArguments,
    };
  });
}

function toAssistantToolMessage(input: {
  readonly completeMessage: ChatCompletionMessage;
  readonly toolCalls: readonly ResolvedToolCall[];
}): ChatCompletionAssistantMessageParam {
  const content = getTextContent(input.completeMessage);

  return {
    role: "assistant",
    content: content === "" ? null : content,
    tool_calls: input.toolCalls.map(
      (toolCall): ChatCompletionMessageToolCall => ({
        id: toolCall.id,
        function: {
          arguments: toolCall.rawArguments,
          name: toolCall.name,
        },
        type: "function",
      }),
    ),
  };
}

function toolResultErrorPayload(
  error: ToolCallResult["error"],
): Record<string, unknown> | undefined {
  if (!error) {
    return undefined;
  }

  if (error.details === undefined) {
    return {
      type: error.type,
      message: error.message,
    };
  }

  return {
    type: error.type,
    message: error.message,
    details: error.details,
  };
}

function toolResultToContent(result: ToolCallResult): string {
  if (
    result.status === "success" &&
    result.output !== undefined &&
    result.metadata === undefined
  ) {
    return result.output;
  }

  const payload: Record<string, unknown> = { status: result.status };
  if (result.output !== undefined) {
    payload.output = result.output;
  }
  if (result.error) {
    payload.error = toolResultErrorPayload(result.error);
  }
  if (result.metadata !== undefined) {
    payload.metadata = result.metadata;
  }

  return JSON.stringify(payload);
}

function toolResultToMessage(
  result: ToolCallResult,
): ChatCompletionToolMessageParam {
  return {
    role: "tool",
    content: toolResultToContent(result),
    tool_call_id: result.callId,
  };
}

function resultToToolState(
  result: ToolCallResult,
  input: Record<string, unknown>,
): ToolState {
  if (result.status === "success") {
    return {
      input,
      output: result.output ?? toolResultToContent(result),
      status: "completed",
    };
  }

  if (result.status === "cancelled") {
    return {
      error: "Tool execution aborted by user",
      input,
      status: "aborted",
    };
  }

  return {
    error: toolResultToContent(result),
    input,
    status: "error",
  };
}

function isToolPart(part: Part): part is ToolPart {
  return part.type === "tool";
}

async function markAssistantMessageError(
  messageManager: MessageManager | undefined,
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

export class Lifecycle {
  private readonly deps: LifecycleDeps;

  constructor(deps: LifecycleDeps) {
    this.deps = deps;
  }

  async *run(
    params: LifecycleRunParams,
  ): AsyncGenerator<LifecycleEvent, LifecycleResult, void> {
    const maxSteps = params.maxSteps ?? DEFAULT_MAX_STEPS;
    const conversationMessages: ChatCompletionMessage[] = [...params.messages];
    const generateToolCallId =
      this.deps.generateToolCallId ?? createDefaultToolCallId();
    let parentMessageId = params.parentMessageId;
    let usage: LifecycleResult["usage"];
    let finalResponse = "";
    const allToolCalls: ParsedToolCall[] = [];

    for (let step = 1; step <= maxSteps; step += 1) {
      if (params.signal?.aborted) {
        return {
          success: false,
          finishReason: "error",
          finalResponse,
          toolCalls: allToolCalls,
          usage,
        };
      }

      const stepResult = yield* this.runModelStep({
        conversationMessages,
        params,
        parentMessageId,
        step,
      });
      const { assistantMessage, finalEvent } = stepResult;
      finalResponse = stepResult.finalResponse;

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
          toolCalls: allToolCalls,
          usage,
        };
      }

      usage = addUsage(usage, toUsage(finalEvent.tokenUsage));
      const parsedToolCalls = finalEvent.parsedToolCalls ?? [];
      const shouldExecuteTools =
        finalEvent.finishReason === "tool_calls" || parsedToolCalls.length > 0;

      if (!shouldExecuteTools || parsedToolCalls.length === 0) {
        return {
          success: true,
          finishReason: finalEvent.finishReason ?? "stop",
          finalResponse,
          toolCalls:
            allToolCalls.length > 0 || parsedToolCalls.length > 0
              ? [...allToolCalls, ...parsedToolCalls]
              : undefined,
          usage,
        };
      }

      allToolCalls.push(...parsedToolCalls);
      const toolCalls = normalizeToolCalls(parsedToolCalls, generateToolCallId);
      const toolParts = await this.appendToolParts(assistantMessage, toolCalls);

      for (const toolCall of toolCalls) {
        await this.updateToolPart(toolParts.get(toolCall.id), {
          input: toolCall.arguments,
          status: "running",
        });
        yield {
          type: "tool:start",
          callId: toolCall.id,
          params: toolCall.arguments,
          sessionId: params.sessionId,
          step,
          timestamp: Date.now(),
          toolName: toolCall.name,
        };
      }

      const toolResults = await this.executeToolCalls({
        assistantMessage,
        params,
        step,
        toolCalls,
      });
      const resultByCallId = new Map(
        toolResults.map((result) => [result.callId, result] as const),
      );

      for (const toolCall of toolCalls) {
        const result = resultByCallId.get(toolCall.id);
        if (!result) {
          continue;
        }
        await this.updateToolPart(
          toolParts.get(toolCall.id),
          resultToToolState(result, toolCall.arguments),
        );
        yield {
          type: "tool:result",
          callId: result.callId,
          result,
          sessionId: params.sessionId,
          step,
          timestamp: Date.now(),
          toolName: toolCall.name,
        };
      }

      conversationMessages.push(
        toAssistantToolMessage({
          completeMessage: finalEvent.completeMessage,
          toolCalls,
        }),
        ...toolResults.map(toolResultToMessage),
      );
      yield {
        type: "step:complete",
        finishReason: finalEvent.finishReason,
        sessionId: params.sessionId,
        step,
        timestamp: Date.now(),
        toolResults,
      };

      parentMessageId = assistantMessage?.id ?? parentMessageId;

      if (params.signal?.aborted) {
        return {
          success: false,
          finishReason: "error",
          finalResponse,
          toolCalls: allToolCalls,
          usage,
        };
      }

      if (step === maxSteps) {
        return {
          success: false,
          finishReason: "error",
          finalResponse: "Maximum lifecycle tool steps reached",
          toolCalls: allToolCalls,
          usage,
        };
      }
    }

    return {
      success: false,
      finishReason: "error",
      finalResponse: "Maximum lifecycle tool steps reached",
      toolCalls: allToolCalls,
      usage,
    };
  }

  private async *runModelStep(input: {
    readonly conversationMessages: readonly ChatCompletionMessage[];
    readonly params: LifecycleRunParams;
    readonly parentMessageId?: string;
    readonly step: number;
  }): AsyncGenerator<LifecycleEvent, StepResult, void> {
    const { params, step } = input;
    let finalEvent:
      | Extract<LifecycleEvent, { readonly type: "llm:complete" }>
      | undefined;
    let previousContent = "";
    let assistantMessage: CoreMessage | undefined;
    let assistantTextPart: Part | undefined;

    yield {
      type: "llm:start",
      sessionId: params.sessionId,
      step,
      timestamp: Date.now(),
    };

    if (this.deps.messageManager) {
      assistantMessage = await this.deps.messageManager.createMessage({
        sessionId: params.sessionId,
        role: "assistant",
        agent: params.agent ?? "default",
        parentId: input.parentMessageId,
      });
    }

    try {
      for await (const response of streamChatCompletion(
        this.deps.llmClient,
        [...input.conversationMessages],
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
            completeMessage: response.completeMessage,
            content,
            delta,
            sessionId: params.sessionId,
            step,
            timestamp: Date.now(),
          };
        }

        if (response.isComplete) {
          finalEvent = {
            type: "llm:complete",
            completeMessage: response.completeMessage,
            finishReason: response.finishReason,
            parsedToolCalls: response.parsedToolCalls,
            sessionId: params.sessionId,
            step,
            timestamp: Date.now(),
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

    if (this.deps.messageManager && assistantMessage && finalEvent) {
      await this.deps.messageManager.updateMessage(assistantMessage.id, {
        finish: finalEvent.finishReason,
        time: {
          ...assistantMessage.time,
          completed: Date.now(),
        },
      });
    }

    return {
      assistantMessage,
      finalEvent,
      finalResponse: finalEvent ? getTextContent(finalEvent.completeMessage) : "",
    };
  }

  private async appendToolParts(
    assistantMessage: CoreMessage | undefined,
    toolCalls: readonly ResolvedToolCall[],
  ): Promise<Map<string, ToolPart>> {
    const toolParts = new Map<string, ToolPart>();
    if (!this.deps.messageManager || assistantMessage?.role !== "assistant") {
      return toolParts;
    }

    for (const toolCall of toolCalls) {
      const part = await this.deps.messageManager.appendPart(
        assistantMessage.id,
        {
          type: "tool",
          callId: toolCall.id,
          state: {
            input: toolCall.arguments,
            raw: toolCall.rawArguments,
            status: "pending",
          },
          tool: toolCall.name,
        },
      );
      if (isToolPart(part)) {
        toolParts.set(toolCall.id, part);
      }
    }

    return toolParts;
  }

  private async updateToolPart(
    part: ToolPart | undefined,
    state: ToolState,
  ): Promise<void> {
    if (!this.deps.messageManager || !part) {
      return;
    }
    await this.deps.messageManager.updatePart(part.id, { state });
  }

  private executeToolCalls(input: {
    readonly assistantMessage?: CoreMessage;
    readonly params: LifecycleRunParams;
    readonly step: number;
    readonly toolCalls: readonly ResolvedToolCall[];
  }): Promise<ToolCallResult[]> {
    const messageId =
      input.assistantMessage?.id ??
      input.params.parentMessageId ??
      `${input.params.sessionId}:assistant:${String(input.step)}`;
    const requests: ToolCallRequest[] = input.toolCalls.map((toolCall) => ({
      callId: toolCall.id,
      environment: input.params.environment,
      messageId,
      params: toolCall.arguments,
      sessionId: input.params.sessionId,
      signal: input.params.signal,
      toolName: toolCall.name,
    }));

    if (!this.deps.toolScheduler) {
      return Promise.resolve(
        input.toolCalls.map((toolCall) => ({
          callId: toolCall.id,
          error: {
            message: "Tool scheduler is not configured",
            type: "ExecutionError",
          },
          status: "error",
        })),
      );
    }

    return this.deps.toolScheduler.executeBatch({ calls: requests });
  }
}
