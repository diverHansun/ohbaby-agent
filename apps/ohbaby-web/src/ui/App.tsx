import {
  Bot,
  ChevronDown,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Send,
  Square,
  User,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ChangeEvent, KeyboardEvent, ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type {
  UiCompactSessionResult,
  UiContextWindowUsage,
  UiConnectModelResult,
  UiCurrentModelConfig,
  UiMessage,
  UiMessagePart,
  UiPermissionChoice,
  UiPermissionLevel,
  UiPermissionMode,
  UiPermissionRequest,
  UiProbeModelContextWindowResult,
  UiSetSearchApiKeyResult,
  UiSession,
  UiWebCommandCatalog,
} from "ohbaby-sdk";
import type {
  OhbabyWebClient,
  OhbabyWebRuntime,
} from "../api/daemon/client.js";
import type { CommandNotice } from "../api/daemon/wire.js";
import type {
  CompactSessionRequest,
  ModelConnectRequest,
  SearchApiKeyRequest,
} from "../api/daemon/wire.js";
import { MarkdownBlock } from "./MarkdownBlock.js";
import {
  selectViewModel,
  type HeaderModel,
  type ViewModel,
} from "./selectors.js";
import {
  commandData,
  commandDataArray,
  createCommandResultModel,
  createSlashPaletteItems,
  isRecord,
  outputAsJson,
  safeHelpCommands,
  selectedSlashItem,
  slashCompletionSuffix,
  statusRows,
  type CommandResultModel,
  type SlashPaletteItem,
} from "./slashCommands.js";

type StructuredOverlayKind = "compact" | "connect" | "connect-search";

interface StructuredOverlayState {
  readonly commandLabel: string;
  readonly kind: StructuredOverlayKind;
}

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
  const [closedCommandModalIds, setClosedCommandModalIds] = useState<
    readonly string[]
  >([]);
  const [structuredOverlay, setStructuredOverlay] =
    useState<StructuredOverlayState | null>(null);
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
  const createSession = useCallback((): void => {
    void runAction(() => runtime.client.createSession());
  }, [runAction, runtime.client]);
  const selectSession = useCallback(
    (sessionId: string): void => {
      if (sessionId === view.activeSession?.id) {
        return;
      }
      void runAction(() => runtime.client.selectSession(sessionId));
    },
    [runAction, runtime.client, view.activeSession?.id],
  );
  const listCommands = useCallback(
    () => runtime.client.listCommands(),
    [runtime.client],
  );
  const openStructuredCommand = useCallback((item: SlashPaletteItem) => {
    const kind = structuredOverlayKindForAction(item.action);
    if (!kind) {
      return;
    }
    setStructuredOverlay({ commandLabel: item.label, kind });
  }, []);
  const commandModalNotice = useMemo(
    () =>
      [...view.commandNotices]
        .reverse()
        .find(
          (notice) =>
            !closedCommandModalIds.includes(notice.id) &&
            createCommandResultModel(notice) !== null,
        ) ?? null,
    [closedCommandModalIds, view.commandNotices],
  );

  return (
    <main
      className={`ohb-app ohb-app-shell ${
        showMain ? "ohb-app-main" : "ohb-app-empty"
      }`}
    >
      <SessionSidebar
        onCreateSession={createSession}
        onSelectSession={selectSession}
        view={view}
      />
      <div
        className={`ohb-app-content ${
          showMain ? "ohb-app-content-main" : "ohb-app-content-empty"
        }`}
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
              onListCommands={listCommands}
              onSetPermission={(input) => {
                void runAction(() => runtime.client.setPermission(input));
              }}
              onStructuredCommand={openStructuredCommand}
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
            {commandModalNotice ? (
              <CommandResultModal
                header={view.header}
                notice={commandModalNotice}
                onClose={() => {
                  setClosedCommandModalIds((ids) => [
                    ...ids,
                    commandModalNotice.id,
                  ]);
                }}
                view={view}
              />
            ) : null}
          </>
        ) : (
          <>
            <ErrorBanner
              message={actionError ?? view.error}
              onDismiss={clearActionError}
            />
            <EmptyState
              onListCommands={listCommands}
              onSetPermission={(input) => {
                void runAction(() => runtime.client.setPermission(input));
              }}
              onStructuredCommand={openStructuredCommand}
              onSubmit={submitText}
              status={view.header}
              view={view}
            />
          </>
        )}
        {structuredOverlay ? (
          <StructuredCommandOverlay
            client={runtime.client}
            onClose={() => {
              setStructuredOverlay(null);
            }}
            overlay={structuredOverlay}
            view={view}
          />
        ) : null}
      </div>
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
  readonly onListCommands: () => Promise<UiWebCommandCatalog>;
  readonly onSetPermission: (input: {
    readonly level?: UiPermissionLevel;
    readonly mode?: UiPermissionMode;
  }) => void;
  readonly onStructuredCommand: (item: SlashPaletteItem) => void;
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
          onListCommands={props.onListCommands}
          onSetPermission={props.onSetPermission}
          onStructuredCommand={props.onStructuredCommand}
          onSubmit={props.onSubmit}
          onStop={() => undefined}
          view={props.view}
        />
      </section>
    </>
  );
}

