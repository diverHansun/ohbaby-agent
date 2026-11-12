import { ArrowUp, LoaderCircle, Square } from "lucide-react";
import {
  type ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  SideChatConnection,
  SideChatEntry,
} from "../../runtime/side-chat.js";
import { ComposerInput } from "../composer/ComposerInput.js";
import { fitComposerTextarea } from "../composer/composerTextarea.js";
import { isImeComposing } from "../composer/ime.js";
import { ConversationPresentation } from "../conversation/ConversationPresentation.js";
import {
  ConversationStream,
  type PromptProjectionModel,
} from "../conversation/ConversationStream.js";
import { DurationSampleContext } from "../conversation/use-execution-duration.js";
import { ApprovalPanel } from "../permissions/ApprovalPanel.js";
import {
  hasActiveTurnForSession,
  type LocalPromptAttempt,
  promptMatchesAttempt,
  selectPromptProjection,
  shouldKeepPromptAttempt,
} from "../session/prompt-projection.js";
import { isConnectionAbnormal, selectViewModel } from "../session/selectors.js";
import { useStopRequest } from "../session/use-stop-request.js";
import { Banner } from "../shared/Banner.js";
import { readableError } from "../shared/error-text.js";
import { selectSideChatView } from "./side-chat-view.js";

const TEXTAREA_FIT = { lineHeight: 22, maxLines: 6 } as const;
const NO_SLASH = {
  open: false,
  items: [],
  selectedIndex: 0,
  error: null,
  onHover: (): void => undefined,
  onRun: (): void => undefined,
} as const;

/**
 * One side chat in the right panel (frontend design §3.1): its own messages
 * after the boundary, approvals, and an input with Send and Stop only. It
 * looks like the main chat; the tab title and the empty state tell them apart.
 */
