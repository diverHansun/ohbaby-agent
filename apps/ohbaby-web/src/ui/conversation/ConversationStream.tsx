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

import type {
  UiMessage,
  UiPromptError,
  UiPromptSubmission,
  UiRun,
  UiUnconsumedSteer,
  UiWebCommandCatalog,
} from "ohbaby-sdk";
import { listRetriedAttemptIds, turnTriggerLabel } from "ohbaby-sdk";
import type { ReactNode } from "react";
import type { ReasoningViewState } from "../../api/daemon/wire.js";
import {
  Compacting,
  ModelWaiting,
  TurnError,
  PromptDuration,
} from "./ExecutionProgress.js";
import {
  LoaderCircle,
  MessageCircleQuestion,
  Pencil,
  Split,
} from "lucide-react";
import { type EditedPrompt, UserMessageEditor } from "./UserMessageEditor.js";
import { skillMarkerName, splitSkillText } from "./skill-text.js";
import { Spinner } from "../shared/Spinner.js";
import { IconButton } from "../shared/IconButton.js";
import { CopyButton } from "../shared/CopyButton.js";
import { SelectionAction } from "./SelectionAction.js";
import { type MessageAction, MessageActions } from "./MessageActions.js";
import { isCompactionMessage, messageBodyText } from "./message-text.js";
import { formatFullMessageTime, formatMessageTime } from "./message-time.js";
import { useDayClock } from "../shared/use-day-clock.js";
import { filterTodoToolMessages, MessageRow } from "./MessageRow.js";
import {
  isExpectedInterruption,
  projectRunProcesses,
  type RunProcess,
} from "./run-process.js";
import { isNearBottom, scrollToBottom, scrollsNested } from "./streamScroll.js";

export interface PromptProjectionModel {
  readonly clientRequestId: string;
  readonly createdAt: string;
  readonly error?: string;
  readonly id: string;
  readonly label?: string;
  readonly text: string;
}

/** Opencode's quiet retry pause: a failed page retries on a later user scroll. */
const HISTORY_RETRY_COOLDOWN_MS = 2000;

/** A row the user can see: not hidden, and not collapsed by CSS :empty. */
function visibleRowRect(node: HTMLElement): DOMRect | undefined {
  if (node.hidden) return undefined;
  const rect = node.getBoundingClientRect();
  return rect.height > 0 ? rect : undefined;
}

function findRow(
  element: HTMLElement,
  messageId: string,
): HTMLElement | undefined {
  return [...element.querySelectorAll<HTMLElement>("[data-message-id]")].find(
    (node) => node.dataset.messageId === messageId,
  );
}

/** The top-level Markdown blocks of a row, in reading order. */
const readingBlocks = (row: HTMLElement): NodeListOf<HTMLElement> =>
  row.querySelectorAll<HTMLElement>(".ohb-markdown > *");

/**
 * The first visible row at the top of the stream, and its offset there. When
 * the reader is partway into a long answer, the block they are reading is
 * kept too, so content above it in the same answer can change height.
 */
function captureReadingRow(
  element: HTMLElement,
  position: ConversationReadingPosition,
): void {
  const top = element.getBoundingClientRect().top;
  position.blockIndex = undefined;
  position.blockOffset = undefined;
  for (const node of element.querySelectorAll<HTMLElement>(
    "[data-message-id]",
  )) {
    const rect = visibleRowRect(node);
    if (rect && rect.bottom > top) {
      position.messageId = node.dataset.messageId;
      position.offset = rect.top - top;
      if (rect.top < top) {
        const blocks = [...readingBlocks(node)];
        const index = blocks.findIndex(
          (block) => block.getBoundingClientRect().bottom > top,
        );
        if (index >= 0) {
          position.blockIndex = index;
          position.blockOffset =
            blocks[index].getBoundingClientRect().top - top;
        }
      }
      return;
    }
  }
  position.messageId = undefined;
  position.offset = undefined;
}

/**
 * Moves the reading row back to where the user last saw it, aligning the
 * block they were reading when it is still there and the row otherwise.
 */
