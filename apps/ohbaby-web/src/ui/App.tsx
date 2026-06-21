import { Bot, ChevronDown, Send, Square, User } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ChangeEvent, KeyboardEvent, ReactElement } from "react";
import type { FocusEvent } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type {
  UiMessage,
  UiMessagePart,
  UiPermissionChoice,
  UiPermissionLevel,
  UiPermissionMode,
  UiPermissionRequest,
} from "ohbaby-sdk";
import type { OhbabyWebRuntime } from "../api/daemon/client.js";
import type { CommandNotice } from "../api/daemon/wire.js";
import { MarkdownBlock } from "./MarkdownBlock.js";
import {
  selectViewModel,
  type HeaderModel,
  type ViewModel,
} from "./selectors.js";

interface AppProps {
  readonly runtime: OhbabyWebRuntime;
}

let mountedRoot: Root | undefined;

export function mountOhbabyWebApp(runtime: OhbabyWebRuntime): void {
  const rootElement = document.getElementById("root");
  if (!rootElement) {
    throw new Error("Missing #root element");
  }
  mountedRoot?.unmount();
  mountedRoot = createRoot(rootElement);
  mountedRoot.render(<OhbabyWebApp runtime={runtime} />);
}

export function mountBootstrapError(error: unknown): void {
  const rootElement = document.getElementById("root");
  if (!rootElement) {
    return;
  }
  mountedRoot?.unmount();
  mountedRoot = createRoot(rootElement);
  mountedRoot.render(<BootstrapError error={error} />);
}