export function SideChatPage(props: {
  readonly connection: SideChatConnection;
  readonly entry: SideChatEntry;
}): ReactElement {
  const { connection, entry } = props;
  const sideChatId = entry.sideChatId;
  const snapshot = useSyncExternalStore(
    (listener) => connection.store.subscribe(listener),
    () => connection.store.getSnapshot(),
  );
  const { view, boundaryLoaded } = useMemo(
    () =>
      selectSideChatView(selectViewModel(snapshot), entry.boundaryMessageId),
    [snapshot, entry.boundaryMessageId],
  );
  const [error, setError] = useState<string | null>(null);
  const [followToken, setFollowToken] = useState(0);
  const [attempts, setAttempts] = useState<readonly LocalPromptAttempt[]>([]);
  useEffect(() => {
    setAttempts((current) => {
      const kept = current.filter((attempt) =>
        shouldKeepPromptAttempt(attempt, view.snapshot),
      );
      return kept.length === current.length ? current : kept;
    });
  }, [view.snapshot]);
  const projection = useMemo(
    () => selectPromptProjection({ attempts, view }),
    [attempts, view],
  );
  // A message sent during a turn waits its turn; it shows at the end, marked.
  const queuedRows = useMemo((): readonly PromptProjectionModel[] => {
    const queued = view.queuedPrompts.map((prompt) => ({
      clientRequestId: prompt.clientRequestId,
      createdAt: prompt.createdAt,
      id: prompt.userMessageId,
      label: "Queued",
      text: prompt.text,
    }));
    const waiting = attempts
      .filter(
        (attempt) =>
          attempt.placement === "queue" &&
          !view.snapshot?.prompts?.some((prompt) =>
            promptMatchesAttempt(prompt, attempt),
          ),
      )
      .map((attempt) => ({
        clientRequestId: attempt.clientRequestId,
        createdAt: attempt.createdAt,
        id: attempt.userMessageId ?? `pending:${attempt.clientRequestId}`,
        label: "Queued",
        text: attempt.text,
      }));
    return [...queued, ...waiting];
  }, [attempts, view.queuedPrompts, view.snapshot]);
  const rows = useMemo(
    () => [
      ...projection.rows,
      ...queuedRows.filter(
        (queued) =>
          !projection.rows.some(
            (row) => row.clientRequestId === queued.clientRequestId,
          ),
      ),
    ],
    [projection.rows, queuedRows],
  );

  const submit = useCallback(
    async (text: string): Promise<boolean> => {
      const clientRequestId = globalThis.crypto.randomUUID();
      setError(null);
      setFollowToken((token) => token + 1);
      setAttempts((current) => [
        ...current,
        {
          clientRequestId,
          createdAt: new Date().toISOString(),
          originSessionId: sideChatId,
          placement:
            hasActiveTurnForSession(view.snapshot, sideChatId) ||
            current.some((attempt) => attempt.placement === "conversation")
              ? "queue"
              : "conversation",
          submittedSessionId: sideChatId,
          text,
        },
      ]);
      try {
        const receipt = await connection.client.submitPromptAccepted(text, {
          clientRequestId,
          sessionId: sideChatId,
        });
        setAttempts((current) =>
          current.map((attempt) =>
            attempt.clientRequestId === clientRequestId
              ? { ...attempt, userMessageId: receipt.userMessageId }
              : attempt,
          ),
        );
        return true;
      } catch (caught) {
        setAttempts((current) =>
          current.filter(
            (attempt) => attempt.clientRequestId !== clientRequestId,
          ),
        );
        setError(caught instanceof Error ? caught.message : String(caught));
        return false;
      }
    },
    [connection, sideChatId, view.snapshot],
  );
  const stopRequest = useStopRequest(
    connection,
    view.composer.activeSessionId,
    view.composer.activeRunId,
    setError,
  );

  const approving = view.pendingPermissions.length > 0;
  const empty =
    view.isEmpty && rows.length === 0 && !view.composer.isRunning && !approving;
  const offline = isConnectionAbnormal(view.header.connectionKind);
  const shownError = error ?? (offline ? null : view.error);
  return (
    <div className={`ohb-side-chat${approving ? " has-approval" : ""}`}>
      {offline ? (
        <p className="ohb-side-notice" role="status">
          Reconnecting…
        </p>
      ) : null}
      {empty ? (
        <div className="ohb-side-chat-empty">
          <p>No messages yet</p>
          <small>Sees this chat up to now. The main chat won’t see it.</small>
        </div>
      ) : (
        <DurationSampleContext.Provider value={snapshot.durationSample}>
          <ConversationPresentation.Provider value={{}}>
            <ConversationStream
              variant="side-chat"
              historyState={snapshot.historyState}
              historyHasMore={!boundaryLoaded && snapshot.historyHasMore}
              historyStale={snapshot.historyStale}
              historyError={snapshot.historyError}
              onLoadHistory={() => connection.loadEarlierHistory()}
              promptRows={rows}
              startupThinkingAt={projection.startupThinkingAt}
              messages={view.activeSession?.messages ?? []}
              sessionId={sideChatId}
              prompts={(view.snapshot?.prompts ?? []).filter(
                (prompt) => prompt.sessionId === sideChatId,
              )}
              runs={(view.snapshot?.runs ?? []).filter(
                (run) => run.sessionId === sideChatId,
              )}
              activeRun={
                offline
                  ? undefined
                  : view.snapshot?.runs.find(
                      (run) => run.id === view.composer.activeRunId,
                    )
              }
              isRunning={view.composer.isRunning}
              reasoningByMessageId={view.reasoningByMessageId}
              commandNotices={null}
              followToken={followToken}
            />
          </ConversationPresentation.Provider>
        </DurationSampleContext.Provider>
      )}
      <ApprovalPanel
        disabled={snapshot.permissionSync.status !== "ready"}
        error={snapshot.permissionSync.error}
        syncing={snapshot.permissionSync.status === "syncing"}
        onRetry={() => {
          connection.retryPermissions();
        }}
        onRespond={async (request, choice) => {
          try {
            setError(null);
            await connection.client.respondPermission(request.id, {
              choiceId: choice.id,
            });
            return true;
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
            return false;
          }
        }}
        onCancel={stopRequest.stop}
        canCancel={view.composer.canStop}
        cancelLabel={stopRequest.label}
        permissions={view.pendingPermissions}
      />
      <div
        className="ohb-composer ohb-side-chat-composer"
        inert={approving}
        hidden={approving}
      >
        <Banner
          tone="error"
          message={shownError ? readableError(shownError) : null}
          onDismiss={
            error === null
              ? undefined
              : (): void => {
                  setError(null);
                }
          }
        />
        <SideChatInput
          connection={connection}
          canSend={view.composer.canSend}
          isRunning={view.composer.isRunning}
          canStop={view.composer.canStop}
          stopLabel={stopRequest.label}
          onStop={stopRequest.stop}
          onSubmit={submit}
        />
      </div>
    </div>
  );
}