function restoreReadingRow(
  element: HTMLElement,
  position: ConversationReadingPosition,
): void {
  if (!position.messageId) return;
  const row = findRow(element, position.messageId);
  const rect = row ? visibleRowRect(row) : undefined;
  if (!row || !rect) return;
  const block =
    position.blockIndex === undefined
      ? undefined
      : readingBlocks(row).item(position.blockIndex);
  const targetTop = block ? block.getBoundingClientRect().top : rect.top;
  const offset = block ? position.blockOffset : position.offset;
  element.scrollTop +=
    targetTop - element.getBoundingClientRect().top - (offset ?? 0);
}

export interface ConversationReadingPosition {
  top: number;
  sticky: boolean;
  messageId?: string;
  offset?: number;
  /** The top-level Markdown block being read inside `messageId`. */
  blockIndex?: number;
  blockOffset?: number;
}

export function ConversationStream(props: {
  readonly resultSources?: readonly {
    readonly runId: string;
    readonly executionId: string;
    readonly label: string;
    readonly onOpen?: () => void;
  }[];
  readonly unconsumedSteers?: readonly UiUnconsumedSteer[];
  readonly preserveMessageOrder?: boolean;
  readonly readingPosition?: ConversationReadingPosition;
  readonly anchorMessageId?: string;
  readonly anchorToken?: string;
  readonly onNearEnd?: () => void;
  readonly historyState: "loading" | "ready" | "error";
  readonly historyHasMore: boolean;
  readonly historyStale: boolean;
  /**
   * Loads one earlier page. Resolves true only when the cursor moved or no
   * earlier page remains; only then does the stream check for another page.
   */
  readonly onLoadHistory: () => Promise<boolean>;
  readonly promptRows: readonly PromptProjectionModel[];
  readonly startupThinkingAt?: string;
  readonly messages: readonly UiMessage[];
  readonly sessionId: string | null;
  readonly prompts: readonly UiPromptSubmission[];
  /** This session's main runs; each ended run with messages is one turn. */
  readonly runs?: readonly UiRun[];
  readonly activeRun: UiRun | undefined;
  readonly isRunning: boolean;
  readonly reasoningByMessageId: Readonly<
    Partial<Record<string, ReasoningViewState>>
  >;
  readonly commandNotices: ReactNode;
  readonly compacting?: boolean;
  readonly compactNotice?: string;
  /** Changes when the user sends a prompt; following resumes even after reading up. */
  readonly followToken?: number;
  /**
   * A side chat panel: its messages keep only Copy, and selected text offers
   * nothing. Edit and fork must respect this switch (side chat 00 P18).
   */
  readonly variant?: "side-chat";
  /** Main chat only: selected message text can be quoted into a side chat. */
  readonly onAskInSideChat?: (selection: string) => void;
  /**
   * Main chat only: forks from a turn's final answer (fork 02 Stage 2 step 1).
   * The button shows wherever Copy shows on an answer.
   */
  readonly onFork?: (runId: string) => Promise<unknown>;
  /**
   * Main chat only: user messages can be edited in place and sent again
   * (undo 02 Stage 2). Absent in side chats and subagent conversations.
   */
  readonly edit?: {
    /** Why editing is off for now, e.g. "Compacting…". */
    readonly unavailable?: string;
    /** What a Send does to the session's current state, after the fixed hints. */
    readonly stateHints: readonly string[];
    /** Resolves to an error text to show in the editor, or null when done. */
    readonly send: (
      promptId: string,
      input: EditedPrompt,
    ) => Promise<string | null>;
    /** The command catalog, for the editor's skill palette. */
    readonly listCommands?: () => Promise<UiWebCommandCatalog>;
    readonly commandCatalogVersion?: string | null;
  };
}): ReactElement {
  const streamRef = useRef<HTMLDivElement | null>(null);
  const streamInnerRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const scheduledScrollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestPendingRef = useRef(false);
  const requestEndedAtRef = useRef(0);
  // One clock for every message time in the stream; it moves at midnight.
  const today = useDayClock();
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
  // Listeners and request callbacks read the latest props, not their closure's.
  const latest = useRef({ props, readingPosition });
  useLayoutEffect(() => {
    latest.current = { props, readingPosition };
  });
  const messages = props.messages;
  // A step retry replaced these answers and the model no longer sees them.
  const retriedIds = listRetriedAttemptIds(messages);
  const visibleMessages = filterTodoToolMessages(
    messages.filter(
      (message) =>
        !retriedIds.has(message.id) &&
        message.runtimeInputKind !== "subagent-status" &&
        message.runtimeInputKind !== "subagent-result" &&
        // Task results are for the agent only (background tasks README D6).
        message.runtimeInputKind !== "background-task-result",
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
    JSON.stringify([props.sessionId, process.runId]);
  const messageDomId = (id: string): string =>
    `${idPrefix}-${encodeURIComponent(props.sessionId ?? "")}-${encodeURIComponent(id)}`;
  const processes = projectRunProcesses(
    timelineItems.flatMap((item) =>
      item.kind === "message" ? [item.message] : [],
    ),
    props.prompts,
    props.sessionId,
    props.reasoningByMessageId,
    props.runs,
    messages,
  );
  const beforeAnswer = new Map<string, RunProcess[]>();
  const beforeProcess = new Map<string, RunProcess[]>();
  const terminalAfter = new Map<string, RunProcess[]>();
  const processOwners = new Map<string, RunProcess>();
  // A failed turn's reason closes the turn, after its last message.
  const errorAfter = new Map<string, RunProcess[]>();
  const failedRunIds = new Set<string>();
  for (const process of processes) {
    const anchor = process.answerId ?? process.afterId;
    if (anchor) {
      const map = process.answerId ? beforeAnswer : terminalAfter;
      map.set(anchor, [...(map.get(anchor) ?? []), process]);
    }
    if (process.error) {
      failedRunIds.add(process.runId);
      if (anchor)
        errorAfter.set(anchor, [...(errorAfter.get(anchor) ?? []), process]);
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
  // A prompt that failed before its turn could form still answers under its message.
  const turnRunIds = new Set(processes.map((process) => process.runId));
  const promptErrorAfter = new Map<string, UiPromptError>();
  for (const prompt of props.prompts) {
    if (
      prompt.sessionId !== props.sessionId ||
      prompt.error === undefined ||
      (prompt.status !== "failed" && prompt.status !== "interrupted") ||
      (prompt.runId !== undefined && turnRunIds.has(prompt.runId)) ||
      isExpectedInterruption(
        prompt.status,
        prompt.error,
        props.runs?.find((run) => run.id === prompt.runId)?.terminalReason,
      )
    )
      continue;
    promptErrorAfter.set(prompt.userMessageId, prompt.error);
  }
  // A failure is announced once, and only for a turn seen running here;
  // failures already in the history when it loads stay quiet.
  const latestFailure = processes.filter((process) => process.error).at(-1);
  const failedRunId = latestFailure?.runId;
  const failureMessage = latestFailure?.error?.message;
  const activeRunId = props.isRunning ? props.activeRun?.id : undefined;
  const watchedRunId = useRef<string | undefined>(undefined);
  const [failureAnnouncement, setFailureAnnouncement] = useState("");
  useEffect(() => {
    if (activeRunId !== undefined) watchedRunId.current = activeRunId;
  }, [activeRunId]);
  useEffect(() => {
    if (failedRunId === undefined || failedRunId !== watchedRunId.current)
      return;
    watchedRunId.current = undefined;
    setFailureAnnouncement(failureMessage ?? "");
  }, [failedRunId, failureMessage]);
  // Copy sits on user messages and on each turn's final answer only, the
  // message the folded view shows (copy topic 02 §2.2). The newest finished
  // turn's answer keeps its row visible, as in Claude; none does while a turn
  // runs or when the newest turn ended without an answer.
  const answerRuns = new Map(
    processes.flatMap((process) =>
      process.answerId ? [[process.answerId, process] as const] : [],
    ),
  );
  const [forkingRunId, setForkingRunId] = useState<string | null>(null);
  const onFork = props.variant === "side-chat" ? undefined : props.onFork;
  const forkAction = (runId: string): MessageAction => ({
    key: "fork",
    node: (
      <IconButton
        label="Fork from here"
        // Two lines in the native tooltip: the name, then what it does.
        title={
          "Fork from here\nStarts a new session from this point. This one stays as it is."
        }
        // The fork arrow points right; it breathes rather than spins.
        className={forkingRunId === runId ? "is-pulsing" : undefined}
        aria-busy={forkingRunId === runId}
        disabled={forkingRunId !== null}
        onClick={() => {
          setForkingRunId(runId);
          void onFork?.(runId).finally(() => {
            setForkingRunId(null);
          });
        }}
      >
        {forkingRunId === runId ? (
          <LoaderCircle aria-hidden="true" size={14} />
        ) : (
          <Split aria-hidden="true" className="ohb-fork-icon" size={14} />
        )}
      </IconButton>
    ),
  });
  const latestAnswerId = props.isRunning
    ? undefined
    : processes.at(-1)?.answerId;
  const edit = props.variant === "side-chat" ? undefined : props.edit;
  // One bubble at a time; the state is gone on reload by design.
  const [editingId, setEditingId] = useState<string | null>(null);
  // Rewinding to before a compaction is refused by the backend
  // (session-rewind.ts REWIND_BEFORE_COMPACTION), so those prompts hide Edit.
  let lastCompaction = visibleMessages.length - 1;
  while (
    lastCompaction >= 0 &&
    !isCompactionMessage(visibleMessages[lastCompaction])
  )
    lastCompaction -= 1;
  const beforeCompaction = new Set(
    visibleMessages.slice(0, Math.max(0, lastCompaction)).map(({ id }) => id),
  );
  const editablePrompt = (
    message: UiMessage,
  ): UiPromptSubmission | undefined =>
    edit &&
    message.role === "user" &&
    message.runtimeInputKind === undefined &&
    !isCompactionMessage(message) &&
    !beforeCompaction.has(message.id)
      ? props.prompts.find(
          (prompt) =>
            prompt.userMessageId === message.id && prompt.status !== "steered",
        )
      : undefined;
  // The editor opens on the token and the request, split as the bubble is.
  const editorSeed = (
    message: UiMessage,
  ): { initialSkill: string | null; initialText: string } => {
    const split = splitSkillText(
      editablePrompt(message)?.text ?? messageBodyText(message),
      skillMarkerName(
        message.parts.find((part) => part.type === "text")?.metadata,
      ),
    );
    return { initialSkill: split.skill, initialText: split.text };
  };
  const editHints = (message: UiMessage): readonly string[] => {
    // A user message may carry no run id; its prompt names the turn.
    const ownRun = message.runId ?? editablePrompt(message)?.runId;
    const index = visibleMessages.indexOf(message);
    const later = new Set(
      visibleMessages
        .slice(index + 1)
        .flatMap((item) =>
          item.runId && item.runId !== ownRun ? [item.runId] : [],
        ),
    ).size;
    return [
      "File changes won't be undone",
      ...(later > 0
        ? [
            `${String(later)} later ${later === 1 ? "turn" : "turns"} will be removed`,
          ]
        : []),
      ...(edit?.stateHints ?? []),
    ];
  };
  const messageActions = (message: UiMessage): ReactNode => {
    const copyable =
      (message.role === "user" && !isCompactionMessage(message)) ||
      answerRuns.has(message.id);
    if (!copyable || messageBodyText(message) === "") return null;
    const answerRun = answerRuns.get(message.id);
    const forkRunId = answerRun?.runId;
    // A user message shows when it was sent; an answer, when its turn ended.
    // The turn's end is stored, so it reads the same after a reload; a
    // recovered turn's end is only when recovery ran, so it keeps createdAt.
    const at =
      answerRun && !answerRun.timing.recovered
        ? answerRun.timing.endedAt
        : message.createdAt;
    const time = formatMessageTime(at, today);
    const timeAction: readonly MessageAction[] = time
      ? [
          {
            key: "time",
            node: (
              <time
                className="ohb-message-time"
                dateTime={at}
                title={formatFullMessageTime(at)}
              >
                {time}
              </time>
            ),
          },
        ]
      : [];
    return (
      <MessageActions
        persistent={message.id === latestAnswerId}
        actions={[
          // Users' rows sit at the right, answers' at the left: the time takes
          // the outer end either way, with the buttons next to the message.
          ...(message.role === "user" ? timeAction : []),
          {
            key: "copy",
            node: (
              <CopyButton
                label={message.role === "user" ? "Copy message" : "Copy answer"}
                text={() => messageBodyText(message)}
              />
            ),
          },
          ...(onFork && forkRunId !== undefined ? [forkAction(forkRunId)] : []),
          ...(editablePrompt(message)
            ? [
                {
                  key: "edit",
                  node: (
                    <IconButton
                      label="Edit"
                      title={edit?.unavailable ?? "Edit"}
                      disabled={edit?.unavailable !== undefined}
                      onClick={() => {
                        setEditingId(message.id);
                      }}
                    >
                      <Pencil aria-hidden="true" size={14} />
                    </IconButton>
                  ),
                },
              ]
            : []),
          ...(message.role === "user" ? [] : timeAction),
        ]}
      />
    );
  };
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
  const renderPromptError = (error: UiPromptError | undefined): ReactNode =>
    error ? <TurnError error={error} /> : null;
  const renderTurnError = (process: RunProcess): ReactNode =>
    process.error ? (
      <TurnError
        key={`error:${process.runId}`}
        error={process.error}
        relatedSubagents={props.resultSources?.filter(
          (source) => source.runId === process.runId,
        )}
      />
    ) : null;
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
        key={process.runId}
        timing={process.timing}
        label={turnTriggerLabel(process.trigger)}
        disclosure={
          process.foldable
            ? {
                open: isOpen(process),
                controls: controls.join(" "),
                id: `${messageDomId(`run:${process.runId}`)}-disclosure`,
                onToggle: (): void => {
                  const stream = streamRef.current;
                  const id = `${messageDomId(`run:${process.runId}`)}-disclosure`;
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
                  readingPosition.blockIndex = undefined;
                  readingPosition.blockOffset = undefined;
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
    toggleAnchor.current = null;
    stickToBottomRef.current = readingPosition.sticky;
    if (streamRef.current) streamRef.current.scrollTop = readingPosition.top;
    scheduleStickScroll();
  }, [activeSessionId, scheduleStickScroll]);

  // Sending is a request to see the new prompt, like Claude and Codex: it
  // re-arms following that an upward scroll or a manual disclosure turned off.
  useLayoutEffect(() => {
    if (!props.followToken) return;
    toggleAnchor.current = null;
    stickToBottomRef.current = true;
    readingPosition.sticky = true;
    scheduleStickScroll();
  }, [props.followToken, readingPosition, scheduleStickScroll]);

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
      readingPosition.blockIndex = undefined;
      readingPosition.blockOffset = undefined;
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
          .getElementById(`${messageDomId(`run:${owner.runId}`)}-disclosure`)
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
        `${messageDomId(`run:${owner.runId}`)}-disclosure`,
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
        position.blockIndex = undefined;
        position.blockOffset = undefined;
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
    props.compacting,
    props.compactNotice,
    scheduleStickScroll,
  ]);

  // Earlier pages land above the reading row: put it back before paint. The
  // row is the one from the user's latest scroll, not from the request start.
  useLayoutEffect(() => {
    const element = streamRef.current;
    if (element && !stickToBottomRef.current)
      restoreReadingRow(element, readingPosition);
  }, [messagesSignature]);

  /** Loads an earlier page near the top; see 02 §2.5 for the rules. */
  const maybeLoadEarlier = useCallback(
    (element: HTMLElement, userInput: boolean): void => {
      const { props: current, readingPosition: position } = latest.current;
      if (!(current.historyHasMore || current.historyStale)) return;
      if (requestPendingRef.current || current.historyState === "loading")
        return;
      if (
        current.historyState === "error" &&
        (!userInput ||
          Date.now() - requestEndedAtRef.current < HISTORY_RETRY_COOLDOWN_MS)
      )
        return;
      const near = stickToBottomRef.current
        ? element.scrollHeight <= element.clientHeight + 1
        : element.scrollTop <= element.clientHeight;
      if (!near) return;
      // The new page lands above: pin a row the user can actually see now.
      if (!stickToBottomRef.current) {
        const row = position.messageId
          ? findRow(element, position.messageId)
          : undefined;
        if (!row || !visibleRowRect(row)) captureReadingRow(element, position);
      }
      requestPendingRef.current = true;
      void current
        .onLoadHistory()
        .catch(() => false)
        .then((advanced) => {
          requestPendingRef.current = false;
          requestEndedAtRef.current = Date.now();
          // No progress: stop and wait for the user or new messages.
          if (!advanced) return;
          requestAnimationFrame(() => {
            const stream = streamRef.current;
            if (stream) maybeLoadEarlier(stream, false);
          });
        });
    },
    [],
  );

  useEffect(() => {
    const element = streamRef.current;
    if (element) maybeLoadEarlier(element, false);
  }, [
    messagesSignature,
    props.historyHasMore,
    props.historyStale,
    maybeLoadEarlier,
  ]);

  useEffect(() => {
    const element = streamRef.current;
    if (!element) {
      return;
    }
    let userScroll = false;
    let lastTop = element.scrollTop;
    let touchY: number | undefined;
    const markUserScroll = (): void => {
      userScroll = true;
    };
    // Leaving the bottom must win at once: waiting for the scroll event lets a
    // streaming update snap back first and cancel the user's smooth scroll.
    const leaveBottom = (): void => {
      if (element.scrollHeight <= element.clientHeight) return;
      userScroll = true;
      if (!stickToBottomRef.current) return;
      stickToBottomRef.current = false;
      readingPosition.sticky = false;
      if (scheduledScrollRef.current !== null) {
        globalThis.clearTimeout(scheduledScrollRef.current);
        scheduledScrollRef.current = null;
      }
    };
    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY < 0 && !scrollsNested(event.target, element)) {
        leaveBottom();
        maybeLoadEarlier(element, true);
      } else {
        markUserScroll();
      }
    };
    const onTouchStart = (event: TouchEvent): void => {
      touchY = event.touches.item(0)?.clientY;
    };
    const onTouchMove = (event: TouchEvent): void => {
      const y = event.touches.item(0)?.clientY;
      // A finger moving down scrolls the content up.
      if (
        touchY !== undefined &&
        y !== undefined &&
        y > touchY &&
        !scrollsNested(event.target, element)
      ) {
        leaveBottom();
        maybeLoadEarlier(element, true);
      } else markUserScroll();
      touchY = y;
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        ["ArrowUp", "PageUp", "Home"].includes(event.key) &&
        !scrollsNested(event.target, element)
      ) {
        leaveBottom();
        maybeLoadEarlier(element, true);
      } else markUserScroll();
    };
    const onScroll = (): void => {
      const movedUp = element.scrollTop < lastTop;
      const maxTop = element.scrollHeight - element.clientHeight;
      // Folding can move the viewport up even after a click or wheel at the
      // bottom. The old position no longer fits the shortened stream.
      if (
        stickToBottomRef.current &&
        lastTop > maxTop + 1 &&
        isNearBottom(element)
      ) {
        userScroll = false;
      }
      lastTop = element.scrollTop;
      // Only a user scroll heading down can re-arm following.
      if (userScroll && !movedUp) {
        stickToBottomRef.current = isNearBottom(element);
      } else if (userScroll && movedUp) {
        stickToBottomRef.current = false;
      }
      readingPosition.top = element.scrollTop;
      readingPosition.sticky = stickToBottomRef.current;
      captureReadingRow(element, readingPosition);
      if (userScroll && stickToBottomRef.current) {
        props.onNearEnd?.();
      }
      const userInput = userScroll;
      userScroll = false;
      maybeLoadEarlier(element, userInput);
    };
    element.addEventListener("scroll", onScroll);
    element.addEventListener("wheel", onWheel, { passive: true });
    element.addEventListener("touchstart", onTouchStart, { passive: true });
    element.addEventListener("touchmove", onTouchMove, { passive: true });
    element.addEventListener("pointerdown", markUserScroll);
    element.addEventListener("keydown", onKeyDown);
    return (): void => {
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("touchstart", onTouchStart);
      element.removeEventListener("touchmove", onTouchMove);
      element.removeEventListener("pointerdown", markUserScroll);
      element.removeEventListener("keydown", onKeyDown);
    };
  }, [readingPosition, props.onNearEnd, maybeLoadEarlier]);

  useEffect(() => {
    const inner = streamInnerRef.current;
    if (!inner || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      const element = streamRef.current;
      if (element && !stickToBottomRef.current)
        restoreReadingRow(element, readingPosition);
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
        {props.historyHasMore || props.historyStale ? (
          // One fixed-height slot in every state; only a spinner shows.
          <div className="ohb-history-slot">
            <div className="ohb-visually-hidden" role="status">
              {props.historyState === "loading"
                ? "Loading earlier messages"
                : ""}
            </div>
            {props.historyState === "loading" ? <Spinner /> : null}
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
                {editingId === item.message.id &&
                editablePrompt(item.message) ? (
                  <UserMessageEditor
                    {...editorSeed(item.message)}
                    listCommands={edit?.listCommands}
                    commandCatalogVersion={edit?.commandCatalogVersion}
                    hints={editHints(item.message)}
                    onCancel={() => {
                      setEditingId(null);
                    }}
                    onSend={async (input) => {
                      const promptId = editablePrompt(item.message)?.promptId;
                      if (!edit || promptId === undefined) return null;
                      const failure = await edit.send(promptId, input);
                      if (failure === null) setEditingId(null);
                      return failure;
                    }}
                  />
                ) : (
                  <MessageRow
                    message={item.message}
                    activeRunId={activeRunId}
                    steerState={
                      props.unconsumedSteers?.find(
                        (input) => input.messageId === item.message.id,
                      )?.state
                    }
                    reasoning={props.reasoningByMessageId[item.message.id]}
                    hideInterruptionNote={
                      item.message.runId !== undefined &&
                      failedRunIds.has(item.message.runId)
                    }
                    reasoningIdPrefix={`${messageDomId(item.message.id)}-reasoning`}
                    reasoningHidden={(
                      beforeAnswer.get(item.message.id) ?? []
                    ).some((process) => process.foldable && !isOpen(process))}
                    beforeText={(beforeAnswer.get(item.message.id) ?? [])
                      .filter((process) => !process.foldable)
                      .map(renderDuration)}
                    actions={messageActions(item.message)}
                    expandSignal={
                      props.anchorMessageId === item.message.id
                        ? props.anchorToken
                        : undefined
                    }
                  />
                )}
                {(terminalAfter.get(item.message.id) ?? []).map(renderDuration)}
                {(errorAfter.get(item.message.id) ?? []).map(renderTurnError)}
                {renderPromptError(promptErrorAfter.get(item.message.id))}
              </div>
            </Fragment>
          ) : (
            <PromptProjectionRow key={`prompt:${item.row.id}`} row={item.row} />
          ),
        )}
        {processes
          .filter((process) => !process.answerId && !process.afterId)
          .flatMap((process) => [
            renderDuration(process),
            renderTurnError(process),
          ])}
        {props.commandNotices}
        <div className="ohb-visually-hidden" role="status">
          {failureAnnouncement}
        </div>
        {props.isRunning ? (
          <ModelWaiting
            run={props.activeRun}
            messages={messages}
            reasoningByMessageId={props.reasoningByMessageId}
          />
        ) : null}
        {props.compacting ? <Compacting /> : null}
        {props.compactNotice ? (
          <div className="ohb-compact-notice" role="status">
            {props.compactNotice}
          </div>
        ) : null}
      </div>
      {props.onAskInSideChat && props.variant !== "side-chat" ? (
        <SelectionAction
          container={streamRef}
          label="Ask in side chat"
          icon={MessageCircleQuestion}
          onAction={props.onAskInSideChat}
        />
      ) : null}
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
