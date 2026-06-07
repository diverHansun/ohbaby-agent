import type {
  UiNotice,
  UiMessage,
  UiMessagePart,
  UiRun,
  UiRunStatus,
  UiSession,
  UiToolCall,
} from "ohbaby-sdk";
import type {
  CompactResult,
  ContextUsage,
  ContextWindowUsageTracker,
} from "../../core/context/index.js";
import type { UiStateStore } from "../ui-state/index.js";
import { cloneMessage, cloneRun } from "../ui-state/index.js";
import { noticeFromCompactResult } from "./prompt-context.js";
import {
  END_SENTINEL,
  HEARTBEAT_SENTINEL,
  type StreamBridge,
  type StreamBridgeEvent,
  type StreamBridgeYield,
} from "../../runtime/stream-bridge/index.js";
import type { PublishUiEvent } from "./types.js";

interface StreamRunRecord {
  readonly createdAt: number;
  readonly endedAt?: number;
  readonly error?: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly startedAt?: number;
  readonly status: string;
}

interface ToolResultPayload {
  readonly callId: string;
  readonly error?: {
    readonly message?: string;
  };
  readonly output?: string;
  readonly status: string;
}

type NoticeDraft = Omit<UiNotice, "id" | "createdAt"> & {
  readonly createdAt?: string;
};

export interface RunStreamProjectionOptions {
  readonly assistantMessageId?: string;
  readonly autoStart?: boolean;
  readonly contextWindowUsage?: ContextWindowUsageTracker;
  readonly nextMessageId: () => string;
  readonly onNotice?: (notice: NoticeDraft) => void;
  readonly publish: PublishUiEvent;
  readonly runId: string;
  readonly sessionId: string;
  readonly stateStore: UiStateStore;
  readonly streamBridge: StreamBridge;
  readonly timestamp: () => string;
}

