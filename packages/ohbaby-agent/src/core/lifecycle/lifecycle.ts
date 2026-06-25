import {
  isContextOverflowError,
  ProviderRetryExhaustedError,
  ProviderStreamInterruptedError,
  ToolCallParseError,
  streamChatCompletion,
} from "../llm-client/index.js";
import type {
  ChatCompletionMessage,
  ParsedToolCall,
  TokenUsage,
} from "../llm-client/index.js";
import type { PreparedTurn } from "../context/index.js";
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
  LifecycleConfig,
  LifecycleDeps,
  LifecycleEvent,
  LifecycleResult,
  LifecycleSessionParams,
  TurnContext,
} from "./types.js";

export const DEFAULT_MAX_STEPS = 1000;
const MAX_STEPS_FINALIZATION_TOOL_MESSAGE =
  "Max steps reached and finalization response still requested tools.";

interface ResolvedToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly rawArguments: string;
}

interface StepResult {
  readonly assistantMessage?: CoreMessage;
  readonly finalEvent?: Extract<
    LifecycleEvent,
    { readonly type: "llm:complete" }
  >;
  readonly finalResponse: string;
  readonly reasoning?: string;
}

interface ModelStepParams {
  readonly sessionId: string;
  readonly agent?: string;
  readonly parentMessageId?: string;
  readonly signal?: AbortSignal;
  readonly tools?: LifecycleSessionParams["tools"];
  readonly environment?: LifecycleSessionParams["environment"];
  readonly isSubagent?: boolean;
  readonly maxSteps?: number;
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

function toPartTokenUsageMetadata(tokenUsage: TokenUsage | undefined):
  | {
      readonly tokenUsage: {
        readonly promptTokens: number;
        readonly completionTokens: number;
        readonly totalTokens: number;
      };
    }
  | undefined {
  if (!tokenUsage) {
    return undefined;
  }

  return {
    tokenUsage: {
      promptTokens: tokenUsage.prompt_tokens,
      completionTokens: tokenUsage.completion_tokens,
      totalTokens: tokenUsage.total_tokens,
    },
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

function providerFailure(error: unknown):
  | {
      readonly finalResponse: string;
      readonly terminalReason: LifecycleResult["terminalReason"];
    }
  | undefined {
  if (error instanceof ProviderRetryExhaustedError) {
    return {
      finalResponse: `LLM provider is unavailable after ${String(error.attempts)} retries. Retry or resume this run when the connection recovers.`,
      terminalReason: "provider_retry_exhausted",
    };
  }
  if (error instanceof ProviderStreamInterruptedError) {
    return {
      finalResponse:
        "LLM provider stream was interrupted after partial output. Retry or resume this run to continue.",
      terminalReason: "provider_stream_interrupted",
    };
  }
  if (error instanceof ToolCallParseError) {
    return {
      finalResponse: error.message,
      terminalReason: "tool_parse_failure",
    };
  }
  return undefined;
}

function createDefaultToolCallId(): () => string {
  let nextId = 1;

  return () => {
    const id = `tool_call_${String(nextId)}`;
    nextId += 1;
    return id;
  };
}

function buildMaxStepsFinalizationMessage(): ChatCompletionMessage {
  return {
    role: "system",
    content: [
      "Maximum lifecycle steps reached.",
      "Tools are disabled for this final response.",
      "Summarize completed work, state remaining work, and recommend the next user action.",
    ].join("\n"),
  };
}

function messagesForStep(
  messages: readonly ChatCompletionMessage[],
  isFinalStep: boolean,
): ChatCompletionMessage[] {
  return isFinalStep
    ? [...messages, buildMaxStepsFinalizationMessage()]
    : [...messages];
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

function toParsedToolCall(toolCall: ResolvedToolCall): ParsedToolCall {
  return {
    arguments: toolCall.arguments,
    id: toolCall.id,
    name: toolCall.name,
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

function toolResultBaseContent(result: ToolCallResult): string {
  if (result.status === "success" && result.output !== undefined) {
    return result.output;
  }

  const payload: Record<string, unknown> = { status: result.status };
  if (result.output !== undefined) {
    payload.output = result.output;
  }
  if (result.error) {
    payload.error = toolResultErrorPayload(result.error);
  }

  return JSON.stringify(payload);
}

function resultToToolState(
  result: ToolCallResult,
  input: Record<string, unknown>,
): ToolState {
  if (result.status === "success") {
    return {
      input,
      ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
      output: result.output ?? toolResultBaseContent(result),
      status: "completed",
    };
  }

  if (result.status === "cancelled") {
    return {
      error: "Tool execution aborted by user",
      input,
      ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
      ...(result.output === undefined ? {} : { output: result.output }),
      status: "aborted",
    };
  }

  return {
    error: toolResultBaseContent(result),
    input,
    ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
    status: "error",
  };
}

function isToolPart(part: Part): part is ToolPart {
  return part.type === "tool";
}

async function markAssistantMessageError(
  messageManager: MessageManager,
  message: CoreMessage | undefined,
  error: unknown,
): Promise<void> {
  if (message?.role !== "assistant") {
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
    params: LifecycleSessionParams,
    config: LifecycleConfig = {},
  ): AsyncGenerator<LifecycleEvent, LifecycleResult, void> {
    const contextManager = this.deps.contextManager;
    contextManager.resetTurnCompactionCount(params.sessionId);

    // Clamp so the loop always runs at least one step and `step === maxSteps`
    // is reachable for non-integer overrides; otherwise the loop could exit
    // without ever entering the finalization branch.
    const maxSteps = Math.max(
      1,
      Math.floor(params.maxSteps ?? DEFAULT_MAX_STEPS),
    );
    const generateToolCallId =
      this.deps.generateToolCallId ?? createDefaultToolCallId();
    let parentMessageId = params.parentMessageId;
    let usage: LifecycleResult["usage"];
    let finalResponse = "";
    const allToolCalls: ParsedToolCall[] = [];
    let turnStarted = false;
    const activeReasoningByMessageId = new Map<string, string>();

    for (let step = 1; step <= maxSteps; step += 1) {
      if (params.signal?.aborted) {
        return {
          success: false,
          finishReason: "error",
          finalResponse,
          terminalReason: "cancelled",
          toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
          usage,
        };
      }

      let prepared = await contextManager.prepareTurn({
        ...(activeReasoningByMessageId.size === 0
          ? {}
          : { activeReasoningByMessageId }),
        directory: params.directory,
        isSubagent: params.isSubagent,
        modelId: params.modelId,
        sessionId: params.sessionId,
      });
      if (params.signal?.aborted) {
        return {
          success: false,
          finishReason: "error",
          finalResponse,
          terminalReason: "cancelled",
          toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
          usage,
        };
      }
      const isFinalStep = step === maxSteps;
      let conversationMessages = messagesForStep(
        prepared.messages,
        isFinalStep,
      );

      if (!turnStarted) {
        turnStarted = true;
        yield {
          type: "turn:start",
          compaction: prepared.compaction,
          hasSummary: prepared.hasSummary,
          sessionId: params.sessionId,
          step,
          timestamp: Date.now(),
          usage: prepared.usage,
        };
      }
      yield this.createContextPreparedEvent({
        prepared,
        sessionId: params.sessionId,
        step,
      });

      const runParams: ModelStepParams = {
        agent: params.agent,
        environment: params.environment,
        isSubagent: params.isSubagent,
        maxSteps,
        parentMessageId,
        sessionId: params.sessionId,
        signal: params.signal,
        tools: isFinalStep ? [] : params.tools,
      };
      let stepResult: StepResult;
      try {
        stepResult = yield* this.runModelStep({
          conversationMessages,
          params: runParams,
          parentMessageId,
          step,
        });
      } catch (error) {
        const failure = providerFailure(error);
        if (failure) {
          finalResponse = failure.finalResponse;
          yield this.createTurnEndEvent({
            finalResponse,
            finishReason: "error",
            prepared,
            sessionId: params.sessionId,
            step,
          });
          return {
            success: false,
            finishReason: "error",
            finalResponse,
            terminalReason: failure.terminalReason,
            toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
            usage,
          };
        }
        if (!isContextOverflowError(error)) {
          throw error;
        }

        prepared = await contextManager.prepareTurn({
          ...(activeReasoningByMessageId.size === 0
            ? {}
            : { activeReasoningByMessageId }),
          directory: params.directory,
          force: true,
          isSubagent: params.isSubagent,
          modelId: params.modelId,
          sessionId: params.sessionId,
        });
        if (params.signal?.aborted) {
          return {
            success: false,
            finishReason: "error",
            finalResponse,
            terminalReason: "cancelled",
            toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
            usage,
          };
        }
        conversationMessages = messagesForStep(prepared.messages, isFinalStep);
        yield this.createContextPreparedEvent({
          prepared,
          sessionId: params.sessionId,
          step,
        });
        try {
          stepResult = yield* this.runModelStep({
            conversationMessages,
            params: runParams,
            parentMessageId,
            step,
          });
        } catch (retryError) {
          const failure = providerFailure(retryError);
          if (failure) {
            finalResponse = failure.finalResponse;
            yield this.createTurnEndEvent({
              finalResponse,
              finishReason: "error",
              prepared,
              sessionId: params.sessionId,
              step,
            });
            return {
              success: false,
              finishReason: "error",
              finalResponse,
              terminalReason: failure.terminalReason,
              toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
              usage,
            };
          }
          if (!isContextOverflowError(retryError)) {
            throw retryError;
          }

          const overflowMessage =
            "Context overflow after forced compaction retry";
          yield this.createTurnEndEvent({
            finalResponse: overflowMessage,
            finishReason: "error",
            prepared,
            sessionId: params.sessionId,
            step,
          });
          return {
            success: false,
            finishReason: "error",
            finalResponse: overflowMessage,
            terminalReason: "context_overflow",
            toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
            usage,
          };
        }
      }
      const { assistantMessage, finalEvent } = stepResult;
      finalResponse = stepResult.finalResponse;
      if (
        assistantMessage?.role === "assistant" &&
        stepResult.reasoning !== undefined &&
        stepResult.reasoning !== ""
      ) {
        activeReasoningByMessageId.set(
          assistantMessage.id,
          stepResult.reasoning,
        );
      }

      if (!finalEvent) {
        await markAssistantMessageError(
          this.deps.messageManager,
          assistantMessage,
          new Error("Lifecycle did not complete successfully"),
        );
        yield this.createTurnEndEvent({
          finalResponse: "",
          finishReason: "error",
          prepared,
          sessionId: params.sessionId,
          step,
        });
        return {
          success: false,
          finishReason: "error",
          finalResponse: "",
          // The stream ended without a completion event; treat it as an
          // interrupted provider stream for terminal-reason purposes.
          terminalReason: "provider_stream_interrupted",
          toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
          usage,
        };
      }

      usage = addUsage(usage, toUsage(finalEvent.tokenUsage));
      if (finalEvent.tokenUsage !== undefined) {
        contextManager.updateCalibrationFactor(
          params.sessionId,
          finalEvent.tokenUsage.prompt_tokens,
          prepared.sentHeuristic,
        );
      }
      if (params.signal?.aborted) {
        await markAssistantMessageError(
          this.deps.messageManager,
          assistantMessage,
          new Error("Lifecycle aborted"),
        );
        yield this.createTurnEndEvent({
          finalResponse,
          finishReason: "error",
          prepared,
          sessionId: params.sessionId,
          step,
        });
        return {
          success: false,
          finishReason: "error",
          finalResponse,
          terminalReason: "cancelled",
          toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
          usage,
        };
      }

      const parsedToolCalls = finalEvent.parsedToolCalls ?? [];
      const shouldExecuteTools =
        finalEvent.finishReason === "tool_calls" || parsedToolCalls.length > 0;

      if (isFinalStep && shouldExecuteTools) {
        await markAssistantMessageError(
          this.deps.messageManager,
          assistantMessage,
          new Error(MAX_STEPS_FINALIZATION_TOOL_MESSAGE),
        );
        yield this.createTurnEndEvent({
          finalResponse: MAX_STEPS_FINALIZATION_TOOL_MESSAGE,
          finishReason: "error",
          prepared,
          sessionId: params.sessionId,
          step,
        });
        return {
          success: false,
          finishReason: "error",
          finalResponse: MAX_STEPS_FINALIZATION_TOOL_MESSAGE,
          terminalReason: "max_steps_finalization_requested_tool",
          toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
          usage,
        };
      }

      if (!shouldExecuteTools || parsedToolCalls.length === 0) {
        if (shouldExecuteTools && parsedToolCalls.length === 0) {
          await markAssistantMessageError(
            this.deps.messageManager,
            assistantMessage,
            new Error("Model requested tool calls but none were parsed"),
          );
          yield this.createTurnEndEvent({
            finalResponse: "Model requested tool calls but none were parsed",
            finishReason: "error",
            prepared,
            sessionId: params.sessionId,
            step,
          });
          return {
            success: false,
            finishReason: "error",
            finalResponse: "Model requested tool calls but none were parsed",
            terminalReason: "tool_parse_failure",
            toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
            usage,
          };
        }

        const turn = this.createTurnContext({
          finalResponse,
          finishReason: finalEvent.finishReason ?? "stop",
          prepared,
          sessionId: params.sessionId,
          step,
        });
        yield this.createTurnEndEvent(turn);
        return {
          success: true,
          finishReason: finalEvent.finishReason ?? "stop",
          finalResponse,
          terminalReason: isFinalStep ? "max_steps_finalized" : "completed",
          toolCalls:
            allToolCalls.length > 0 || parsedToolCalls.length > 0
              ? [...allToolCalls, ...parsedToolCalls]
              : undefined,
          usage,
        };
      }

      const toolCalls = normalizeToolCalls(parsedToolCalls, generateToolCallId);
      allToolCalls.push(...toolCalls.map(toParsedToolCall));
      const toolParts = await this.appendToolParts(
        assistantMessage,
        toolCalls,
        finalEvent.tokenUsage,
      );

      for (const toolCall of toolCalls) {
        await config.beforeToolCall?.({
          callId: toolCall.id,
          params: toolCall.arguments,
          sessionId: params.sessionId,
          step,
          toolName: toolCall.name,
        });
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
        params: runParams,
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
        await config.afterToolCall?.({
          callId: result.callId,
          params: toolCall.arguments,
          result,
          sessionId: params.sessionId,
          step,
          toolName: toolCall.name,
        });
        yield {
          type: "tool:result",
          callId: result.callId,
          params: toolCall.arguments,
          result,
          sessionId: params.sessionId,
          step,
          timestamp: Date.now(),
          toolName: toolCall.name,
        };
      }

      yield {
        type: "step:complete",
        finishReason: finalEvent.finishReason,
        sessionId: params.sessionId,
        step,
        timestamp: Date.now(),
        toolResults,
      };

      parentMessageId = assistantMessage?.id ?? parentMessageId;
      const turn = this.createTurnContext({
        finalResponse,
        finishReason: finalEvent.finishReason,
        prepared,
        sessionId: params.sessionId,
        step,
        toolResults,
      });

      if (params.signal?.aborted) {
        yield this.createTurnEndEvent({
          ...turn,
          finishReason: "error",
        });
        return {
          success: false,
          finishReason: "error",
          finalResponse,
          terminalReason: "cancelled",
          toolCalls: allToolCalls,
          usage,
        };
      }

      if (config.shouldStopAfterTurn?.(turn) === true) {
        yield this.createTurnEndEvent(turn);
        return {
          success: true,
          finishReason: finalEvent.finishReason ?? "stop",
          finalResponse,
          terminalReason: "completed",
          toolCalls: allToolCalls,
          usage,
        };
      }
    }

    // Unreachable: the final step disables tools and every branch of the
    // final iteration returns. Kept as an invariant guard instead of a
    // fabricated terminal result.
    throw new Error("Lifecycle loop exited without reaching a terminal state");
  }

  private async *runModelStep(input: {
    readonly conversationMessages: readonly ChatCompletionMessage[];
    readonly params: ModelStepParams;
    readonly parentMessageId?: string;
    readonly step: number;
  }): AsyncGenerator<LifecycleEvent, StepResult, void> {
    const { params, step } = input;
    let finalEvent:
      | Extract<LifecycleEvent, { readonly type: "llm:complete" }>
      | undefined;
    let previousContent = "";
    let previousReasoning = "";
    let reasoningEnded = false;
    let assistantTextPart: Part | undefined;

    yield {
      type: "llm:start",
      sessionId: params.sessionId,
      step,
      timestamp: Date.now(),
    };

    const assistantMessage = await this.deps.messageManager.createMessage({
      sessionId: params.sessionId,
      role: "assistant",
      agent: params.agent ?? "default",
      parentId: input.parentMessageId,
    });

    try {
      for await (const response of streamChatCompletion(
        this.deps.llmClient,
        [...input.conversationMessages],
        {
          signal: params.signal,
          tools: params.tools,
        },
      )) {
        if (response.retry) {
          yield {
            type: "llm:retrying",
            attempt: response.retry.attempt,
            delayMs: response.retry.delayMs,
            maxRetries: response.retry.maxRetries,
            reason: response.retry.reason,
            sessionId: params.sessionId,
            step,
            timestamp: Date.now(),
          };
          continue;
        }
        if (response.reasoningDelta !== undefined) {
          const content =
            response.reasoning ??
            `${previousReasoning}${response.reasoningDelta}`;
          previousReasoning = content;
          yield {
            type: "llm:reasoning-delta",
            content,
            delta: response.reasoningDelta,
            messageId: assistantMessage.id,
            sessionId: params.sessionId,
            step,
            timestamp: Date.now(),
          };
        }
        const responseContent = getTextContent(response.completeMessage);
        const content =
          previousReasoning !== "" &&
          previousContent === "" &&
          responseContent === "(Empty response)"
            ? ""
            : responseContent;

        if (content !== "") {
          if (previousReasoning !== "" && !reasoningEnded) {
            reasoningEnded = true;
            yield {
              type: "llm:reasoning-end",
              content: previousReasoning,
              messageId: assistantMessage.id,
              sessionId: params.sessionId,
              step,
              timestamp: Date.now(),
            };
          }
          const delta = content.startsWith(previousContent)
            ? content.slice(previousContent.length)
            : content;
          previousContent = content;

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
          if (previousReasoning !== "" && !reasoningEnded) {
            reasoningEnded = true;
            yield {
              type: "llm:reasoning-end",
              content: previousReasoning,
              messageId: assistantMessage.id,
              sessionId: params.sessionId,
              step,
              timestamp: Date.now(),
            };
          }
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
      if (previousReasoning !== "" && !reasoningEnded) {
        yield {
          type: "llm:reasoning-end",
          content: previousReasoning,
          messageId: assistantMessage.id,
          sessionId: params.sessionId,
          step,
          timestamp: Date.now(),
        };
      }
      await markAssistantMessageError(
        this.deps.messageManager,
        assistantMessage,
        error,
      );
      throw error;
    }

    if (finalEvent) {
      await this.deps.messageManager.updateMessage(assistantMessage.id, {
        finish: finalEvent.finishReason,
        time: {
          ...assistantMessage.time,
          completed: Date.now(),
        },
      });
      if (
        assistantTextPart?.type === "text" &&
        finalEvent.tokenUsage !== undefined
      ) {
        await this.deps.messageManager.updatePart(assistantTextPart.id, {
          metadata: {
            ...assistantTextPart.metadata,
            ...toPartTokenUsageMetadata(finalEvent.tokenUsage),
          },
        });
      }
    }

    return {
      assistantMessage,
      finalEvent,
      finalResponse: finalEvent
        ? previousReasoning !== "" && previousContent === ""
          ? ""
          : getTextContent(finalEvent.completeMessage)
        : "",
      reasoning: previousReasoning === "" ? undefined : previousReasoning,
    };
  }

  private createTurnContext(input: {
    readonly finalResponse: string;
    readonly finishReason?: TurnContext["finishReason"];
    readonly prepared: TurnContext["prepared"];
    readonly sessionId: string;
    readonly step: number;
    readonly toolResults?: readonly ToolCallResult[];
  }): TurnContext {
    return {
      finalResponse: input.finalResponse,
      finishReason: input.finishReason,
      prepared: input.prepared,
      sessionId: input.sessionId,
      step: input.step,
      toolResults: input.toolResults,
    };
  }

  private createTurnEndEvent(input: TurnContext): LifecycleEvent {
    return {
      type: "turn:end",
      finishReason: input.finishReason,
      sessionId: input.sessionId,
      step: input.step,
      timestamp: Date.now(),
      toolResults: input.toolResults,
      usage: input.prepared.usage,
    };
  }

  private createContextPreparedEvent(input: {
    readonly prepared: PreparedTurn;
    readonly sessionId: string;
    readonly step: number;
  }): LifecycleEvent {
    return {
      type: "context:prepared",
      compaction: input.prepared.compaction,
      hasSummary: input.prepared.hasSummary,
      sessionId: input.sessionId,
      step: input.step,
      timestamp: Date.now(),
      usage: input.prepared.usage,
    };
  }

  private async appendToolParts(
    assistantMessage: CoreMessage | undefined,
    toolCalls: readonly ResolvedToolCall[],
    tokenUsage?: TokenUsage,
  ): Promise<Map<string, ToolPart>> {
    const toolParts = new Map<string, ToolPart>();
    if (assistantMessage?.role !== "assistant") {
      return toolParts;
    }

    for (const [index, toolCall] of toolCalls.entries()) {
      const metadata =
        index === 0 ? toPartTokenUsageMetadata(tokenUsage) : undefined;
      const part = await this.deps.messageManager.appendPart(
        assistantMessage.id,
        {
          type: "tool",
          callId: toolCall.id,
          ...(metadata === undefined ? {} : { metadata }),
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
    if (!part) {
      return;
    }
    await this.deps.messageManager.updatePart(part.id, { state });
  }

  private executeToolCalls(input: {
    readonly assistantMessage?: CoreMessage;
    readonly params: ModelStepParams;
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
      agentName: input.params.agent,
      isSubagent: input.params.isSubagent,
      messageId,
      params: toolCall.arguments,
      sessionId: input.params.sessionId,
      signal: input.params.signal,
      toolName: toolCall.name,
    }));

    return this.deps.toolScheduler
      .executeBatch({ calls: requests })
      .catch((error: unknown) =>
        input.toolCalls.map((toolCall) => ({
          callId: toolCall.id,
          error: {
            message: `Tool scheduler failed: ${getErrorMessage(error)}`,
            type: "ExecutionError" as const,
          },
          status: "error" as const,
        })),
      );
  }
}