/** The input card: text, then Send, or Stop while a turn runs and nothing is typed. */
function SideChatInput(props: {
  readonly connection: SideChatConnection;
  readonly canSend: boolean;
  readonly isRunning: boolean;
  readonly canStop: boolean;
  readonly stopLabel?: string;
  readonly onStop: () => void;
  readonly onSubmit: (text: string) => Promise<boolean>;
}): ReactElement {
  const { draft } = props.connection;
  const { text, focusToken } = useSyncExternalStore(
    draft.subscribe,
    draft.getSnapshot,
  );
  const inputRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [sending, setSending] = useState(false);
  useLayoutEffect(() => {
    if (textareaRef.current)
      fitComposerTextarea(textareaRef.current, TEXTAREA_FIT);
  }, [text]);
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || !draft.consumeFocus()) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, [draft, focusToken]);
  const canSend = props.canSend && !sending && text.trim() !== "";
  const showStop =
    props.stopLabel !== undefined || (props.isRunning && text.trim() === "");
  const send = (): void => {
    const sent = text.trim();
    if (!canSend) return;
    setSending(true);
    draft.set("");
    void props
      .onSubmit(sent)
      .then((accepted) => {
        // A failed send gives the text back unless something new was typed.
        if (!accepted && draft.getSnapshot().text === "") draft.set(sent);
      })
      .finally(() => {
        setSending(false);
      });
  };
  return (
    <ComposerInput
      inputRef={inputRef}
      textareaRef={textareaRef}
      planMode={false}
      compact={false}
      draft={text}
      ariaLabel="Side chat message"
      placeholder="Ask a quick question"
      disabled={false}
      readOnly={false}
      onChange={draft.set}
      onKeyDown={(event) => {
        if (isImeComposing(event)) return;
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          send();
        }
      }}
      slash={NO_SLASH}
      queueError={null}
      queuedEdit={null}
      controls={
        showStop ? (
          <button
            aria-busy={props.stopLabel !== undefined}
            aria-label={props.stopLabel ?? "Stop run"}
            className="ohb-stop-button"
            disabled={props.stopLabel !== undefined || !props.canStop}
            onClick={props.onStop}
            title={props.stopLabel ?? "Stop run"}
            type="button"
          >
            {props.stopLabel ? (
              <LoaderCircle
                aria-hidden="true"
                className="ohb-stop-pending"
                size={14}
              />
            ) : (
              <Square size={10} fill="currentColor" />
            )}
          </button>
        ) : (
          <button
            aria-busy={sending}
            aria-label="Send message"
            className="ohb-send-button"
            disabled={!canSend}
            onClick={send}
            title="Send message"
            type="button"
          >
            {sending ? (
              <LoaderCircle
                aria-hidden="true"
                className="ohb-send-spinner"
                size={14}
              />
            ) : (
              <ArrowUp size={15} />
            )}
          </button>
        )
      }
    />
  );
}
