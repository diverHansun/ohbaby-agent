import type { ReactElement } from "react";
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type { UiMessage, UiPromptSubmission, UiRun } from "ohbaby-sdk";
import type { ReactNode } from "react";
import type { ReasoningViewState } from "../../api/daemon/wire.js";
import { ModelWaiting, PromptDuration } from "./ExecutionProgress.js";
import { filterTodoToolMessages, MessageRow } from "./MessageRow.js";
import { projectRunProcesses, type RunProcess } from "./run-process.js";
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
  readonly reasoningByMessageId: Readonly<
    Partial<Record<string, ReasoningViewState>>
  >;
  readonly commandNotices: ReactNode;
}): ReactElement {
  const streamRef = useRef<HTMLDivElement | null>(null);
  const streamInnerRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const scheduledScrollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anchorRef = useRef<{ top: number; height: number } | null>(null);
  const localReading = useRef<{
    sessionId: string | null;
    position: ConversationReadingPosition;
  }>({
    sessionId: props.sessionId,
    position: { top: 0, sticky: true },
  });
  if (localReading.current.sessionId !== props.sessionId) {
    localReading.current = {
      sessionId: props.sessionId,
      position: { top: 0, sticky: true },
    };
  }
  const readingPosition =
    props.readingPosition ?? localReading.current.position;
  const messages = props.messages;
  const visibleMessages = filterTodoToolMessages(
    messages.filter(
      (message) =>
        message.runtimeInputKind !== "subagent-status" &&
        message.runtimeInputKind !== "subagent-result",
    ),
  );
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
  const idPrefix = useId();
  const [expandedRuns, setExpandedRuns] = useState<
    Readonly<Partial<Record<string, boolean>>>
  >({});
  const runKey = (process: RunProcess): string =>
    JSON.stringify([props.sessionId, process.prompt.runId]);
  const messageDomId = (id: string): string =>
    `${idPrefix}-${encodeURIComponent(props.sessionId ?? "")}-${encodeURIComponent(id)}`;
  const processes = projectRunProcesses(
    timelineItems.flatMap((item) =>
      item.kind === "message" ? [item.message] : [],
    ),
    props.prompts,
    props.sessionId,
    props.reasoningByMessageId,
  );
  const beforeAnswer = new Map<string, RunProcess[]>();
  const beforeProcess = new Map<string, RunProcess[]>();
  const terminalAfter = new Map<string, RunProcess[]>();
  const processOwners = new Map<string, RunProcess>();
  for (const process of processes) {
    const anchor = process.answerId ?? process.afterId;
    if (anchor) {
      const map = process.answerId ? beforeAnswer : terminalAfter;
      map.set(anchor, [...(map.get(anchor) ?? []), process]);
    }
    if (process.foldable) {
      const start = process.processIds.at(0) ?? process.answerId;
      if (start)
        beforeProcess.set(start, [
          ...(beforeProcess.get(start) ?? []),
          process,
        ]);
      for (const id of process.processIds) processOwners.set(id, process);
    }
  }
  const isOpen = (process: RunProcess): boolean =>
    !process.foldable || expandedRuns[runKey(process)] === true;
  const hiddenIds = new Set(
    [...processOwners]
      .filter(([, process]) => !isOpen(process))
      .map(([id]) => id),
  );
  const collapsedProcesses = processes.filter(
    (process) => process.foldable && !isOpen(process),
  );
  const hiddenSignature = JSON.stringify(collapsedProcesses.map(runKey));
  const previouslyCollapsed = useRef(new Set<string>());
  const focusedProcessElement = useRef<HTMLElement | null>(null);
  const handledAnchor = useRef<string | undefined>(undefined);
  const toggleAnchor = useRef<{ id: string; offset: number } | null>(null);
  const renderDuration = (process: RunProcess): ReactNode => {
    const answer = visibleMessages.find(
      (message) => message.id === process.answerId,
    );
    const reasoningPrefix = answer
      ? `${messageDomId(answer.id)}-reasoning`
      : "";
    const controls = [
      ...process.processIds.map(messageDomId),
      ...(answer?.parts.flatMap((part, index) =>
        part.type === "reasoning"
          ? [`${reasoningPrefix}-${String(index)}`]
          : [],
      ) ?? []),
      ...(answer && props.reasoningByMessageId[answer.id]
        ? [`${reasoningPrefix}-live`]
        : []),
    ];
    return (
      <PromptDuration
        key={process.prompt.promptId}
        prompt={process.prompt}
        disclosure={
          process.foldable
            ? {
                open: isOpen(process),
                controls: controls.join(" "),
                id: `${messageDomId(process.prompt.promptId)}-disclosure`,
                onToggle: (): void => {
                  const stream = streamRef.current;
                  const id = `${messageDomId(process.prompt.promptId)}-disclosure`;
                  const control = document.getElementById(id);
                  if (stream && control) {
                    toggleAnchor.current = {
                      id,
                      offset:
                        control.getBoundingClientRect().top -
                        stream.getBoundingClientRect().top,
                    };
                  }
                  // Manual disclosure is a reading action, not new output to follow.
                  stickToBottomRef.current = false;
                  readingPosition.sticky = false;
                  readingPosition.messageId = undefined;
                  setExpandedRuns((current) => ({
                    ...current,
                    [runKey(process)]: current[runKey(process)] !== true,
                  }));
                },
              }
            : undefined
        }
      />
    );
  };
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
    toggleAnchor.current = null;
    stickToBottomRef.current = readingPosition.sticky;
    if (streamRef.current) streamRef.current.scrollTop = readingPosition.top;
    scheduleStickScroll();
  }, [activeSessionId, scheduleStickScroll]);

  useLayoutEffect(() => {
    if (!props.anchorMessageId) return;
    const requestKey = JSON.stringify([
      activeSessionId,
      props.anchorMessageId,
      props.anchorToken,
    ]);
    if (handledAnchor.current === requestKey) return;
    const owner = processOwners.get(props.anchorMessageId);
    if (owner && !isOpen(owner)) {
      setExpandedRuns((current) => ({ ...current, [runKey(owner)]: true }));
      return;
    }
    const element = streamRef.current;
    const target = [
      ...(element?.querySelectorAll<HTMLElement>("[data-message-id]") ?? []),
    ].find((node) => node.dataset.messageId === props.anchorMessageId);
    if (element && target) {
      handledAnchor.current = requestKey;
      stickToBottomRef.current = false;
      element.scrollTop +=
        target.getBoundingClientRect().top -
        element.getBoundingClientRect().top -
        12;
      // Explicit delegation anchors take precedence over the near-bottom heuristic.
      readingPosition.top = element.scrollTop;
      readingPosition.sticky = stickToBottomRef.current;
      readingPosition.messageId = props.anchorMessageId;
      readingPosition.offset = 12;
    }
  }, [
    props.anchorMessageId,
    props.anchorToken,
    activeSessionId,
    hiddenSignature,
  ]);

  useLayoutEffect(() => {
    const element = streamRef.current;
    if (!element) return;
    const position = readingPosition;
    const manualAnchor = toggleAnchor.current;
    if (manualAnchor) {
      const control = document.getElementById(manualAnchor.id);
      if (control) {
        element.scrollTop +=
          control.getBoundingClientRect().top -
          element.getBoundingClientRect().top -
          manualAnchor.offset;
      }
      position.top = element.scrollTop;
      toggleAnchor.current = null;
    }
    const hiddenFocus =
      focusedProcessElement.current?.closest<HTMLElement>("[hidden]");
    if (hiddenFocus) {
      const row = hiddenFocus.closest<HTMLElement>("[data-message-id]");
      const owner =
        processOwners.get(row?.dataset.messageId ?? "") ??
        processes.find(
          (process) =>
            process.answerId === row?.dataset.messageId && process.foldable,
        );
      if (owner)
        document
          .getElementById(`${messageDomId(owner.prompt.promptId)}-disclosure`)
          ?.focus({ preventScroll: true });
      focusedProcessElement.current = null;
    }
    const readingOwner = position.messageId
      ? (processOwners.get(position.messageId) ??
        collapsedProcesses.find(
          (process) => process.answerId === position.messageId,
        ))
      : undefined;
    if (
      readingOwner &&
      !isOpen(readingOwner) &&
      !previouslyCollapsed.current.has(runKey(readingOwner)) &&
      !stickToBottomRef.current
    ) {
      const owner = readingOwner;
      const control = document.getElementById(
        `${messageDomId(owner.prompt.promptId)}-disclosure`,
      );
      const answer = owner.answerId
        ? document.getElementById(messageDomId(owner.answerId))
        : null;
      if (control && answer) {
        element.scrollTop +=
          control.getBoundingClientRect().top -
          element.getBoundingClientRect().top -
          Math.max(0, position.offset ?? 0);
        position.messageId = owner.answerId;
        position.offset =
          answer.getBoundingClientRect().top -
          element.getBoundingClientRect().top;
        position.top = element.scrollTop;
      }
    }
    previouslyCollapsed.current = new Set(collapsedProcesses.map(runKey));
  });

  useLayoutEffect(() => {
    scheduleStickScroll();
  }, [
    messagesSignature,
    hiddenSignature,
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
      if (userScroll) stickToBottomRef.current = isNearBottom(element);
      readingPosition.top = element.scrollTop;
      readingPosition.sticky = stickToBottomRef.current;
      const top = element.getBoundingClientRect().top;
      const row = [
        ...element.querySelectorAll<HTMLElement>("[data-message-id]"),
      ].find(
        (node) => !node.hidden && node.getBoundingClientRect().bottom > top,
      );
      readingPosition.messageId = row?.dataset.messageId;
      readingPosition.offset = row
        ? row.getBoundingClientRect().top - top
        : undefined;
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
  }, [readingPosition, props.onNearEnd]);

  useEffect(() => {
    const inner = streamInnerRef.current;
    if (!inner || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      const position = readingPosition;
      const element = streamRef.current;
      if (element && !stickToBottomRef.current && position.messageId) {
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
  }, [scheduleStickScroll, readingPosition]);

  useEffect(() => {
    return (): void => {
      if (scheduledScrollRef.current !== null) {
        globalThis.clearTimeout(scheduledScrollRef.current);
      }
    };
  }, []);

  return (
    <section
      className="ohb-stream"
      ref={streamRef}
      onFocusCapture={(event) => {
        focusedProcessElement.current = event.target;
      }}
      onBlurCapture={(event) => {
        if (
          !event.currentTarget.contains(event.relatedTarget) &&
          !event.target.closest("[hidden]")
        ) {
          focusedProcessElement.current = null;
        }
      }}
    >
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
            <Fragment key={`message:${item.message.id}`}>
              {(beforeProcess.get(item.message.id) ?? []).map(renderDuration)}
              <div
                data-message-id={item.message.id}
                id={messageDomId(item.message.id)}
                hidden={hiddenIds.has(item.message.id)}
              >
                <MessageRow
                  message={item.message}
                  reasoning={props.reasoningByMessageId[item.message.id]}
                  reasoningIdPrefix={`${messageDomId(item.message.id)}-reasoning`}
                  reasoningHidden={(
                    beforeAnswer.get(item.message.id) ?? []
                  ).some((process) => process.foldable && !isOpen(process))}
                  beforeText={(beforeAnswer.get(item.message.id) ?? [])
                    .filter((process) => !process.foldable)
                    .map(renderDuration)}
                />
                {(terminalAfter.get(item.message.id) ?? []).map(renderDuration)}
              </div>
            </Fragment>
          ) : (
            <PromptProjectionRow key={`prompt:${item.row.id}`} row={item.row} />
          ),
        )}
        {processes
          .filter((process) => !process.answerId && !process.afterId)
          .map(renderDuration)}
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
