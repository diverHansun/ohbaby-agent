import { isDeepStrictEqual } from "node:util";
import {
  estimateNativeStateTokens,
  hasNativeDependencies,
} from "./native-context.js";
import type { ModelMessage } from "../../services/interface-providers/types.js";
import {
  isContextSummaryPart,
  isModelContextPart,
  type MessageWithParts,
  type Part,
} from "../message/index.js";
import type { ToolDefinition, ToolSource } from "../tool-scheduler/index.js";
import { isActivePart } from "./filters.js";
import { serializeForLlm, serializeHistoryMessages } from "./serializer.js";
import type {
  AssembledContext,
  ContextOccupancyComposition,
  PreparedModelRequest,
  TokenCounter,
} from "./types.js";

const SUBAGENT_TOOL_NAMES = new Set([
  "subagent_run",
  "subagent_status",
  "subagent_close",
]);

type CompositionKey = keyof ContextOccupancyComposition;

interface CompositionPayloads {
  readonly "system-prompt": unknown[];
  readonly "builtin-tools": unknown[];
  readonly mcp: unknown[];
  readonly skills: unknown[];
  readonly conversation: unknown[];
  readonly "summarized-conversation": unknown[];
  readonly "subagent-exchanges": unknown[];
}

export interface EstimateContextOccupancyCompositionInput {
  readonly activeReasoningByMessageId?: ReadonlyMap<string, string>;
  readonly context: AssembledContext;
  readonly request: PreparedModelRequest;
  readonly tailDirectives?: PreparedModelRequest["messages"];
  readonly toolDefinitions?: readonly ToolDefinition[];
}

/** Select the self-owned request material; native reasoning is counted separately. */
function messageForEstimation(message: ModelMessage): object {
  if (message.role !== "assistant") return message;
  const { modelState, reasoningText, ...content } = message;
  return {
    ...content,
    ...(modelState === undefined && reasoningText !== undefined
      ? { reasoningText }
      : {}),
  };
}

export function estimatePreparedRequestHeuristic(
  request: PreparedModelRequest,
  tokenCounter: Pick<TokenCounter, "estimateTokens">,
): number {
  const payloads = request.messages.map((message) =>
    JSON.stringify(messageForEstimation(message)),
  );
  if (request.tools !== undefined && request.tools.length > 0) {
    payloads.push(JSON.stringify(request.tools));
  }
  const text = payloads.join("\n");
  return (
    Math.max(0, tokenCounter.estimateTokens(text)) +
    request.messages.reduce(
      (sum, message) =>
        sum +
        (message.role === "assistant" && message.modelState !== undefined
          ? estimateNativeStateTokens(message.modelState, tokenCounter)
          : 0),
      0,
    )
  );
}

export function estimateContextOccupancyComposition(
  input: EstimateContextOccupancyCompositionInput,
  tokenCounter: Pick<TokenCounter, "estimateTokens">,
): ContextOccupancyComposition | undefined {
  const payloads = emptyCompositionPayloads();
  const reconstructedMessages = serializeForLlm({
    activeReasoningByMessageId: input.activeReasoningByMessageId,
    history: input.context.history,
    modelOrigin: input.context.modelOrigin,
    isSubagent: input.context.isSubagent,
    memory: input.context.memory,
    systemPrompt: input.context.systemPrompt,
  });
  if (input.tailDirectives !== undefined) {
    reconstructedMessages.push(...input.tailDirectives);
  }
  if (!requestValuesMatch(reconstructedMessages, input.request.messages)) {
    return undefined;
  }
  const requestTools = input.request.tools ?? [];
  const toolDefinitions = input.toolDefinitions;
  if (
    requestTools.length > 0 &&
    (toolDefinitions === undefined ||
      !definitionsMatchRequestTools(toolDefinitions, requestTools))
  ) {
    return undefined;
  }
  if (
    toolDefinitions !== undefined &&
    !definitionsMatchRequestTools(toolDefinitions, requestTools)
  ) {
    return undefined;
  }

  payloads["system-prompt"].push(
    ...serializeForLlm({
      history: [],
      isSubagent: input.context.isSubagent,
      memory: input.context.memory,
      systemPrompt: input.context.systemPrompt,
    }).map(messageForEstimation),
  );

  for (const message of input.context.history) {
    addHistoryMessagePayloads(payloads, message, input.context.modelOrigin);
    const reasoning = input.activeReasoningByMessageId?.get(message.info.id);
    if (
      message.info.role === "assistant" &&
      message.info.finish !== "error" &&
      !hasNativeDependencies(message) &&
      reasoning !== undefined &&
      reasoning !== "" &&
      message.parts.some((part) => part.type === "tool" && isActivePart(part))
    ) {
      payloads.conversation.push({ reasoningText: reasoning });
    }
  }

  for (const directive of input.tailDirectives ?? []) {
    payloads[
      directive.role === "system" ? "system-prompt" : "conversation"
    ].push(messageForEstimation(directive));
  }

  if (toolDefinitions !== undefined && requestTools.length > 0) {
    const toolPayloads: Record<"builtin-tools" | "mcp" | "skills", unknown[]> =
      {
        "builtin-tools": [],
        mcp: [],
        skills: [],
      };
    requestTools.forEach((tool, index) => {
      const definition = toolDefinitions[index];
      toolPayloads[toolBucket(definition.source)].push(tool);
    });
    for (const key of ["builtin-tools", "mcp", "skills"] as const) {
      if (toolPayloads[key].length > 0) {
        payloads[key].push(toolPayloads[key]);
      }
    }
  }

  return {
    "system-prompt": estimatePayloads(payloads["system-prompt"], tokenCounter),
    "builtin-tools": estimatePayloads(payloads["builtin-tools"], tokenCounter),
    mcp: estimatePayloads(payloads.mcp, tokenCounter),
    skills: estimatePayloads(payloads.skills, tokenCounter),
    conversation:
      estimatePayloads(payloads.conversation, tokenCounter) +
      input.request.messages.reduce(
        (sum, message) =>
          sum +
          (message.role === "assistant" && message.modelState !== undefined
            ? estimateNativeStateTokens(message.modelState, tokenCounter)
            : 0),
        0,
      ),
    "summarized-conversation": estimatePayloads(
      payloads["summarized-conversation"],
      tokenCounter,
    ),
    "subagent-exchanges": estimatePayloads(
      payloads["subagent-exchanges"],
      tokenCounter,
    ),
  };
}