export function OhbabyWebApp({ runtime }: AppProps): ReactElement {
  const storeSnapshot = useSyncExternalStore(
    (listener) => runtime.store.subscribe(listener),
    () => runtime.store.getSnapshot(),
    () => runtime.store.getSnapshot(),
  );
  const view = useMemo(() => selectViewModel(storeSnapshot), [storeSnapshot]);
  const [actionError, setActionError] = useState<string | null>(null);
  const clearActionError = useCallback(() => {
    setActionError(null);
  }, []);
  const showMain = !view.isEmpty || view.commandNotices.length > 0;

  const runAction = useCallback(
    async (action: () => Promise<void>): Promise<boolean> => {
      try {
        clearActionError();
        await action();
        return true;
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [clearActionError],
  );

  const submitText = useCallback(
    (text: string): Promise<boolean> =>
      runAction(() =>
        text.startsWith("/")
          ? runtime.client.executeSlashCommand({
              ...(view.composer.activeSessionId === undefined
                ? {}
                : { sessionId: view.composer.activeSessionId }),
              text,
            })
          : runtime.client.submitPrompt({
              ...(view.composer.activeSessionId === undefined
                ? {}
                : { sessionId: view.composer.activeSessionId }),
              text,
            }),
      ),
    [runAction, runtime.client, view.composer.activeSessionId],
  );

  return (
    <main
      className={showMain ? "ohb-app ohb-app-main" : "ohb-app ohb-app-empty"}
    >
      {showMain ? (
        <>
          <StatusBar header={view.header} />
          <ErrorBanner
            message={actionError ?? view.error}
            onDismiss={clearActionError}
          />
          <ConversationStream view={view} />
          <PermissionModal
            disabled={view.composer.disabled}
            onRespond={(request, choice) => {
              void runAction(() =>
                runtime.client.respondPermission(request.id, {
                  choiceId: choice.id,
                }),
              );
            }}
            permissions={view.pendingPermissions}
          />
          <Composer
            onSetPermission={(input) => {
              void runAction(() => runtime.client.setPermission(input));
            }}
            onSubmit={submitText}
            onStop={() => {
              void runAction(() =>
                view.composer.activeSessionId === undefined
                  ? Promise.resolve()
                  : runtime.client.abortSession(
                      view.composer.activeSessionId,
                      view.composer.activeRunId,
                    ),
              );
            }}
            view={view}
          />
        </>
      ) : (
        <>
          <ErrorBanner
            message={actionError ?? view.error}
            onDismiss={clearActionError}
          />
          <EmptyState
            onSetPermission={(input) => {
              void runAction(() => runtime.client.setPermission(input));
            }}
            onSubmit={submitText}
            status={view.header}
            view={view}
          />
        </>
      )}
    </main>
  );
}

function BootstrapError(props: { readonly error: unknown }): ReactElement {
  const message =
    props.error instanceof Error ? props.error.message : String(props.error);
  return (
    <main className="ohb-app ohb-app-empty">
      <div className="ohb-bootstrap-error" role="alert">
        <StatusPill kind="disconnected" />
        <p>{message}</p>
      </div>
    </main>
  );
}

function EmptyState(props: {
  readonly onSetPermission: (input: {
    readonly level?: UiPermissionLevel;
    readonly mode?: UiPermissionMode;
  }) => void;
  readonly onSubmit: (text: string) => Promise<boolean>;
  readonly status: HeaderModel;
  readonly view: ViewModel;
}): ReactElement {
  const contextLine = [
    props.view.activeSession?.title ?? "ohbaby-agent",
    props.view.activeSession?.projectRoot ?? "workspace ready",
    props.status.modelLabel,
  ];
  return (
    <>
      <div className="ohb-empty-status">
        <StatusPill kind={props.status.connectionKind} />
      </div>
      <section className="ohb-empty-hero">
        <div className="ohb-wordmark" aria-label="ohbaby">
          <span>oh</span>
          <span>ba</span>
          <span>by</span>
        </div>
        <div className="ohb-empty-context">
          {contextLine.map((item, index) => (
            <span key={`${item}-${String(index)}`}>{item}</span>
          ))}
        </div>
        <Composer
          compact
          onSetPermission={props.onSetPermission}
          onSubmit={props.onSubmit}
          onStop={() => undefined}
          view={props.view}
        />
      </section>
    </>
  );
}

function StatusBar(props: { readonly header: HeaderModel }): ReactElement {
  return (
    <header className="ohb-statusbar">
      <div className="ohb-brand" aria-label="ohbaby">
        <span className="ohb-logo-grid" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </span>
        <span>OHBABY</span>
      </div>
      <div className="ohb-statusbar-meta">
        <StatusPill kind={props.header.connectionKind} />
        <span className="ohb-divider" />
        <span className="ohb-model">{props.header.modelLabel}</span>
        <span className="ohb-divider" />
        <span className="ohb-context">
          <span className="ohb-context-bar">
            <span
              style={{ width: `${String(props.header.contextRatio * 100)}%` }}
            />
          </span>
          <span>{props.header.contextLabel}</span>
        </span>
      </div>
    </header>
  );
}

function StatusPill(props: {
  readonly kind: HeaderModel["connectionKind"];
}): ReactElement {
  return (
    <span className={`ohb-status-pill ohb-status-${props.kind}`}>
      <span />
      {props.kind}
    </span>
  );
}

function ErrorBanner(props: {
  readonly message: string | null;
  readonly onDismiss: () => void;
}): ReactElement | null {
  if (!props.message) {
    return null;
  }
  return (
    <div className="ohb-error-banner" role="alert">
      <span>{props.message}</span>
      <button onClick={props.onDismiss} type="button">
        Dismiss
      </button>
    </div>
  );
}

function ConversationStream(props: { readonly view: ViewModel }): ReactElement {
  const streamRef = useRef<HTMLDivElement | null>(null);
  const messages = props.view.activeSession?.messages ?? [];
  useEffect(() => {
    const element = streamRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [messages.length, props.view.composer.isRunning]);

  return (
    <section className="ohb-stream" ref={streamRef}>
      <div className="ohb-stream-inner">
        {messages.map((message) => (
          <MessageRow key={message.id} message={message} />
        ))}
        <CommandNoticeList notices={props.view.commandNotices} />
        {props.view.composer.isRunning ? <ThinkingIndicator /> : null}
      </div>
    </section>
  );
}

function CommandNoticeList(props: {
  readonly notices: readonly CommandNotice[];
}): ReactElement | null {
  if (props.notices.length === 0) {
    return null;
  }
  return (
    <div className="ohb-command-notices">
      {props.notices.map((notice) => (
        <article
          className={`ohb-command-notice ohb-command-${notice.kind}`}
          key={notice.id}
        >
          <div className="ohb-command-label">
            <span>{notice.kind}</span>
            <span>
              {notice.path.length > 0
                ? `/${notice.path.join(" ")}`
                : notice.commandId}
            </span>
          </div>
          {notice.markdown ? (
            <MarkdownBlock text={notice.markdown} />
          ) : (
            <pre>{notice.text ?? ""}</pre>
          )}
        </article>
      ))}
    </div>
  );
}

function MessageRow(props: { readonly message: UiMessage }): ReactElement {
  const isUser = props.message.role === "user";
  const isAssistant = props.message.role === "assistant";
  const label = isUser ? "You" : isAssistant ? "ohbaby" : props.message.role;
  return (
    <article className={`ohb-message ohb-message-${props.message.role}`}>
      <div className="ohb-message-label">
        {isUser ? <User size={14} /> : <Bot size={14} />}
        <span>{label}</span>
      </div>
      <div className="ohb-message-body">
        {props.message.parts.map((part, index) => (
          <MessagePart
            isStreaming={props.message.status === "streaming"}
            key={`${props.message.id}-${String(index)}`}
            part={part}
          />
        ))}
      </div>
    </article>
  );
}

function MessagePart(props: {
  readonly isStreaming: boolean;
  readonly part: UiMessagePart;
}): ReactElement {
  switch (props.part.type) {
    case "text":
      return props.isStreaming ? (
        <pre className="ohb-streaming-text">{props.part.text}</pre>
      ) : (
        <MarkdownBlock text={props.part.text} />
      );
    case "reasoning":
      return <pre className="ohb-reasoning">{props.part.text}</pre>;
    case "tool-call":
      return (
        <ToolPanel
          accent={toolAccent(props.part.call.name)}
          body={JSON.stringify(props.part.call.input, null, 2)}
          meta={props.part.call.status}
          title={props.part.call.name}
        />
      );
    case "tool-result":
      return (
        <ToolPanel
          accent={props.part.result.error ? "red" : "green"}
          body={props.part.result.output}
          meta={props.part.result.error ?? "result"}
          title={`result ${props.part.result.callId}`}
        />
      );
  }
}

function ToolPanel(props: {
  readonly accent: "blue" | "gold" | "green" | "red";
  readonly body: string;
  readonly meta: string;
  readonly title: string;
}): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className={`ohb-tool-panel ohb-tool-${props.accent}`}>
      <button
        onClick={() => {
          setOpen((value) => !value);
        }}
        type="button"
      >
        <span>{props.title}</span>
        <span>{props.meta}</span>
        <ChevronDown className={open ? "ohb-chevron-open" : ""} size={16} />
      </button>
      {open ? <pre>{props.body}</pre> : null}
    </div>
  );
}

function ThinkingIndicator(): ReactElement {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1_000);
    return (): void => {
      window.clearInterval(timer);
    };
  }, []);
  return (
    <div className="ohb-thinking">
      <span aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>Thinking</span>
      <span>· {String(elapsedSeconds)}s</span>
      <span>· double click esc to interrupt</span>
    </div>
  );
}

