import type { AgentRunEventSource } from "../../core/agents/index.js";
import type { LifecycleEvent } from "../../core/lifecycle/index.js";
import type { ToolCallResult } from "../../core/tool-scheduler/index.js";
import {
  END_SENTINEL,
  HEARTBEAT_SENTINEL,
  type StreamBridge,
  type StreamBridgeYield,
} from "../../runtime/stream-bridge/index.js";

type LlmCompleteEvent = Extract<
  LifecycleEvent,
  { readonly type: "llm:complete" }
>;
type PreparedComposition = Extract<
  LifecycleEvent,
  { readonly type: "context:prepared" }
>["composition"];

function objectData(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringData(
  data: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = data[key];
  return typeof value === "string" ? value : undefined;
}

function numberData(
  data: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = data[key];
  return typeof value === "number" ? value : undefined;
}

function nonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    Number.isFinite(value) &&
    value >= 0
  );
}

function tokenUsageData(value: unknown): LlmCompleteEvent["tokenUsage"] {
  const data = objectData(value);
  if (
    !data ||
    !nonNegativeInteger(data.inputTokens) ||
    !nonNegativeInteger(data.outputTokens)
  ) {
    return undefined;
  }

  const inputTokens = data.inputTokens;
  const outputTokens = data.outputTokens;
  const rawBreakdown = objectData(data.inputBreakdown);
  const observed = objectData(rawBreakdown?.observed);
  const hasValidBreakdown =
    rawBreakdown !== undefined &&
    observed !== undefined &&
    nonNegativeInteger(rawBreakdown.uncached) &&
    nonNegativeInteger(rawBreakdown.cacheRead) &&
    nonNegativeInteger(rawBreakdown.cacheWrite) &&
    rawBreakdown.uncached + rawBreakdown.cacheRead + rawBreakdown.cacheWrite ===
      inputTokens &&
    typeof observed.cacheRead === "boolean" &&
    typeof observed.cacheWrite === "boolean";

  return {
    ...(hasValidBreakdown
      ? {
          inputBreakdown: {
            cacheRead: rawBreakdown.cacheRead as number,
            cacheWrite: rawBreakdown.cacheWrite as number,
            observed: {
              cacheRead: observed.cacheRead as boolean,
              cacheWrite: observed.cacheWrite as boolean,
            },
            uncached: rawBreakdown.uncached as number,
          },
        }
      : {}),
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function contextCompositionData(value: unknown): PreparedComposition {
  const data = objectData(value);
  if (!data) {
    return undefined;
  }
  const keys = [
    "system-prompt",
    "builtin-tools",
    "mcp",
    "skills",
    "conversation",
    "summarized-conversation",
    "subagent-exchanges",
  ] as const;
  if (keys.some((key) => !nonNegativeInteger(data[key]))) {
    return undefined;
  }
  return {
    "system-prompt": data["system-prompt"] as number,
    "builtin-tools": data["builtin-tools"] as number,
    mcp: data.mcp as number,
    skills: data.skills as number,
    conversation: data.conversation as number,
    "summarized-conversation": data["summarized-conversation"] as number,
    "subagent-exchanges": data["subagent-exchanges"] as number,
  };
}

function scopeData(data: Record<string, unknown>): {
  readonly contextScopeId?: string;
} {
  const contextScopeId = stringData(data, "contextScopeId");
  return contextScopeId === undefined ? {} : { contextScopeId };
}

function lifecycleEventFromStream(
  item: Exclude<
    StreamBridgeYield,
    typeof END_SENTINEL | typeof HEARTBEAT_SENTINEL
  >,
): LifecycleEvent | undefined {
  const data = objectData(item.data);
  if (!data) {
    return undefined;
  }
  const sessionId = stringData(data, "sessionId");
  const timestamp = numberData(data, "timestamp") ?? Date.now();
  if (!sessionId) {
    return undefined;
  }

  if (item.event === "message.part.delta") {
    const content = stringData(data, "content") ?? "";
    const delta = stringData(data, "delta") ?? "";
    return {
      ...scopeData(data),
      completeMessage: { content, role: "assistant" },
      content,
      delta,
      sessionId,
      timestamp,
      type: "llm:delta",
    };
  }
  if (item.event === "run.llm.reasoning.delta") {
    const content = stringData(data, "content") ?? "";
    const delta = stringData(data, "delta") ?? "";
    const messageId = stringData(data, "messageId");
    if (!messageId) {
      return undefined;
    }
    return {
      ...scopeData(data),
      content,
      delta,
      messageId,
      sessionId,
      step: numberData(data, "step") ?? 0,
      timestamp,
      type: "llm:reasoning-delta",
    };
  }
  if (item.event === "run.llm.reasoning.end") {
    const content = stringData(data, "content") ?? "";
    const messageId = stringData(data, "messageId");
    if (!messageId) {
      return undefined;
    }
    return {
      ...scopeData(data),
      content,
      messageId,
      sessionId,
      step: numberData(data, "step") ?? 0,
      timestamp,
      type: "llm:reasoning-end",
    };
  }
  if (item.event === "run.llm.start") {
    return {
      ...scopeData(data),
      sessionId,
      step: numberData(data, "step") ?? 0,
      timestamp,
      type: "llm:start",
    };
  }
  if (item.event === "run.llm.complete") {
    const step = numberData(data, "step");
    const tokenUsage = tokenUsageData(data.tokenUsage);
    return {
      ...scopeData(data),
      completeMessage: { content: "", role: "assistant" },
      finishReason: stringData(data, "finishReason") as
        | LlmCompleteEvent["finishReason"]
        | undefined,
      sessionId,
      ...(step === undefined ? {} : { step }),
      timestamp,
      ...(tokenUsage === undefined ? {} : { tokenUsage }),
      type: "llm:complete",
    };
  }
  if (item.event === "run.llm.retrying") {
    return {
      ...scopeData(data),
      attempt: numberData(data, "attempt") ?? 0,
      delayMs: numberData(data, "delayMs") ?? 0,
      maxRetries: numberData(data, "maxRetries") ?? 0,
      reason: stringData(data, "reason") ?? "unknown",
      sessionId,
      step: numberData(data, "step") ?? 0,
      timestamp,
      type: "llm:retrying",
    };
  }
  if (item.event === "run.tool.start") {
    return {
      ...scopeData(data),
      callId: stringData(data, "callId") ?? "",
      params: objectData(data.params) ?? {},
      sessionId,
      step: numberData(data, "step") ?? 0,
      timestamp,
      toolName: stringData(data, "toolName") ?? "",
      type: "tool:start",
    };
  }
  if (item.event === "run.tool.result") {
    return {
      ...scopeData(data),
      callId: stringData(data, "callId") ?? "",
      params: objectData(data.params) ?? {},
      result: data.result as ToolCallResult,
      sessionId,
      step: numberData(data, "step") ?? 0,
      timestamp,
      toolName: stringData(data, "toolName") ?? "",
      type: "tool:result",
    };
  }
  if (item.event === "run.turn.start") {
    return {
      ...scopeData(data),
      compaction: data.compaction as Extract<
        LifecycleEvent,
        { readonly type: "turn:start" }
      >["compaction"],
      hasSummary: Boolean(data.hasSummary),
      sessionId,
      step: numberData(data, "step") ?? 0,
      timestamp,
      type: "turn:start",
      usage: data.usage as Extract<
        LifecycleEvent,
        { readonly type: "turn:start" }
      >["usage"],
    };
  }
  if (item.event === "run.context.compacting") {
    return {
      ...scopeData(data),
      sessionId,
      step: numberData(data, "step") ?? 0,
      timestamp,
      type: "context:compacting",
    };
  }
  if (item.event === "run.context.prepared") {
    const composition = contextCompositionData(data.composition);
    return {
      ...scopeData(data),
      compaction: data.compaction as Extract<
        LifecycleEvent,
        { readonly type: "context:prepared" }
      >["compaction"],
      hasSummary: Boolean(data.hasSummary),
      sessionId,
      step: numberData(data, "step") ?? 0,
      timestamp,
      type: "context:prepared",
      ...(composition === undefined ? {} : { composition }),
      usage: data.usage as Extract<
        LifecycleEvent,
        { readonly type: "context:prepared" }
      >["usage"],
    };
  }
  if (item.event === "run.turn.end") {
    return {
      ...scopeData(data),
      finishReason: stringData(data, "finishReason") as Extract<
        LifecycleEvent,
        { readonly type: "turn:end" }
      >["finishReason"],
      sessionId,
      step: numberData(data, "step") ?? 0,
      timestamp,
      toolResults: data.toolResults as Extract<
        LifecycleEvent,
        { readonly type: "turn:end" }
      >["toolResults"],
      type: "turn:end",
      usage: data.usage as Extract<
        LifecycleEvent,
        { readonly type: "turn:end" }
      >["usage"],
    };
  }
  if (item.event === "run.step.complete") {
    return {
      ...scopeData(data),
      finishReason: stringData(data, "finishReason") as Extract<
        LifecycleEvent,
        { readonly type: "step:complete" }
      >["finishReason"],
      sessionId,
      step: numberData(data, "step") ?? 0,
      timestamp,
      toolResults: data.toolResults as Extract<
        LifecycleEvent,
        { readonly type: "step:complete" }
      >["toolResults"],
      type: "step:complete",
    };
  }
  return undefined;
}

export function createStreamBridgeRunEventSource(
  streamBridge: StreamBridge,
): AgentRunEventSource {
  return {
    subscribeRunEvents(runId): AsyncIterable<LifecycleEvent> {
      return (async function* (): AsyncIterable<LifecycleEvent> {
        for await (const item of streamBridge.subscribe(`run/${runId}`, 0)) {
          if (item === END_SENTINEL) {
            return;
          }
          if (item === HEARTBEAT_SENTINEL) {
            continue;
          }
          const event = lifecycleEventFromStream(item);
          if (event) {
            yield event;
          }
        }
      })();
    },
  };
}
