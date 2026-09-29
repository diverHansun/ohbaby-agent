import type { ReactElement } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

import type { UiMessage, UiPromptSubmission, UiRun } from "ohbaby-sdk";
import type { ReactNode } from "react";
import type { ReasoningViewState } from "../../api/daemon/wire.js";
import { ModelWaiting, PromptDuration } from "./ExecutionProgress.js";
import { filterTodoToolMessages, MessageRow } from "./MessageRow.js";
import { isNearBottom, scrollToBottom } from "./streamScroll.js";

export interface PromptProjectionModel {
  readonly clientRequestId: string;
  readonly createdAt: string;
  readonly error?: string;
  readonly id: string;
  readonly label?: string;
  readonly text: string;
}

export interface ConversationReadingPosition {
  top: number;
  sticky: boolean;
  messageId?: string;
  offset?: number;
}

export function ConversationStream(props: {
  readonly preserveMessageOrder?: boolean;
  readonly readingPosition?: ConversationReadingPosition;
  readonly anchorMessageId?: string;
  readonly anchorToken?: string;
  readonly onNearEnd?: () => void;
  readonly historyState: "loading" | "ready" | "error";
  readonly historyHasMore: boolean;
  readonly historyStale: boolean;
  readonly historyError?: string;
  readonly onLoadHistory: () => Promise<void>;
  readonly promptRows: readonly PromptProjectionModel[];
  readonly startupThinkingAt?: string;
  readonly messages: readonly UiMessage[];
  readonly sessionId: string | null;
  readonly prompts: readonly UiPromptSubmission[];
  readonly activeRun: UiRun | undefined;
  readonly isRunning: boolean;
  readonly reasoningByMessageId: Readonly<Record<string, ReasoningViewState>>;
  readonly commandNotices: ReactNode;
}): ReactElement {
  const streamRef = useRef<HTMLDivElement | null>(null);
  const streamInnerRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const scheduledScrollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anchorRef = useRef<{ top: number; height: number } | null>(null);
  const messages = props.messages;
  const visibleMessages = filterTodoToolMessages(
    messages.filter(
      (message) =>
        message.runtimeInputKind !== "subagent-status" &&
        message.runtimeInputKind !== "subagent-result",
    ),
  );
  const terminalPrompts = props.prompts.filter(
    (prompt) =>
      prompt.sessionId === props.sessionId &&
      prompt.endedAt !== undefined &&
      Number.isFinite(Date.parse(prompt.createdAt)) &&
      Number.isFinite(Date.parse(prompt.endedAt)) &&
      ["succeeded", "failed", "cancelled", "interrupted"].includes(
        prompt.status,
      ),
  );
  const terminalAfter = new Map<string, typeof terminalPrompts>();
  const unattached = terminalPrompts.filter((prompt) => {
    const owner =
      [...visibleMessages]
        .reverse()
        .find(
          (message) =>
            message.role === "assistant" &&
            message.runId !== undefined &&
            message.runId === prompt.runId,
        ) ??
      visibleMessages.find((message) => message.id === prompt.userMessageId);
    if (!owner) return true;
    terminalAfter.set(owner.id, [
      ...(terminalAfter.get(owner.id) ?? []),
      prompt,
    ]);
    return false;
  });
  const timelineItems = [
    ...visibleMessages.map((message, index) => ({
      createdAt: message.createdAt,
      index,
      kind: "message" as const,
      message,
    })),
    ...props.promptRows.map((row, index) => ({
      createdAt: row.createdAt,
      index,
      kind: "prompt" as const,
      row,
    })),
  ].sort((left, right) => {
    if (props.preserveMessageOrder) return 0;
    const createdAtOrder = left.createdAt.localeCompare(right.createdAt);
    if (createdAtOrder !== 0) return createdAtOrder;
    if (left.kind !== right.kind) return left.kind === "message" ? -1 : 1;
    return left.index - right.index;
  });
  const activeSessionId = props.sessionId ?? null;
  const lastMessage = visibleMessages.at(-1);
  const messagesSignature = [
    visibleMessages.length,
    lastMessage?.id ?? "",
    lastMessage?.parts.length ?? 0,
    lastMessage?.parts
      .map((part) =>
        part.type === "text" || part.type === "reasoning"
          ? `${part.type}:${String(part.text.length)}`
          : part.type,
      )
      .join(",") ?? "",
  ].join(":");

  const scheduleStickScroll = useCallback(() => {
    if (!stickToBottomRef.current) {
      return;
    }
    if (scheduledScrollRef.current !== null) {
      globalThis.clearTimeout(scheduledScrollRef.current);
    }
    scheduledScrollRef.current = globalThis.setTimeout(() => {
      scheduledScrollRef.current = null;
      if (!stickToBottomRef.current) {
        return;
      }
      const element = streamRef.current;
      if (element) {
        scrollToBottom(element);
      }
    }, 0);
  }, []);

  useLayoutEffect(() => {
    anchorRef.current = null;
    stickToBottomRef.current = props.readingPosition?.sticky ?? true;
    if (streamRef.current && props.readingPosition)
      streamRef.current.scrollTop = props.readingPosition.top;
    scheduleStickScroll();
  }, [activeSessionId, scheduleStickScroll]);

  useLayoutEffect(() => {
    if (!props.anchorMessageId) return;
    const element = streamRef.current;
    const target = [
      ...(element?.querySelectorAll<HTMLElement>("[data-message-id]") ?? []),
    ].find((node) => node.dataset.messageId === props.anchorMessageId);
    if (element && target) {
      stickToBottomRef.current = false;
      element.scrollTop +=
        target.getBoundingClientRect().top -
        element.getBoundingClientRect().top -
        12;
      // Explicit delegation anchors take precedence over the near-bottom heuristic.
      if (props.readingPosition) {
        props.readingPosition.top = element.scrollTop;
        props.readingPosition.sticky = stickToBottomRef.current;
        props.readingPosition.messageId = props.anchorMessageId;
        props.readingPosition.offset = 12;
      }
    }
  }, [props.anchorMessageId, props.anchorToken]);

  useLayoutEffect(() => {
    scheduleStickScroll();
  }, [
    messagesSignature,
    props.promptRows.map((row) => `${row.id}:${row.label ?? ""}`).join(","),
    props.startupThinkingAt,
    props.isRunning,
    scheduleStickScroll,
  ]);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const element = streamRef.current;
    if (anchor && element && props.historyState !== "loading") {
      element.scrollTop = anchor.top + (element.scrollHeight - anchor.height);
      anchorRef.current = null;
    }
  }, [messagesSignature, props.historyState]);

  useEffect(() => {
    const element = streamRef.current;
    if (!element) {
      return;
    }
    let userScroll = false;
    const markUserScroll = (): void => {
      userScroll = true;
    };
    const onScroll = (): void => {
      if (!props.readingPosition || userScroll)
        stickToBottomRef.current = isNearBottom(element);
      if (props.readingPosition) {
        props.readingPosition.top = element.scrollTop;
        props.readingPosition.sticky = stickToBottomRef.current;
        const top = element.getBoundingClientRect().top;
        const row = [
          ...element.querySelectorAll<HTMLElement>("[data-message-id]"),
        ].find((node) => node.getBoundingClientRect().bottom > top);
        props.readingPosition.messageId = row?.dataset.messageId;
        props.readingPosition.offset = row
          ? row.getBoundingClientRect().top - top
          : undefined;
      }
      if (userScroll && stickToBottomRef.current) {
        props.onNearEnd?.();
      }
      userScroll = false;
    };
    element.addEventListener("scroll", onScroll);
    element.addEventListener("wheel", markUserScroll, { passive: true });
    element.addEventListener("touchmove", markUserScroll, { passive: true });
    element.addEventListener("pointerdown", markUserScroll);
    element.addEventListener("keydown", markUserScroll);
    return (): void => {
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener("wheel", markUserScroll);
      element.removeEventListener("touchmove", markUserScroll);
      element.removeEventListener("pointerdown", markUserScroll);
      element.removeEventListener("keydown", markUserScroll);
    };
  }, [props.readingPosition, props.onNearEnd]);

  useEffect(() => {
    const inner = streamInnerRef.current;
    if (!inner || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      const position = props.readingPosition;
      const element = streamRef.current;
      if (
        position &&
        element &&
        !stickToBottomRef.current &&
        position.messageId
      ) {
        const row = [
          ...element.querySelectorAll<HTMLElement>("[data-message-id]"),
        ].find((node) => node.dataset.messageId === position.messageId);
        if (row)
          element.scrollTop +=
            row.getBoundingClientRect().top -
            element.getBoundingClientRect().top -
            (position.offset ?? 0);
      }
      scheduleStickScroll();
    });
    observer.observe(inner);
    if (streamRef.current) observer.observe(streamRef.current);
    return (): void => {
      observer.disconnect();
    };
  }, [scheduleStickScroll, props.readingPosition]);

  useEffect(() => {
    return (): void => {
      if (scheduledScrollRef.current !== null) {
        globalThis.clearTimeout(scheduledScrollRef.current);
      }
    };
  }, []);

  return (
    <section className="ohb-stream" ref={streamRef}>
      <div className="ohb-stream-inner" ref={streamInnerRef}>
        {props.historyHasMore ||
        props.historyStale ||
        props.historyState === "error" ? (
          <div role="status">
            {props.historyStale ? (
              <span>
                Earlier history changed. Refresh to see the latest version.{" "}
              </span>
            ) : null}
            {props.historyError ? <span>{props.historyError} </span> : null}
            <button
              type="button"
              disabled={props.historyState === "loading"}
              onClick={() => {
                const element = streamRef.current;
                if (element) {
                  anchorRef.current = {
                    top: element.scrollTop,
                    height: element.scrollHeight,
                  };
                  stickToBottomRef.current = false;
                }
                void props.onLoadHistory();
              }}
            >
              {props.historyState === "loading"
                ? "Loading history…"
                : props.historyStale
                  ? "Refresh earlier history"
                  : "Load earlier messages"}
            </button>
          </div>
        ) : null}
        {timelineItems.map((item) =>
          item.kind === "message" ? (
            <div
              key={`message:${item.message.id}`}
              data-message-id={item.message.id}
            >
              <MessageRow
                message={item.message}
                reasoning={props.reasoningByMessageId[item.message.id]}
              />
              {(terminalAfter.get(item.message.id) ?? []).map((prompt) => (
                <PromptDuration key={prompt.promptId} prompt={prompt} />
              ))}
            </div>
          ) : (
            <PromptProjectionRow key={`prompt:${item.row.id}`} row={item.row} />
          ),
        )}
        {unattached.map((prompt) => (
          <PromptDuration key={prompt.promptId} prompt={prompt} />
        ))}
        {props.commandNotices}
        {props.isRunning ? <ModelWaiting run={props.activeRun} /> : null}
      </div>
    </section>
  );
}

function PromptProjectionRow(props: {
  readonly row: PromptProjectionModel;
}): ReactElement {
  return (
    <div
      className={`ohb-message-pending ${
        props.row.error === undefined ? "" : "ohb-message-prompt-error"
      }`}
      data-client-request-id={props.row.clientRequestId}
      data-user-message-id={props.row.id}
    >
      <MessageRow
        message={{
          createdAt: props.row.createdAt,
          id: props.row.id,
          parts: [{ text: props.row.text, type: "text" }],
          role: "user",
        }}
      />
      {props.row.label === undefined ? null : (
        <span className="ohb-message-pending-label">{props.row.label}</span>
      )}
      {props.row.error === undefined ? null : (
        <span className="ohb-message-prompt-error-text" role="alert">
          {props.row.error}
        </span>
      )}
    </div>
  );
}
