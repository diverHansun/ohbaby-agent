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
      completeMessage: { content, role: "assistant" },
      content,
      delta,
      sessionId,
      timestamp,
      type: "llm:delta",
    };
  }
  if (item.event === "run.llm.complete") {
    return {
      completeMessage: { content: "", role: "assistant" },
      finishReason: stringData(data, "finishReason") as
        | LlmCompleteEvent["finishReason"]
        | undefined,
      sessionId,
      timestamp,
      type: "llm:complete",
    };
  }
  if (item.event === "run.tool.start") {
    return {
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
  if (item.event === "run.context.prepared") {
    return {
      compaction: data.compaction as Extract<
        LifecycleEvent,
        { readonly type: "context:prepared" }
      >["compaction"],
      hasSummary: Boolean(data.hasSummary),
      sessionId,
      step: numberData(data, "step") ?? 0,
      timestamp,
      type: "context:prepared",
      usage: data.usage as Extract<
        LifecycleEvent,
        { readonly type: "context:prepared" }
      >["usage"],
    };
  }
  if (item.event === "run.turn.end") {
    return {
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
