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

export function estimatePreparedRequestHeuristic(
  request: PreparedModelRequest,
  tokenCounter: Pick<TokenCounter, "estimateTokens">,
): number {
  const payloads = request.messages.map((message) => JSON.stringify(message));
  if (request.tools !== undefined && request.tools.length > 0) {
    payloads.push(JSON.stringify(request.tools));
  }
  const text = payloads.join("\n");
  return Math.max(0, tokenCounter.estimateTokens(text));
}

export function estimateContextOccupancyComposition(
  input: EstimateContextOccupancyCompositionInput,
  tokenCounter: Pick<TokenCounter, "estimateTokens">,
): ContextOccupancyComposition | undefined {
  const payloads = emptyCompositionPayloads();
  const reconstructedMessages = serializeForLlm({
    activeReasoningByMessageId: input.activeReasoningByMessageId,
    history: input.context.history,
    isSubagent: input.context.isSubagent,
    memory: input.context.memory,
    systemPrompt: input.context.systemPrompt,
  });
  if (input.tailDirectives !== undefined) {
    reconstructedMessages.push(...input.tailDirectives);
  }
  if (!wireValuesMatch(reconstructedMessages, input.request.messages)) {
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
    }),
  );

  for (const message of input.context.history) {
    addHistoryMessagePayloads(payloads, message);
    const reasoning = input.activeReasoningByMessageId?.get(message.info.id);
    if (
      message.info.role === "assistant" &&
      message.info.finish !== "error" &&
      reasoning !== undefined &&
      reasoning !== "" &&
      message.parts.some((part) => part.type === "tool" && isActivePart(part))
    ) {
      payloads.conversation.push({ reasoning_content: reasoning });
    }
  }

  for (const directive of input.tailDirectives ?? []) {
    payloads[
      directive.role === "system" ? "system-prompt" : "conversation"
    ].push(directive);
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
    conversation: estimatePayloads(payloads.conversation, tokenCounter),
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
): void {
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
    ...serializeHistoryMessages([{ info: message.info, parts }]),
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
      (definition, index) =>
        definition.name === requestTools[index]?.function.name,
    )
  );
}

function wireValuesMatch(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