function PermissionModal(props: {
  readonly disabled: boolean;
  readonly onRespond: (
    request: UiPermissionRequest,
    choice: UiPermissionChoice,
  ) => void;
  readonly permissions: readonly UiPermissionRequest[];
}): ReactElement | null {
  if (props.permissions.length === 0) {
    return null;
  }
  const [request] = props.permissions;
  return (
    <div className="ohb-permission-layer">
      <section className="ohb-permission-modal" role="dialog" aria-modal="true">
        <div className="ohb-permission-copy">
          <h2>{request.title}</h2>
          <p>{request.description}</p>
          {props.permissions.length > 1 ? (
            <span>
              {String(props.permissions.length - 1)} pending after this
            </span>
          ) : null}
        </div>
        <div className="ohb-permission-actions">
          {request.choices.map((choice) => (
            <button
              className={
                choice.intent === "allow" ? "ohb-button-primary" : "ohb-button"
              }
              disabled={props.disabled}
              key={choice.id}
              onClick={() => {
                props.onRespond(request, choice);
              }}
              type="button"
            >
              {choice.label}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function Composer(props: {
  readonly compact?: boolean;
  readonly onSetPermission: (input: {
    readonly level?: UiPermissionLevel;
    readonly mode?: UiPermissionMode;
  }) => void;
  readonly onStop: () => void;
  readonly onSubmit: (text: string) => Promise<boolean>;
  readonly view: ViewModel;
}): ReactElement {
  const [draft, setDraft] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const lastEscapeAt = useRef(0);
  const policyRef = useRef<HTMLDivElement | null>(null);
  const canSend =
    props.view.composer.canSend && draft.trim().length > 0 && !isSubmitting;

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text || !props.view.composer.canSend) {
      return;
    }
    setIsSubmitting(true);
    void props
      .onSubmit(text)
      .then((sent) => {
        if (sent) {
          setDraft("");
        }
      })
      .finally(() => {
        setIsSubmitting(false);
      });
  }, [draft, props]);

  const cycleMode = useCallback(() => {
    const mode = props.view.composer.mode === "auto" ? "plan" : "auto";
    props.onSetPermission({ mode });
  }, [props]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        send();
        return;
      }
      if (event.key === "Tab" && event.shiftKey) {
        event.preventDefault();
        cycleMode();
        return;
      }
      if (event.key === "Escape" && props.view.composer.canStop) {
        const now = Date.now();
        if (now - lastEscapeAt.current < 650) {
          props.onStop();
          lastEscapeAt.current = 0;
        } else {
          lastEscapeAt.current = now;
        }
      }
    },
    [cycleMode, props, send],
  );

  return (
    <section
      className={
        props.compact ? "ohb-composer ohb-composer-hero" : "ohb-composer"
      }
    >
      <div className="ohb-composer-input">
        <span className="ohb-prompt">&gt;</span>
        <textarea
          disabled={props.view.composer.disabled || isSubmitting}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
            setDraft(event.target.value);
          }}
          onKeyDown={onKeyDown}
          placeholder={composerPlaceholder(props.view)}
          rows={1}
          value={draft}
        />
        {props.view.composer.isRunning ? (
          <button
            className="ohb-stop-button"
            disabled={!props.view.composer.canStop}
            onClick={props.onStop}
            title="Stop run"
            type="button"
          >
            <Square size={14} />
            <span>Stop</span>
          </button>
        ) : (
          <button
            className="ohb-send-button"
            disabled={!canSend}
            onClick={send}
            title="Send message"
            type="button"
          >
            <Send size={14} />
            <span>Send</span>
          </button>
        )}
      </div>
      <div className="ohb-composer-tools">
        <button
          className={`ohb-mode-button ohb-mode-${props.view.composer.mode}`}
          disabled={props.view.composer.disabled}
          onClick={cycleMode}
          title="Switch mode"
          type="button"
        >
          <span />
          {props.view.composer.mode} mode
        </button>
        <div
          className="ohb-policy-control"
          onBlur={(event: FocusEvent<HTMLDivElement>) => {
            const nextTarget = event.relatedTarget;
            if (
              !(nextTarget instanceof Node) ||
              !event.currentTarget.contains(nextTarget)
            ) {
              setPermissionOpen(false);
            }
          }}
          ref={policyRef}
        >
          <button
            className="ohb-policy-button"
            disabled={props.view.composer.disabled}
            onClick={() => {
              setPermissionOpen((open) => !open);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setPermissionOpen(false);
              }
            }}
            title="Permission policy"
            type="button"
          >
            <span className="ohb-policy-glyph" aria-hidden="true" />
            {props.view.composer.permissionLevel}
            <ChevronDown size={13} />
          </button>
          {permissionOpen ? (
            <div className="ohb-policy-menu">
              {(["default", "full-access"] as const).map((level) => (
                <button
                  className={
                    props.view.composer.permissionLevel === level
                      ? "ohb-policy-selected"
                      : ""
                  }
                  key={level}
                  onClick={() => {
                    setPermissionOpen(false);
                    props.onSetPermission({ level });
                  }}
                  type="button"
                >
                  <span>{level}</span>
                  <small>
                    {level === "default"
                      ? "ask before actions"
                      : "run without prompts"}
                  </small>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <span className="ohb-composer-hint">{props.view.composer.hint}</span>
      </div>
    </section>
  );
}

function composerPlaceholder(view: ViewModel): string {
  if (view.composer.disabled) {
    return "daemon unavailable";
  }
  if (view.composer.isRunning) {
    return "run in progress";
  }
  return "Message ohbaby...";
}

function toolAccent(name: string): "blue" | "gold" | "green" | "red" {
  const lowered = name.toLowerCase();
  if (lowered.includes("read")) {
    return "gold";
  }
  if (lowered.includes("edit") || lowered.includes("write")) {
    return "green";
  }
  if (lowered.includes("error")) {
    return "red";
  }
  return "blue";
}

export function visibleMessageText(message: UiMessage): string {
  return message.parts
    .map((part) =>
      part.type === "text" || part.type === "reasoning" ? part.text : "",
    )
    .join("");
}