export interface RunStreamProjection {
  readonly done: Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventData(event: StreamBridgeEvent): Record<string, unknown> {
  return isRecord(event.data) ? event.data : {};
}

function toDateString(value: number | undefined, fallback: number): string {
  return new Date(value ?? fallback).toISOString();
}

function toUiRunStatus(record: StreamRunRecord): UiRunStatus {
  if (record.status === "pending" || record.status === "running") {
    return { kind: "running", runId: record.runId };
  }
  if (record.status === "succeeded") {
    return { kind: "idle" };
  }
  return {
    kind: "error",
    message: record.error ?? `Run ${record.status}`,
    recoverable: true,
  };
}

function toUiRun(record: StreamRunRecord): UiRun {
  const updatedAt = record.endedAt ?? record.startedAt ?? record.createdAt;
  return {
    id: record.runId,
    sessionId: record.sessionId,
    startedAt: toDateString(record.startedAt, record.createdAt),
    status: toUiRunStatus(record),
    updatedAt: toDateString(updatedAt, record.createdAt),
  };
}

function upsertTextPart(message: UiMessage, content: string): UiMessage {
  const lastPart = message.parts.at(-1);
  if (lastPart?.type === "text") {
    return {
      ...message,
      parts: message.parts.map(
        (part, index): UiMessagePart =>
          index === message.parts.length - 1
            ? { type: "text", text: content }
            : part,
      ),
    };
  }

  return {
    ...message,
    parts: [...message.parts, { type: "text", text: content }],
  };
}

function appendToolCall(input: {
  readonly callId: string;
  readonly message: UiMessage;
  readonly name: string;
  readonly params: Record<string, unknown>;
}): UiMessage {
  return {
    ...input.message,
    parts: [
      ...input.message.parts,
      {
        type: "tool-call",
        call: {
          id: input.callId,
          input: input.params,
          name: input.name,
          status: "running",
        },
      },
    ],
  };
}

function appendToolResult(input: {
  readonly callId: string;
  readonly message: UiMessage;
  readonly result: ToolResultPayload;
}): UiMessage {
  const status: UiToolCall["status"] =
    input.result.status === "success" ? "completed" : "failed";
  return {
    ...input.message,
    parts: [
      ...input.message.parts.map((part) =>
        part.type === "tool-call" && part.call.id === input.callId
          ? {
              ...part,
              call: {
                ...part.call,
                status,
              },
            }
          : part,
      ),
      {
        type: "tool-result",
        result: {
          callId: input.callId,
          error: input.result.error?.message,
          output: input.result.output ?? "",
        },
      },
    ],
  };
}

function markAssistantStreaming(message: UiMessage): UiMessage {
  return message.status === "streaming"
    ? message
    : {
        ...message,
        status: "streaming",
      };
}

export function startRunStreamProjection(
  options: RunStreamProjectionOptions,
): RunStreamProjection {
  const subscription = options.streamBridge
    .subscribe(`run/${options.runId}`, 0)
    [Symbol.asyncIterator]();
  let assistantMessage: UiMessage | undefined;
  let resolveDone!: () => void;
  let rejectDone!: (error: unknown) => void;
  let started = false;
  let stopped = false;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  async function updateStatus(status: UiRunStatus): Promise<void> {
    await options.stateStore.setStatus(status);
    options.publish({
      type: "runtime.updated",
      status,
      timestamp: Date.now(),
    });
  }

  async function upsertRun(run: UiRun): Promise<void> {
    const snapshot = await options.stateStore.readSnapshot();
    if (snapshot.runs.some((candidate) => candidate.id === run.id)) {
      await options.stateStore.updateRun(run);
    } else {
      await options.stateStore.addRun(run);
    }
  }

  async function updateAssistant(
    updater: (message: UiMessage) => UiMessage,
    settings: { readonly publishUpdate?: boolean } = {},
  ): Promise<UiMessage> {
    const message = markAssistantStreaming(await ensureAssistantMessage());
    const updated = updater(message);
    const session = await requireSession();
    const updatedSession: UiSession = {
      ...session,
      messages: session.messages.map((candidate) =>
        candidate.id === updated.id ? updated : candidate,
      ),
      updatedAt: options.timestamp(),
    };
    assistantMessage = updated;
    await options.stateStore.upsertSession(updatedSession);
    if (settings.publishUpdate !== false) {
      options.publish({
        type: "message.updated",
        message: cloneMessage(updated),
        sessionId: options.sessionId,
      });
    }
    return updated;
  }

  async function requireSession(): Promise<UiSession> {
    const session = await options.stateStore.getSession(options.sessionId);
    if (!session) {
      throw new Error(`UI session not found: ${options.sessionId}`);
    }
    return session;
  }

  async function ensureAssistantMessage(): Promise<UiMessage> {
    if (assistantMessage) {
      return assistantMessage;
    }

    const session = await requireSession();
    const existing = options.assistantMessageId
      ? session.messages.find(
          (message) => message.id === options.assistantMessageId,
        )
      : session.messages.find((message) => message.role === "assistant");
    if (existing) {
      assistantMessage = existing;
      return existing;
    }

    const created: UiMessage = {
      id: options.assistantMessageId ?? options.nextMessageId(),
      role: "assistant",
      createdAt: options.timestamp(),
      status: "streaming",
      updatedAt: options.timestamp(),
      parts: [],
    };
    const updatedSession: UiSession = {
      ...session,
      messages: [...session.messages, created],
      updatedAt: options.timestamp(),
    };
    assistantMessage = created;
    await options.stateStore.upsertSession(updatedSession);
    options.publish({
      type: "message.appended",
      message: cloneMessage(created),
      sessionId: options.sessionId,
    });
    return created;
  }

  async function completeAssistantMessage(
    status: "completed" | "error",
    finishReason: string,
  ): Promise<void> {
    if (!assistantMessage) {
      return;
    }

    const completedAt = options.timestamp();
    await updateAssistant((message) => ({
      ...message,
      completedAt,
      finishReason,
      status,
      updatedAt: completedAt,
    }));
  }

  async function handleRunUpdated(event: StreamBridgeEvent): Promise<void> {
    const data = eventData(event);
    const run = data.run;
    if (!isRecord(run)) {
      return;
    }
    const record = run as unknown as StreamRunRecord;
    if (record.status === "pending") {
      return;
    }

    const uiRun = toUiRun(record);
    if (record.status === "running") {
      await updateStatus(uiRun.status);
      await upsertRun(uiRun);
      options.publish({ type: "run.updated", run: cloneRun(uiRun) });
      return;
    }

    await upsertRun(uiRun);
    options.publish({ type: "run.updated", run: cloneRun(uiRun) });
    await completeAssistantMessage(
      record.status === "succeeded" ? "completed" : "error",
      record.status,
    );
    await updateStatus(uiRun.status);
  }

  async function handleMessageDelta(event: StreamBridgeEvent): Promise<void> {
    const data = eventData(event);
    const content = typeof data.content === "string" ? data.content : "";
    const delta = typeof data.delta === "string" ? data.delta : content;
    const updated = await updateAssistant(
      (message) => upsertTextPart(message, content),
      { publishUpdate: false },
    );
    options.publish({
      type: "message.part.delta",
      content,
      delta,
      messageId: updated.id,
      sessionId: options.sessionId,
      timestamp:
        typeof data.timestamp === "number" ? data.timestamp : Date.now(),
    });
  }

  async function handleToolStart(event: StreamBridgeEvent): Promise<void> {
    const data = eventData(event);
    const callId = typeof data.callId === "string" ? data.callId : "";
    const toolName = typeof data.toolName === "string" ? data.toolName : "";
    const params = isRecord(data.params) ? data.params : {};
    if (callId === "" || toolName === "") {
      return;
    }

    await updateAssistant((message) =>
      appendToolCall({
        callId,
        message,
        name: toolName,
        params,
      }),
    );
  }

  async function handleToolResult(event: StreamBridgeEvent): Promise<void> {
    const data = eventData(event);
    const callId = typeof data.callId === "string" ? data.callId : "";
    const result = isRecord(data.result)
      ? (data.result as unknown as ToolResultPayload)
      : undefined;
    if (callId === "" || !result) {
      return;
    }

    await updateAssistant((message) =>
      appendToolResult({
        callId,
        message,
        result,
      }),
    );
  }

  function handleContextCompaction(event: StreamBridgeEvent): void {
    const data = eventData(event);
    if (!isRecord(data.compaction)) {
      return;
    }
    const notice = noticeFromCompactResult(
      options.sessionId,
      data.compaction as unknown as CompactResult,
    );
    if (notice) {
      options.onNotice?.(notice);
    }
  }

  function handleContextWindowUsage(event: StreamBridgeEvent): void {
    if (!options.contextWindowUsage) {
      return;
    }
    const data = eventData(event);
    if (!isRecord(data.usage)) {
      return;
    }
    const usage = options.contextWindowUsage.updateFromContextUsage(
      options.sessionId,
      data.usage as unknown as ContextUsage,
    );
    if (!usage) {
      return;
    }
    options.publish({
      type: "context.window.updated",
      usage,
    });
  }

  async function handleEvent(event: StreamBridgeEvent): Promise<void> {
    if (event.event === "run.updated") {
      await handleRunUpdated(event);
      return;
    }
    if (event.event === "message.part.delta") {
      await handleMessageDelta(event);
      return;
    }
    if (event.event === "run.tool.start") {
      await handleToolStart(event);
      return;
    }
    if (event.event === "run.tool.result") {
      await handleToolResult(event);
      return;
    }
    if (event.event === "run.context.prepared") {
      handleContextWindowUsage(event);
      handleContextCompaction(event);
    }
  }

  async function pump(): Promise<void> {
    try {
      let next = await subscription.next();
      while (!next.done && !stopped) {
        const value: StreamBridgeYield = next.value;
        if (value === END_SENTINEL) {
          return;
        }
        if (value !== HEARTBEAT_SENTINEL) {
          await handleEvent(value);
        }
        next = await subscription.next();
      }
    } finally {
      await subscription.return?.();
    }
  }

  function start(): void {
    if (started) {
      return;
    }
    started = true;
    void pump().then(resolveDone, rejectDone);
  }

  if (options.autoStart !== false) {
    start();
  }

  return {
    done,
    start,
    async stop(): Promise<void> {
      stopped = true;
      await subscription.return?.();
      if (!started) {
        resolveDone();
      }
    },
  };
}