function SessionSidebar(props: {
  readonly onCreateSession: () => void;
  readonly onSelectSession: (sessionId: string) => void;
  readonly view: ViewModel;
}): ReactElement {
  const [collapsed, setCollapsed] = useState(isNarrowViewport());
  const sessions = useMemo(
    () => sortedSessions(props.view.snapshot?.sessions ?? []),
    [props.view.snapshot?.sessions],
  );
  const activeSessionId = props.view.activeSession?.id;

  if (collapsed) {
    return (
      <aside className="ohb-sidebar ohb-sidebar-collapsed">
        <div className="ohb-sidebar-mini-brand" aria-label="ohbaby">
          <span className="ohb-logo-grid" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </span>
        </div>
        <button
          className="ohb-sidebar-icon-button"
          onClick={() => {
            setCollapsed(false);
          }}
          title="Expand sidebar"
          type="button"
        >
          <PanelLeftOpen size={16} />
        </button>
        <button
          className="ohb-sidebar-icon-button ohb-sidebar-new-icon"
          disabled={props.view.composer.disabled}
          onClick={props.onCreateSession}
          title="New session"
          type="button"
        >
          <Plus size={17} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="ohb-sidebar">
      <header className="ohb-sidebar-header">
        <div className="ohb-sidebar-brand" aria-label="ohbaby">
          <span className="ohb-logo-grid" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </span>
          <strong>OHBABY</strong>
        </div>
        <button
          className="ohb-sidebar-icon-button"
          onClick={() => {
            setCollapsed(true);
          }}
          title="Collapse sidebar"
          type="button"
        >
          <PanelLeftClose size={16} />
        </button>
      </header>
      <button
        className="ohb-sidebar-new"
        disabled={props.view.composer.disabled}
        onClick={props.onCreateSession}
        title="New session"
        type="button"
      >
        <Plus size={15} />
        <span>New session</span>
      </button>
      <section className="ohb-sidebar-section">
        <div className="ohb-sidebar-section-title">Recent sessions</div>
        <div className="ohb-sidebar-list">
          {sessions.length > 0 ? (
            sessions.map((session) => {
              const active = session.id === activeSessionId;
              const running = active && props.view.composer.isRunning;
              const title = sessionTitle(session);
              return (
                <button
                  className={`ohb-session-row ${
                    active ? "ohb-session-active" : ""
                  } ${running ? "ohb-session-running" : ""}`}
                  aria-current={active ? "page" : undefined}
                  disabled={props.view.composer.disabled}
                  key={session.id}
                  onClick={() => {
                    if (!active) {
                      props.onSelectSession(session.id);
                    }
                  }}
                  title={`Select ${title}`}
                  type="button"
                >
                  <span className="ohb-session-dot" />
                  <span className="ohb-session-copy">
                    <strong>{title}</strong>
                    <small>{sessionMeta(session, active)}</small>
                  </span>
                  <MessageSquare size={14} />
                </button>
              );
            })
          ) : (
            <div className="ohb-sidebar-empty">No sessions yet</div>
          )}
        </div>
      </section>
      <footer className="ohb-sidebar-footer">
        <span>{String(sessions.length)} sessions</span>
      </footer>
    </aside>
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
  const notices = props.notices.filter(
    (notice) => createCommandResultModel(notice) === null,
  );
  if (notices.length === 0) {
    return null;
  }
  return (
    <div className="ohb-command-notices">
      {notices.map((notice) => (
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

function CommandResultModal(props: {
  readonly header: HeaderModel;
  readonly notice: CommandNotice;
  readonly onClose: () => void;
  readonly view: ViewModel;
}): ReactElement | null {
  const model = createCommandResultModel(props.notice);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    closeButtonRef.current?.focus();
  }, [props.notice.id]);
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") {
        props.onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return (): void => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [props.onClose]);
  if (!model) {
    return null;
  }
  return (
    <div
      className="ohb-command-modal-layer"
      onClick={props.onClose}
      role="presentation"
    >
      <section
        aria-label={model.title}
        aria-modal="true"
        className={`ohb-command-modal ohb-command-modal-${model.variant}`}
        onClick={(event) => {
          event.stopPropagation();
        }}
        role="dialog"
      >
        <header className="ohb-command-modal-header">
          <span>{model.commandLabel}</span>
          <h2>{model.title}</h2>
          <button
            onClick={props.onClose}
            ref={closeButtonRef}
            title="Close"
            type="button"
          >
            <X size={16} />
          </button>
        </header>
        <CommandResultBody
          header={props.header}
          notice={props.notice}
          variant={model.variant}
          view={props.view}
        />
      </section>
    </div>
  );
}

function CommandResultBody(props: {
  readonly header: HeaderModel;
  readonly notice: CommandNotice;
  readonly variant: CommandResultModel["variant"];
  readonly view: ViewModel;
}): ReactElement {
  const data = commandData(props.notice);
  switch (props.variant) {
    case "status":
      return (
        <StatusCommandResult
          data={data}
          header={props.header}
          view={props.view}
        />
      );
    case "help":
      return <HelpCommandResult data={data} />;
    case "mcps":
      return <McpCommandResult data={data} notice={props.notice} />;
    case "skills":
      return <SkillsCommandResult data={data} notice={props.notice} />;
  }
}

function StatusCommandResult(props: {
  readonly data: Record<string, unknown> | null;
  readonly header: HeaderModel;
  readonly view: ViewModel;
}): ReactElement {
  return (
    <div className="ohb-command-modal-body">
      <div className="ohb-status-result">
        {statusRows(props.data, props.header, props.view).map((row) => (
          <div key={row.label}>
            <span>{row.label}</span>
            <span>{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function HelpCommandResult(props: {
  readonly data: Record<string, unknown> | null;
}): ReactElement {
  const commands = safeHelpCommands(props.data);
  return (
    <div className="ohb-command-modal-body ohb-help-result">
      <section>
        <h3>Shortcuts</h3>
        {[
          ["Double Esc", "Interrupt"],
          ["Shift+Tab", "Cycle mode"],
          ["Esc", "Close / Back"],
          ["Tab", "Complete /cmd"],
          ["↑ ↓", "Select command"],
        ].map(([key, label]) => (
          <div className="ohb-help-row" key={key}>
            <kbd>{key}</kbd>
            <span>{label}</span>
          </div>
        ))}
      </section>
      <section>
        <h3>Commands</h3>
        {commands.length > 0 ? (
          commands.map((command) => (
            <div className="ohb-help-command" key={String(command.id)}>
              <span>{formatCommandPath(command)}</span>
              <span>{stringField(command, "description") ?? ""}</span>
            </div>
          ))
        ) : (
          <pre>commands: none</pre>
        )}
      </section>
    </div>
  );
}

function McpCommandResult(props: {
  readonly data: Record<string, unknown> | null;
  readonly notice: CommandNotice;
}): ReactElement {
  const servers = commandDataArray(props.data, "servers");
  if (servers.length === 0) {
    return <FallbackCommandResult notice={props.notice} />;
  }
  return (
    <div className="ohb-command-modal-body">
      <div className="ohb-list-result">
        {servers.map((server, index) =>
          isRecord(server) ? (
            <div
              className={`ohb-list-row ohb-list-${stringField(server, "status") ?? "unknown"}`}
              key={`${stringField(server, "name") ?? "server"}-${String(index)}`}
            >
              <span />
              <strong>{stringField(server, "name") ?? "server"}</strong>
              <small>{stringField(server, "status") ?? "unknown"}</small>
              <em>{mcpServerMeta(server)}</em>
            </div>
          ) : null,
        )}
      </div>
    </div>
  );
}

function SkillsCommandResult(props: {
  readonly data: Record<string, unknown> | null;
  readonly notice: CommandNotice;
}): ReactElement {
  const skills = commandDataArray(props.data, "skills");
  if (skills.length === 0) {
    return <FallbackCommandResult notice={props.notice} />;
  }
  return (
    <div className="ohb-command-modal-body">
      <div className="ohb-list-result">
        {skills.map((skill, index) =>
          isRecord(skill) ? (
            <div
              className="ohb-list-row ohb-list-skill"
              key={`${stringField(skill, "name") ?? "skill"}-${String(index)}`}
            >
              <strong>/{stringField(skill, "name") ?? "skill"}</strong>
              <span>{stringField(skill, "description") ?? ""}</span>
              <small>
                {stringField(skill, "source") ??
                  stringField(skill, "scope") ??
                  "skill"}
              </small>
            </div>
          ) : null,
        )}
      </div>
    </div>
  );
}

function FallbackCommandResult(props: {
  readonly notice: CommandNotice;
}): ReactElement {
  return (
    <div className="ohb-command-modal-body">
      <pre>{outputAsJson(props.notice.output)}</pre>
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
  readonly onListCommands: () => Promise<UiWebCommandCatalog>;
  readonly onSetPermission: (input: {
    readonly level?: UiPermissionLevel;
    readonly mode?: UiPermissionMode;
  }) => void;
  readonly onStructuredCommand: (item: SlashPaletteItem) => void;
  readonly onStop: () => void;
  readonly onSubmit: (text: string) => Promise<boolean>;
  readonly view: ViewModel;
}): ReactElement {
  const [draft, setDraft] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [slashCatalog, setSlashCatalog] = useState<UiWebCommandCatalog | null>(
    null,
  );
  const [slashDismissedDraft, setSlashDismissedDraft] = useState<string | null>(
    null,
  );
  const [slashError, setSlashError] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const lastEscapeAt = useRef(0);
  const canSend =
    props.view.composer.canSend && draft.trim().length > 0 && !isSubmitting;
  const canUseSlash = props.view.composer.canSend && !isSubmitting;
  const slashItems = useMemo(
    () =>
      canUseSlash && slashCatalog && draft.startsWith("/")
        ? createSlashPaletteItems(slashCatalog, draft)
        : [],
    [canUseSlash, draft, slashCatalog],
  );
  const selectedCommand = selectedSlashItem(slashItems, slashIndex);
  const completionSuffix = slashCompletionSuffix(selectedCommand, draft);
  const slashOpen =
    draft.startsWith("/") &&
    slashDismissedDraft !== draft &&
    slashItems.length > 0 &&
    canUseSlash &&
    !props.view.composer.disabled;

  useEffect(() => {
    if (
      !draft.startsWith("/") ||
      !canUseSlash ||
      props.view.composer.disabled
    ) {
      return;
    }
    let cancelled = false;
    setSlashCatalog(null);
    setSlashError(null);
    props
      .onListCommands()
      .then((catalog) => {
        if (!cancelled) {
          setSlashCatalog(catalog);
          setSlashError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setSlashCatalog(null);
          setSlashError(error instanceof Error ? error.message : String(error));
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, [
    canUseSlash,
    draft,
    props.onListCommands,
    props.view.commandCatalogVersion,
    props.view.composer.disabled,
  ]);

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
  }, [draft, props.onSubmit, props.view.composer.canSend]);

  const cycleMode = useCallback(() => {
    const mode = props.view.composer.mode === "auto" ? "plan" : "auto";
    props.onSetPermission({ mode });
  }, [props.onSetPermission, props.view.composer.mode]);

  const cyclePermissionLevel = useCallback(() => {
    const level =
      props.view.composer.permissionLevel === "default"
        ? "full-access"
        : "default";
    props.onSetPermission({ level });
  }, [props.onSetPermission, props.view.composer.permissionLevel]);

  const runSlashCommand = useCallback(
    (item: SlashPaletteItem | undefined) => {
      if (!canUseSlash) {
        return;
      }
      const commandText = item?.label ?? draft.trim();
      if (!commandText) {
        return;
      }
      if (item?.executionKind === "overlay") {
        props.onStructuredCommand(item);
        setDraft("");
        setSlashDismissedDraft(null);
        setSlashError(null);
        return;
      }
      setIsSubmitting(true);
      void props
        .onSubmit(commandText)
        .then((sent) => {
          if (sent) {
            setDraft("");
            setSlashDismissedDraft(null);
          }
        })
        .finally(() => {
          setIsSubmitting(false);
        });
    },
    [canUseSlash, draft, props.onStructuredCommand, props.onSubmit],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (slashOpen) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setSlashIndex((index) => Math.min(index + 1, slashItems.length - 1));
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setSlashIndex((index) => Math.max(index - 1, 0));
          return;
        }
        if (event.key === "PageDown") {
          event.preventDefault();
          setSlashIndex((index) => Math.min(index + 5, slashItems.length - 1));
          return;
        }
        if (event.key === "PageUp") {
          event.preventDefault();
          setSlashIndex((index) => Math.max(index - 5, 0));
          return;
        }
        if (event.key === "Tab" && !event.shiftKey) {
          event.preventDefault();
          if (selectedCommand) {
            setDraft(selectedCommand.label);
            setSlashDismissedDraft(null);
          }
          return;
        }
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          runSlashCommand(selectedCommand);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setSlashDismissedDraft(draft);
          return;
        }
      }
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
    [
      cycleMode,
      cyclePermissionLevel,
      draft,
      props.onStop,
      props.view.composer.canStop,
      runSlashCommand,
      selectedCommand,
      send,
      slashItems.length,
      slashOpen,
    ],
  );

  return (
    <section
      className={
        props.compact ? "ohb-composer ohb-composer-hero" : "ohb-composer"
      }
    >
      <div className="ohb-composer-input">
        <span className="ohb-prompt">&gt;</span>
        {slashOpen ? (
          <SlashPalette
            items={slashItems}
            onHover={setSlashIndex}
            onRun={(item) => {
              runSlashCommand(item);
            }}
            placement={props.compact ? "down" : "up"}
            selectedIndex={slashIndex}
          />
        ) : null}
        <textarea
          disabled={props.view.composer.disabled || isSubmitting}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
            const nextDraft = event.target.value;
            setDraft(nextDraft);
            setSlashIndex(0);
            if (nextDraft !== slashDismissedDraft) {
              setSlashDismissedDraft(null);
            }
          }}
          onKeyDown={onKeyDown}
          placeholder={composerPlaceholder(props.view)}
          rows={1}
          value={draft}
        />
        {completionSuffix && selectedCommand ? (
          <span className="ohb-slash-completion" aria-hidden="true">
            <span>⇥ {selectedCommand.label}</span>
          </span>
        ) : null}
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
        {slashError ? (
          <span className="ohb-slash-error">{slashError}</span>
        ) : null}
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
        <button
          className={`ohb-policy-button ohb-policy-${props.view.composer.permissionLevel}`}
          disabled={props.view.composer.disabled}
          onClick={cyclePermissionLevel}
          title="Permission policy"
          type="button"
        >
          <span className="ohb-policy-glyph" aria-hidden="true" />
          {props.view.composer.permissionLevel}
        </button>
        <span className="ohb-composer-hint">{props.view.composer.hint}</span>
      </div>
    </section>
  );
}

function StructuredCommandOverlay(props: {
  readonly client: OhbabyWebClient;
  readonly onClose: () => void;
  readonly overlay: StructuredOverlayState;
  readonly view: ViewModel;
}): ReactElement {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    closeButtonRef.current?.focus();
  }, [props.overlay.kind]);
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") {
        props.onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return (): void => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [props.onClose]);

  return (
    <div
      className="ohb-structured-overlay"
      onClick={props.onClose}
      role="presentation"
    >
      <section
        aria-label={structuredOverlayTitle(props.overlay.kind)}
        aria-modal="true"
        className="ohb-structured-dialog"
        onClick={(event) => {
          event.stopPropagation();
        }}
        role="dialog"
      >
        <header className="ohb-structured-header">
          <span>{props.overlay.commandLabel}</span>
          <h2>{structuredOverlayTitle(props.overlay.kind)}</h2>
          <button
            onClick={props.onClose}
            ref={closeButtonRef}
            title="Close overlay"
            type="button"
          >
            <X size={16} />
          </button>
        </header>
        {props.overlay.kind === "connect" ? (
          <ConnectModelOverlayBody client={props.client} />
        ) : props.overlay.kind === "connect-search" ? (
          <ConnectSearchOverlayBody client={props.client} />
        ) : (
          <CompactOverlayBody client={props.client} view={props.view} />
        )}
      </section>
    </div>
  );
}

interface ConnectModelFormState {
  readonly apiKey: string;
  readonly apiKeyEnv: string;
  readonly baseUrl: string;
  readonly contextWindowTokens: string;
  readonly maxOutputTokens: string;
  readonly model: string;
  readonly provider: string;
}

function ConnectModelOverlayBody(props: {
  readonly client: OhbabyWebClient;
}): ReactElement {
  const [form, setForm] = useState<ConnectModelFormState>({
    apiKey: "",
    apiKeyEnv: "",
    baseUrl: "",
    contextWindowTokens: "",
    maxOutputTokens: "",
    model: "",
    provider: "",
  });
  const [currentModel, setCurrentModel] = useState<UiCurrentModelConfig | null>(
    null,
  );
  const [probe, setProbe] = useState<UiProbeModelContextWindowResult | null>(
    null,
  );
  const [result, setResult] = useState<UiConnectModelResult | null>(null);
  const [status, setStatus] = useState<OverlayStatus>({
    kind: "idle",
    message: "",
  });

  useEffect(() => {
    let cancelled = false;
    void props.client
      .getCurrentModel()
      .then((model) => {
        if (cancelled) {
          return;
        }
        setCurrentModel(model);
        if (model) {
          setForm({
            apiKey: "",
            apiKeyEnv: model.apiKeyEnv,
            baseUrl: model.baseUrl,
            contextWindowTokens:
              model.contextWindowTokens === undefined
                ? ""
                : String(model.contextWindowTokens),
            maxOutputTokens:
              model.maxOutputTokens === undefined
                ? ""
                : String(model.maxOutputTokens),
            model: model.model,
            provider: model.provider,
          });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setStatus({
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, [props.client]);

  const update = useCallback(
    (key: keyof ConnectModelFormState, value: string) => {
      setForm((previous) => ({ ...previous, [key]: value }));
    },
    [],
  );

  const probeContext = useCallback(() => {
    void runOverlayAction(
      setStatus,
      async () => {
        const nextProbe = await props.client.probeModelContextWindow(
          connectModelRequest(form),
        );
        setProbe(nextProbe);
        return `context window ${formatTokenCount(
          nextProbe.contextWindowTokens,
        )} · ${nextProbe.contextWindowSource}`;
      },
      "Probing model context",
    );
  }, [form, props.client]);

  const saveModel = useCallback(() => {
    void runOverlayAction(
      setStatus,
      async () => {
        const nextResult = await props.client.connectModel(
          connectModelRequest(form),
        );
        setResult(nextResult);
        setForm((previous) => ({ ...previous, apiKey: "" }));
        return `saved ${nextResult.provider} · ${nextResult.model}`;
      },
      "Saving model",
    );
  }, [form, props.client]);

  return (
    <div className="ohb-structured-body">
      <p>
        {currentModel
          ? `Current model: ${currentModel.provider} · ${currentModel.model}`
          : "Connect a model provider for browser runs."}
      </p>
      <div className="ohb-structured-grid">
        <TextField
          label="Provider"
          onChange={(value) => {
            update("provider", value);
          }}
          placeholder="zhipu"
          value={form.provider}
        />
        <TextField
          label="Model"
          onChange={(value) => {
            update("model", value);
          }}
          placeholder="glm-4.7"
          value={form.model}
        />
        <TextField
          label="Base URL"
          onChange={(value) => {
            update("baseUrl", value);
          }}
          placeholder="https://open.bigmodel.cn/api/paas/v4"
          value={form.baseUrl}
        />
        <TextField
          label="API key env"
          onChange={(value) => {
            update("apiKeyEnv", value);
          }}
          placeholder="ZHIPU_API_KEY"
          value={form.apiKeyEnv}
        />
        <TextField
          label="API key"
          onChange={(value) => {
            update("apiKey", value);
          }}
          placeholder="optional, writes to .env"
          type="password"
          value={form.apiKey}
        />
        <TextField
          label="Context window"
          onChange={(value) => {
            update("contextWindowTokens", value);
          }}
          placeholder="auto, default 128000"
          value={form.contextWindowTokens}
        />
        <TextField
          label="Max output"
          onChange={(value) => {
            update("maxOutputTokens", value);
          }}
          placeholder="optional"
          value={form.maxOutputTokens}
        />
      </div>
      <OverlayStatusLine status={status} />
      {probe ? (
        <OverlayResult
          rows={[
            ["context", formatTokenCount(probe.contextWindowTokens)],
            ["source", probe.contextWindowSource],
            ...(probe.warning ? [["warning", probe.warning] as const] : []),
          ]}
        />
      ) : null}
      {result ? (
        <OverlayResult
          rows={[
            ["provider", result.provider],
            ["model", result.model],
            ["interface", result.interfaceProvider],
            ["context", formatTokenCount(result.contextWindowTokens)],
            ["source", result.contextWindowSource],
          ]}
        />
      ) : null}
      <div className="ohb-structured-actions">
        <button
          className="ohb-button"
          onClick={probeContext}
          title="Probe context"
          type="button"
        >
          Probe context
        </button>
        <button
          className="ohb-button-primary"
          onClick={saveModel}
          title="Save model"
          type="button"
        >
          Save model
        </button>
      </div>
    </div>
  );
}

function ConnectSearchOverlayBody(props: {
  readonly client: OhbabyWebClient;
}): ReactElement {
  const [apiKeyEnv, setApiKeyEnv] = useState("TAVILY_API_KEY");
  const [apiKey, setApiKey] = useState("");
  const [result, setResult] = useState<UiSetSearchApiKeyResult | null>(null);
  const [status, setStatus] = useState<OverlayStatus>({
    kind: "idle",
    message: "",
  });

  const saveSearchKey = useCallback(() => {
    void runOverlayAction(
      setStatus,
      async () => {
        const input: SearchApiKeyRequest = {
          apiKeyEnv: trimmedOrUndefined(apiKeyEnv),
          apiKey: trimmedOrUndefined(apiKey),
          provider: "tavily",
        };
        const nextResult = await props.client.setSearchApiKey(input);
        setResult(nextResult);
        setApiKey("");
        return `saved ${nextResult.provider} key reference`;
      },
      "Saving search key",
    );
  }, [apiKey, apiKeyEnv, props.client]);

  return (
    <div className="ohb-structured-body">
      <p>Connect Tavily search for web-enabled workflows.</p>
      <div className="ohb-structured-grid">
        <TextField label="Provider" onChange={() => undefined} value="tavily" />
        <TextField
          label="API key env"
          onChange={setApiKeyEnv}
          placeholder="TAVILY_API_KEY"
          value={apiKeyEnv}
        />
        <TextField
          label="API key"
          onChange={setApiKey}
          placeholder="optional, writes to .env"
          type="password"
          value={apiKey}
        />
      </div>
      <OverlayStatusLine status={status} />
      {result ? (
        <OverlayResult
          rows={[
            ["provider", result.provider],
            ["env", result.apiKeyEnv],
            ["config", result.searchJsonPath],
          ]}
        />
      ) : null}
      <div className="ohb-structured-actions">
        <button
          className="ohb-button-primary"
          onClick={saveSearchKey}
          title="Save search key"
          type="button"
        >
          Save search key
        </button>
      </div>
    </div>
  );
}

function CompactOverlayBody(props: {
  readonly client: OhbabyWebClient;
  readonly view: ViewModel;
}): ReactElement {
  const sessionId =
    props.view.composer.activeSessionId ?? props.view.activeSession?.id;
  const [force, setForce] = useState(true);
  const [usage, setUsage] = useState<UiContextWindowUsage | null>(null);
  const [result, setResult] = useState<UiCompactSessionResult | null>(null);
  const [status, setStatus] = useState<OverlayStatus>({
    kind: "idle",
    message: sessionId ? "" : "No active session to compact.",
  });

  useEffect(() => {
    if (!sessionId) {
      return;
    }
    let cancelled = false;
    void props.client
      .getContextWindowUsage(sessionId)
      .then((nextUsage) => {
        if (!cancelled) {
          setUsage(nextUsage);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setStatus({
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, [props.client, sessionId]);

  const compactSession = useCallback(() => {
    if (!sessionId) {
      setStatus({ kind: "error", message: "No active session to compact." });
      return;
    }
    void runOverlayAction(
      setStatus,
      async () => {
        const input: CompactSessionRequest = { force };
        const nextResult = await props.client.compactSession(sessionId, input);
        setResult(nextResult);
        const failureMessage = compactFailureMessage(nextResult);
        if (failureMessage) {
          throw new Error(failureMessage);
        }
        return `compact ${nextResult.status}`;
      },
      "Compacting session",
    );
  }, [force, props.client, sessionId]);

  return (
    <div className="ohb-structured-body">
      <p>
        {sessionId
          ? `Compact current session ${sessionId}.`
          : "Open a session before compacting context."}
      </p>
      {usage ? (
        <OverlayResult
          rows={[
            ["model", usage.modelId],
            ["current", formatTokenCount(usage.currentTokens)],
            ["limit", formatTokenCount(usage.contextWindowTokens)],
            ["ratio", `${String(Math.round(usage.contextWindowRatio * 100))}%`],
          ]}
        />
      ) : null}
      <label className="ohb-structured-check">
        <input
          checked={force}
          onChange={(event) => {
            setForce(event.target.checked);
          }}
          type="checkbox"
        />
        force compaction
      </label>
      <OverlayStatusLine status={status} />
      {result ? (
        <OverlayResult
          rows={[
            ["status", result.status],
            ["before", formatTokenCount(result.usageBefore.currentTokens)],
            ["after", formatTokenCount(result.usageAfter.currentTokens)],
            [
              "saved",
              result.compression
                ? formatTokenCount(result.compression.savedTokens)
                : "none",
            ],
            [
              "pruned",
              result.prune ? String(result.prune.prunedCount) : "none",
            ],
          ]}
        />
      ) : null}
      <div className="ohb-structured-actions">
        <button
          className="ohb-button-primary"
          disabled={!sessionId}
          onClick={compactSession}
          title="Compact session"
          type="button"
        >
          Compact session
        </button>
      </div>
    </div>
  );
}

function compactFailureMessage(result: UiCompactSessionResult): string | null {
  if (result.status !== "failed" && result.status !== "inflated") {
    return null;
  }
  const error = result.error ?? result.compression?.error;
  return error
    ? `compact ${result.status}: ${error}`
    : `compact ${result.status}`;
}

function TextField(props: {
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly type?: "password" | "text";
  readonly value: string;
}): ReactElement {
  return (
    <label className="ohb-structured-field">
      <span>{props.label}</span>
      <input
        onChange={(event) => {
          props.onChange(event.target.value);
        }}
        placeholder={props.placeholder}
        type={props.type ?? "text"}
        value={props.value}
      />
    </label>
  );
}

interface OverlayStatus {
  readonly kind: "busy" | "error" | "idle" | "success";
  readonly message: string;
}

function OverlayStatusLine(props: {
  readonly status: OverlayStatus;
}): ReactElement | null {
  if (!props.status.message) {
    return null;
  }
  return (
    <div
      className={`ohb-structured-status ohb-structured-${props.status.kind}`}
    >
      {props.status.message}
    </div>
  );
}

function OverlayResult(props: {
  readonly rows: readonly (readonly [string, string])[];
}): ReactElement {
  return (
    <div className="ohb-structured-result">
      {props.rows.map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

async function runOverlayAction(
  setStatus: (status: OverlayStatus) => void,
  action: () => Promise<string>,
  busyMessage: string,
): Promise<void> {
  try {
    setStatus({ kind: "busy", message: busyMessage });
    const message = await action();
    setStatus({ kind: "success", message });
  } catch (error) {
    setStatus({
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function connectModelRequest(form: ConnectModelFormState): ModelConnectRequest {
  const provider = requiredText(form.provider, "Provider");
  const baseUrl = requiredText(form.baseUrl, "Base URL");
  const apiKeyEnv = requiredText(form.apiKeyEnv, "API key env");
  const model = requiredText(form.model, "Model");
  const apiKey = trimmedOrUndefined(form.apiKey);
  const contextWindowTokens = optionalIntegerValue(
    "contextWindowTokens",
    form.contextWindowTokens,
  );
  const maxOutputTokens = optionalIntegerValue(
    "maxOutputTokens",
    form.maxOutputTokens,
  );
  return {
    provider,
    baseUrl,
    apiKeyEnv,
    model,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  };
}

function requiredText(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  return trimmed;
}

function trimmedOrUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalIntegerValue(
  label: string,
  value: string,
): number | undefined {
  const trimmed = trimmedOrUndefined(value);
  if (trimmed === undefined) {
    return undefined;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function structuredOverlayKindForAction(
  action: SlashPaletteItem["action"],
): StructuredOverlayKind | null {
  switch (action) {
    case "compactSession":
      return "compact";
    case "connectModel":
      return "connect";
    case "connectSearch":
      return "connect-search";
    case "executeCommand":
      return null;
  }
}

function structuredOverlayTitle(kind: StructuredOverlayKind): string {
  switch (kind) {
    case "compact":
      return "Compact context";
    case "connect":
      return "Connect model";
    case "connect-search":
      return "Connect search";
  }
}

function formatTokenCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function sortedSessions(sessions: readonly UiSession[]): readonly UiSession[] {
  return [...sessions].sort(
    (left, right) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
      left.id.localeCompare(right.id),
  );
}

function isNarrowViewport(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(max-width: 720px)").matches
  );
}

function sessionTitle(session: UiSession): string {
  const trimmed = session.title.trim();
  return trimmed.length > 0 ? trimmed : "Untitled session";
}

function sessionMeta(session: UiSession, active: boolean): string {
  const messageCount = session.messages.length;
  const date = new Date(session.updatedAt);
  const dateLabel = Number.isNaN(date.getTime())
    ? "recent"
    : new Intl.DateTimeFormat("en-US", {
        day: "2-digit",
        month: "short",
      }).format(date);
  if (!active) {
    return dateLabel;
  }
  return `${String(messageCount)} ${
    messageCount === 1 ? "message" : "messages"
  } · ${dateLabel}`;
}

function SlashPalette(props: {
  readonly items: readonly SlashPaletteItem[];
  readonly onHover: (index: number) => void;
  readonly onRun: (item: SlashPaletteItem) => void;
  readonly placement: "down" | "up";
  readonly selectedIndex: number;
}): ReactElement {
  return (
    <div className={`ohb-slash-palette ohb-slash-palette-${props.placement}`}>
      <div className="ohb-slash-palette-list">
        {props.items.map((item, index) => (
          <div key={item.command.id}>
            {item.showCategory ? (
              <div className="ohb-slash-category">{item.categoryLabel}</div>
            ) : null}
            <button
              className={
                index === props.selectedIndex
                  ? "ohb-slash-row ohb-slash-selected"
                  : "ohb-slash-row"
              }
              onClick={() => {
                props.onRun(item);
              }}
              onMouseEnter={() => {
                props.onHover(index);
              }}
              type="button"
            >
              <span className={`ohb-slash-dot ohb-slash-dot-${item.accent}`} />
              <span>{item.label}</span>
              <small className="ohb-slash-args">{item.argsHint}</small>
              <em className="ohb-slash-description">{item.description}</em>
            </button>
          </div>
        ))}
      </div>
      <footer>
        <span>
          <b>↑↓</b> select
        </span>
        <span>
          <b>↵</b> run
        </span>
        <span>
          <b>⇥</b> complete
        </span>
        <span>
          <b>esc</b> dismiss
        </span>
      </footer>
    </div>
  );
}

function formatCommandPath(command: Record<string, unknown>): string {
  const path = Array.isArray(command.path)
    ? command.path.filter(
        (segment): segment is string => typeof segment === "string",
      )
    : [];
  return path.length > 0 ? `/${path.join(" ")}` : `/${String(command.id)}`;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function mcpServerMeta(server: Record<string, unknown>): string {
  const error = stringField(server, "error");
  if (error) {
    return error;
  }
  const toolCount = server.toolCount;
  return typeof toolCount === "number"
    ? `${String(toolCount)} ${toolCount === 1 ? "tool" : "tools"}`
    : "";
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