function addHistoryMessagePayloads(
  payloads: CompositionPayloads,
  message: MessageWithParts,
  modelOrigin?: AssembledContext["modelOrigin"],
): void {
  if (message.info.role === "assistant" && message.info.finish === "error") {
    // Attribute the complete projection once; splitting its carrier into
    // runtime/tool buckets could recreate or misattribute the same notice.
    payloads.conversation.push(
      ...serializeHistoryMessages([message]).map(messageForEstimation),
    );
    return;
  }
  if (hasNativeDependencies(message)) {
    // Serialize the whole replay unit before attributing its measurement only.
    const messages = serializeHistoryMessages(
      [message],
      undefined,
      modelOrigin,
    );
    const subagentCallIds = new Set(
      message.parts.flatMap((part) =>
        part.type === "tool" && SUBAGENT_TOOL_NAMES.has(part.tool)
          ? [part.callId]
          : [],
      ),
    );
    for (const projected of messages) {
      if (projected.role === "assistant") {
        const { toolCalls, ...assistant } = projected;
        payloads.conversation.push(messageForEstimation(assistant));
        for (const call of toolCalls ?? []) {
          const key = SUBAGENT_TOOL_NAMES.has(call.name)
            ? "subagent-exchanges"
            : "conversation";
          payloads[key].push({ role: "assistant", toolCalls: [call] });
        }
      } else {
        const key =
          projected.role === "tool" && subagentCallIds.has(projected.callId)
            ? "subagent-exchanges"
            : "conversation";
        payloads[key].push(messageForEstimation(projected));
      }
    }
    return;
  }
  const summarizedParts: Part[] = [];
  const runtimeParts: Part[] = [];
  const subagentParts: Part[] = [];
  const conversationParts: Part[] = [];

  for (const part of message.parts) {
    if (isContextSummaryPart(part)) {
      summarizedParts.push(part);
    } else if (isModelContextPart(part)) {
      runtimeParts.push(part);
    } else if (part.type === "tool" && SUBAGENT_TOOL_NAMES.has(part.tool)) {
      subagentParts.push(part);
    } else {
      conversationParts.push(part);
    }
  }

  addSerializedParts(
    payloads,
    "summarized-conversation",
    message,
    summarizedParts,
  );
  addSerializedParts(payloads, "system-prompt", message, runtimeParts);
  addSerializedParts(payloads, "subagent-exchanges", message, subagentParts);
  addSerializedParts(
    payloads,
    message.info.role === "system" ? "system-prompt" : "conversation",
    message,
    conversationParts,
  );
}

function addSerializedParts(
  payloads: CompositionPayloads,
  key: CompositionKey,
  message: MessageWithParts,
  parts: readonly Part[],
): void {
  if (parts.length === 0) {
    return;
  }
  payloads[key].push(
    ...serializeHistoryMessages([{ info: message.info, parts }]).map(
      messageForEstimation,
    ),
  );
}

function emptyCompositionPayloads(): CompositionPayloads {
  return {
    "system-prompt": [],
    "builtin-tools": [],
    mcp: [],
    skills: [],
    conversation: [],
    "summarized-conversation": [],
    "subagent-exchanges": [],
  };
}

function definitionsMatchRequestTools(
  definitions: readonly ToolDefinition[],
  requestTools: NonNullable<PreparedModelRequest["tools"]>,
): boolean {
  return (
    definitions.length === requestTools.length &&
    definitions.every(
      (definition, index) => definition.name === requestTools[index]?.name,
    )
  );
}

function requestValuesMatch(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

function toolBucket(source: ToolSource): "builtin-tools" | "mcp" | "skills" {
  switch (source) {
    case "mcp":
      return "mcp";
    case "skill":
      return "skills";
    case "builtin":
    case "module":
      return "builtin-tools";
  }
}

function estimatePayloads(
  payloads: readonly unknown[],
  tokenCounter: Pick<TokenCounter, "estimateTokens">,
): number {
  if (payloads.length === 0) {
    return 0;
  }
  const serialized = payloads.map((payload) => JSON.stringify(payload));
  return Math.max(
    0,
    Math.round(tokenCounter.estimateTokens(serialized.join("\n"))),
  );
}
