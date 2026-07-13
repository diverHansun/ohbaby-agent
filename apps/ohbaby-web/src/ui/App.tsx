import {
  Archive,
  Bot,
  ChevronLeft,
  ChevronDown,
  Folder,
  FolderPlus,
  MoreHorizontal,
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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  ChangeEvent,
  CSSProperties,
  KeyboardEvent,
  ReactElement,
} from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { parseSlashCommandInput, resolveSlashCommand } from "ohbaby-sdk";
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
  UiTodoStatus,
  UiWebCommandCatalog,
} from "ohbaby-sdk";
import type {
  OhbabyWebClient,
  OhbabyWebRuntime,
} from "../api/daemon/client.js";
import type { CommandNotice } from "../api/daemon/wire.js";
import type { WorkspaceSnapshot } from "../api/daemon/wire.js";
import type {
  DirectoryPickerEntry,
  DirectoryPickerRoot,
} from "../api/daemon/wire.js";
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
  slashCommandLabel,
  slashCompletionSuffix,
  statusRows,
  type CommandResultModel,
  type SlashPaletteItem,
} from "./slashCommands.js";
import { isNearBottom, scrollToBottom } from "./streamScroll.js";

type StructuredOverlayKind = "compact" | "connect" | "connect-search" | "goal";

type GoalPanelAction = "delete" | "pause" | "resume" | "save" | "view";

interface GoalPanelIntent {
  readonly action: GoalPanelAction;
  readonly objectiveDraft?: string;
}

interface StructuredCommandRequest {
  readonly item: SlashPaletteItem;
  readonly text: string;
}

interface StructuredOverlayState {
  readonly commandLabel: string;
  readonly goalIntent?: GoalPanelIntent;
  readonly kind: StructuredOverlayKind;
}

interface ComposerPrefill {
  readonly nonce: number;
  readonly text: string;
}

interface PendingPrompt {
  readonly clientRequestId: string;
  readonly createdAt: string;
  readonly sessionId?: string;
  readonly text: string;
}

interface StoredComposerDraft {
  readonly clientRequestId?: string;
  readonly pendingText?: string;
  readonly text: string;
}

interface QueuedEditState {
  readonly editLeaseId: string;
  readonly expiresAt: string;
  readonly originalDraft: string;
  readonly originalPendingRequestId?: string;
  readonly originalPendingText?: string;
  readonly promptId: string;
}

interface StoredQueuedEdit extends QueuedEditState {
  readonly editText: string;
  readonly lastActivityAt: number;
}

function composerDraftKey(scopeKey: string): string {
  return `ohbaby:composer:${scopeKey}`;
}

function composerLeaseKey(scopeKey: string): string {
  return `ohbaby:composer-lease:${scopeKey}`;
}

function readSessionValue(key: string): unknown {
  try {
    const value = globalThis.sessionStorage.getItem(key);
    return value ? (JSON.parse(value) as unknown) : null;
  } catch {
    return null;
  }
}

function writeSessionValue(key: string, value: unknown): void {
  try {
    globalThis.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Draft persistence is a resilience feature; storage denial must not block input.
  }
}

function removeSessionValue(key: string): void {
  try {
    globalThis.sessionStorage.removeItem(key);
  } catch {
    // Ignore storage denial.
  }
}

interface AppProps {
  readonly runtime: OhbabyWebRuntime;
}

let mountedRoot: Root | undefined;

const DEFAULT_GOAL_PANEL_INTENT: GoalPanelIntent = { action: "view" };

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
  const workspace = useSyncExternalStore(
    (listener) => runtime.subscribeWorkspaces(listener),
    () => runtime.getWorkspaceSnapshot(),
    () => runtime.getWorkspaceSnapshot(),
  );
  return workspace.selectedDirectory === null ? (
    <EmptyWorkspaceApp runtime={runtime} workspace={workspace} />
  ) : (
    <ConnectedOhbabyWebApp runtime={runtime} />
  );
}

function ConnectedOhbabyWebApp({ runtime }: AppProps): ReactElement {
  const storeSnapshot = useSyncExternalStore(
    (listener) => runtime.store.subscribe(listener),
    () => runtime.store.getSnapshot(),
    () => runtime.store.getSnapshot(),
  );
  const view = useMemo(() => selectViewModel(storeSnapshot), [storeSnapshot]);
  const workspace = useSyncExternalStore(
    (listener) => runtime.subscribeWorkspaces(listener),
    () => runtime.getWorkspaceSnapshot(),
    () => runtime.getWorkspaceSnapshot(),
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [sessionSidebarOpen, setSessionSidebarOpen] = useState(false);
  const [closedCommandModalIds, setClosedCommandModalIds] = useState<
    readonly string[]
  >([]);
  const [structuredOverlay, setStructuredOverlay] =
    useState<StructuredOverlayState | null>(null);
  const [composerPrefill, setComposerPrefill] =
    useState<ComposerPrefill | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt | null>(
    null,
  );
  const clearActionError = useCallback(() => {
    setActionError(null);
  }, []);
  const showMain = !view.isEmpty || view.commandNotices.length > 0;
  const visiblePendingPrompt =
    pendingPrompt?.sessionId === undefined ||
    pendingPrompt.sessionId === view.composer.activeSessionId
      ? pendingPrompt
      : null;

  useEffect(() => {
    if (!pendingPrompt) return;
    const projected = view.snapshot?.prompts?.find(
      (prompt) => prompt.clientRequestId === pendingPrompt.clientRequestId,
    );
    if (!projected) return;
    const messageVisible = view.snapshot?.sessions
      .find((session) => session.id === projected.sessionId)
      ?.messages.some((message) => message.id === projected.userMessageId);
    if (
      projected.status === "queued" ||
      messageVisible === true ||
      (projected.status !== "starting" && projected.status !== "running")
    ) {
      setPendingPrompt(null);
    }
  }, [pendingPrompt, view.snapshot]);

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
  useEffect(() => {
    void runtime.refreshWorkspaces().catch((error: unknown) => {
      setActionError(error instanceof Error ? error.message : String(error));
    });
  }, [runtime]);
  const switchWorkspace = useCallback(
    (directory: string): void => {
      void runAction(() => runtime.switchWorkspace(directory));
    },
    [runAction, runtime],
  );
  const hideWorkspace = useCallback(
    (directory: string): void => {
      void runAction(() => runtime.hideWorkspace(directory));
    },
    [runAction, runtime],
  );

  const openOverlayForSlashText = useCallback(
    async (text: string): Promise<boolean> => {
      let catalog: UiWebCommandCatalog;
      try {
        catalog = await runtime.client.listCommands();
      } catch {
        return false;
      }
      const resolved = resolveSlashCommand(
        catalog,
        parseSlashCommandInput(text),
        { surface: "tui" },
      );
      if (!resolved.ok) {
        return false;
      }
      const command = catalog.commands.find(
        (candidate) => candidate.id === resolved.command.id,
      );
      if (command?.executionKind !== "overlay") {
        return false;
      }
      const kind = structuredOverlayKindForAction(command.action);
      if (!kind) {
        return false;
      }
      setStructuredOverlay({
        commandLabel: slashCommandLabel(command),
        ...(kind === "goal"
          ? { goalIntent: goalPanelIntentFromArgs(resolved.rawArgs) }
          : {}),
        kind,
      });
      return true;
    },
    [runtime.client],
  );
  const submitText = useCallback(
    async (text: string, clientRequestId?: string): Promise<boolean> => {
      if (text.startsWith("/") && (await openOverlayForSlashText(text))) {
        return true;
      }
      if (text.startsWith("/")) {
        return runAction(() =>
          runtime.client.executeSlashCommand({
            ...(view.composer.activeSessionId === undefined
              ? {}
              : { sessionId: view.composer.activeSessionId }),
            text,
          }),
        );
      }
      const requestId = clientRequestId ?? globalThis.crypto.randomUUID();
      try {
        clearActionError();
        setPendingPrompt({
          clientRequestId: requestId,
          createdAt: new Date().toISOString(),
          ...(view.composer.activeSessionId === undefined
            ? {}
            : { sessionId: view.composer.activeSessionId }),
          text,
        });
        const receipt = await runtime.client.submitPrompt({
          clientRequestId: requestId,
          ...(view.composer.activeSessionId === undefined
            ? {}
            : { sessionId: view.composer.activeSessionId }),
          text,
        });
        if (receipt.clientRequestId !== requestId) {
          throw new Error("Prompt receipt did not match this submission");
        }
        if (view.composer.activeSessionId === undefined) {
          await runtime.client.selectSession(receipt.sessionId);
        }
        return true;
      } catch (error) {
        setPendingPrompt((current) =>
          current?.clientRequestId === requestId ? null : current,
        );
        setActionError(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [
      clearActionError,
      openOverlayForSlashText,
      runAction,
      runtime.client,
      view.composer.activeSessionId,
    ],
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
  const archiveSession = useCallback(
    (sessionId: string): void => {
      if (!window.confirm("Archive this session?")) {
        return;
      }
      void runAction(() => runtime.client.archiveSession(sessionId));
    },
    [runAction, runtime.client],
  );
  const listCommands = useCallback(
    () => runtime.client.listCommands(),
    [runtime.client],
  );
  const openGoalPanel = useCallback((intent?: GoalPanelIntent) => {
    setStructuredOverlay({
      commandLabel: "/goal",
      goalIntent: intent ?? DEFAULT_GOAL_PANEL_INTENT,
      kind: "goal",
    });
  }, []);
  const openStructuredCommand = useCallback(
    (request: StructuredCommandRequest) => {
      const { item, text } = request;
      const kind = structuredOverlayKindForAction(item.action);
      if (!kind) {
        return;
      }
      setStructuredOverlay({
        commandLabel: item.label,
        ...(kind === "goal"
          ? {
              goalIntent: goalPanelIntentFromArgs(
                text.startsWith(item.label)
                  ? text.slice(item.label.length)
                  : "",
              ),
            }
          : {}),
        kind,
      });
    },
    [],
  );
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
      <ProjectRail
        onAdd={() => {
          setDirectoryPickerOpen(true);
        }}
        onHide={hideWorkspace}
        onSelect={switchWorkspace}
        onToggleSessions={() => {
          setSessionSidebarOpen((open) => !open);
        }}
        sessionsOpen={sessionSidebarOpen}
        workspace={workspace}
      />
      <SessionSidebar
        open={sessionSidebarOpen}
        onArchiveSession={archiveSession}
        onCreateSession={createSession}
        onSelectSession={selectSession}
        view={view}
        workspace={workspace}
      />
      <div
        className={`ohb-app-content ${
          showMain ? "ohb-app-content-main" : "ohb-app-content-empty"
        } ${view.activeTodoList ? "ohb-app-content-has-todos" : ""}`}
      >
        {showMain ? (
          <>
            <StatusBar
              activeGoal={view.activeGoal}
              header={view.header}
              onOpenGoalPanel={openGoalPanel}
            />
            <ErrorBanner
              message={actionError ?? view.error}
              onDismiss={clearActionError}
            />
            <ConversationStream
              pendingPrompt={visiblePendingPrompt}
              view={view}
            />
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
              client={runtime.client}
              draftScopeKey={`${workspace.selectedDirectory ?? "workspace"}:${view.composer.activeSessionId ?? "new"}`}
              prefill={composerPrefill}
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
                onInsertSkill={(text) => {
                  setComposerPrefill((current) => ({
                    nonce: (current?.nonce ?? 0) + 1,
                    text,
                  }));
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
              client={runtime.client}
              composerPrefill={composerPrefill}
              draftScopeKey={`${workspace.selectedDirectory ?? "workspace"}:${view.composer.activeSessionId ?? "new"}`}
              onListCommands={listCommands}
              onOpenGoalPanel={openGoalPanel}
              onSetPermission={(input) => {
                void runAction(() => runtime.client.setPermission(input));
              }}
              onStructuredCommand={openStructuredCommand}
              onSubmit={submitText}
              pendingPrompt={visiblePendingPrompt}
              status={view.header}
              view={view}
              workspaceDirectory={workspace.selectedDirectory}
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
      {directoryPickerOpen ? (
        <DirectoryPickerModal
          onClose={() => {
            setDirectoryPickerOpen(false);
          }}
          onOpen={async (directory) => {
            if (await runAction(() => runtime.openWorkspace(directory))) {
              setDirectoryPickerOpen(false);
            }
          }}
          runtime={runtime}
        />
      ) : null}
    </main>
  );
}

function EmptyWorkspaceApp(props: {
  readonly runtime: OhbabyWebRuntime;
  readonly workspace: WorkspaceSnapshot;
}): ReactElement {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (action: () => Promise<void>) => {
    try {
      setError(null);
      await action();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  }, []);
  return (
    <main className="ohb-app ohb-app-shell ohb-app-empty ohb-project-empty">
      <ProjectRail
        onAdd={() => {
          setPickerOpen(true);
        }}
        onHide={(directory) => {
          void run(() => props.runtime.hideWorkspace(directory));
        }}
        onSelect={(directory) => {
          void run(() => props.runtime.switchWorkspace(directory));
        }}
        workspace={props.workspace}
      />
      <section className="ohb-app-content ohb-app-content-empty">
        <ErrorBanner
          message={error}
          onDismiss={() => {
            setError(null);
          }}
        />
        <div className="ohb-project-empty-message">
          <span className="ohb-project-empty-icon">
            <Folder size={24} />
          </span>
          <h1>Open a project to get started</h1>
          <p>Projects stay in this rail even before they have a session.</p>
          <button
            onClick={() => {
              setPickerOpen(true);
            }}
            type="button"
          >
            <FolderPlus size={16} /> Open project
          </button>
        </div>
      </section>
      {pickerOpen ? (
        <DirectoryPickerModal
          onClose={() => {
            setPickerOpen(false);
          }}
          onOpen={async (directory) => {
            if (await run(() => props.runtime.openWorkspace(directory))) {
              setPickerOpen(false);
            }
          }}
          runtime={props.runtime}
        />
      ) : null}
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
  readonly client: OhbabyWebClient;
  readonly composerPrefill: ComposerPrefill | null;
  readonly draftScopeKey: string;
  readonly onListCommands: () => Promise<UiWebCommandCatalog>;
  readonly onOpenGoalPanel: (intent?: GoalPanelIntent) => void;
  readonly onSetPermission: (input: {
    readonly level?: UiPermissionLevel;
    readonly mode?: UiPermissionMode;
  }) => void;
  readonly onStructuredCommand: (request: StructuredCommandRequest) => void;
  readonly onSubmit: (
    text: string,
    clientRequestId?: string,
  ) => Promise<boolean>;
  readonly pendingPrompt: PendingPrompt | null;
  readonly status: HeaderModel;
  readonly view: ViewModel;
  readonly workspaceDirectory: string | null;
}): ReactElement {
  const workspaceDirectory = props.workspaceDirectory ?? "";
  const contextLine = [
    props.view.activeSession?.title ??
      (workspaceDirectory
        ? workspaceLabel(workspaceDirectory)
        : "ohbaby-agent"),
    props.view.activeSession?.projectRoot ??
      (workspaceDirectory
        ? compactHomePath(workspaceDirectory)
        : "workspace ready"),
    props.status.modelLabel,
  ];
  return (
    <>
      <div className="ohb-empty-status">
        <StatusPill kind={props.status.connectionKind} />
        <GoalStatusChip
          goal={props.view.activeGoal}
          onOpen={props.onOpenGoalPanel}
        />
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
        {props.pendingPrompt ? (
          <PendingPromptRow prompt={props.pendingPrompt} />
        ) : null}
        <Composer
          client={props.client}
          compact
          draftScopeKey={props.draftScopeKey}
          prefill={props.composerPrefill}
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

function ProjectRail(props: {
  readonly onAdd: () => void;
  readonly onHide: (directory: string) => void;
  readonly onSelect: (directory: string) => void;
  readonly onToggleSessions?: () => void;
  readonly sessionsOpen?: boolean;
  readonly workspace: WorkspaceSnapshot;
}): ReactElement {
  const [menu, setMenu] = useState<{
    readonly directory: string;
    readonly x: number;
    readonly y: number;
  } | null>(null);
  useEffect((): (() => void) | undefined => {
    if (!menu) return;
    const close = (): void => {
      setMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);
  return (
    <nav className="ohb-project-rail" aria-label="Projects">
      {props.workspace.selectedDirectory && props.onToggleSessions ? (
        <button
          aria-expanded={props.sessionsOpen ?? false}
          aria-label={
            props.sessionsOpen ? "Collapse sessions" : "Expand sessions"
          }
          className="ohb-project-rail-toggle"
          onClick={props.onToggleSessions}
          title={props.sessionsOpen ? "Collapse sessions" : "Expand sessions"}
          type="button"
        >
          {props.sessionsOpen ? (
            <PanelLeftClose size={17} />
          ) : (
            <PanelLeftOpen size={17} />
          )}
        </button>
      ) : null}
      <div className="ohb-project-rail-list">
        {props.workspace.scopes.map((scope) => {
          const active = scope.directory === props.workspace.selectedDirectory;
          const label = workspaceLabel(scope.directory);
          return (
            <div className="ohb-project-rail-item" key={scope.directory}>
              <button
                aria-current={active ? "page" : undefined}
                aria-label={`Open ${label}`}
                className={`ohb-project-glyph ${active ? "is-active" : ""} ${
                  scope.available ? "" : "is-unavailable"
                }`}
                disabled={!scope.available}
                onClick={() => {
                  props.onSelect(scope.directory);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({
                    directory: scope.directory,
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
                style={
                  {
                    "--project-color": projectColor(scope.directory),
                  } as CSSProperties
                }
                title={
                  scope.available
                    ? `${label}\n${scope.directory}`
                    : `${label} is unavailable`
                }
                type="button"
              >
                {projectInitial(label)}
              </button>
              {active ? (
                <button
                  aria-label={`Project actions for ${label}`}
                  className="ohb-project-actions"
                  onClick={(event) => {
                    event.stopPropagation();
                    const bounds = event.currentTarget.getBoundingClientRect();
                    setMenu({
                      directory: scope.directory,
                      x: bounds.right + 6,
                      y: bounds.top,
                    });
                  }}
                  type="button"
                >
                  <MoreHorizontal size={13} />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      <button
        aria-label="Open project"
        className="ohb-project-add"
        onClick={props.onAdd}
        title="Open project"
        type="button"
      >
        <Plus size={20} />
      </button>
      {menu ? (
        <div
          className="ohb-project-menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
        >
          <button
            onClick={() => {
              props.onHide(menu.directory);
              setMenu(null);
            }}
            role="menuitem"
            type="button"
          >
            从项目栏移除
          </button>
        </div>
      ) : null}
    </nav>
  );
}

function projectInitial(label: string): string {
  return Array.from(label.trim())[0]?.toLocaleUpperCase() ?? "?";
}

function projectColor(directory: string): string {
  let hash = 0;
  for (const character of directory) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined) {
      hash = (hash * 31 + codePoint) >>> 0;
    }
  }
  return `hsl(${String(hash % 360)} 58% 84%)`;
}

function DirectoryPickerModal(props: {
  readonly onClose: () => void;
  readonly onOpen: (directory: string) => Promise<void>;
  readonly runtime: OhbabyWebRuntime;
}): ReactElement {
  const [roots, setRoots] = useState<readonly DirectoryPickerRoot[]>([]);
  const [current, setCurrent] = useState("");
  const [entries, setEntries] = useState<readonly DirectoryPickerEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const closeRef = useRef<HTMLButtonElement>(null);

  const browse = useCallback(
    async (directory: string): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const response = await props.runtime.listDirectoryEntries(directory);
        setCurrent(response.directory);
        setEntries(response.directories);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setLoading(false);
      }
    },
    [props.runtime],
  );

  useEffect((): (() => void) => {
    let cancelled = false;
    void props.runtime
      .listDirectoryRoots()
      .then(async (nextRoots) => {
        if (cancelled) return;
        setRoots(nextRoots);
        const first = nextRoots[0]?.directory;
        if (first) await browse(first);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setLoading(false);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    closeRef.current?.focus();
    return () => {
      cancelled = true;
    };
  }, [browse, props.runtime]);

  const parent = directoryParent(current);
  return (
    <div
      aria-label="Open project"
      aria-modal="true"
      className="ohb-directory-overlay"
      onKeyDown={(event) => {
        if (event.key === "Escape") props.onClose();
      }}
      role="dialog"
    >
      <section className="ohb-directory-dialog">
        <header>
          <div>
            <strong>Open project</strong>
            <small>Choose a folder from this computer</small>
          </div>
          <button
            aria-label="Close"
            onClick={props.onClose}
            ref={closeRef}
            type="button"
          >
            <X size={17} />
          </button>
        </header>
        <div className="ohb-directory-roots">
          {roots.map((root) => (
            <button
              key={root.directory}
              onClick={() => void browse(root.directory)}
              type="button"
            >
              <Folder size={14} /> {root.label}
            </button>
          ))}
        </div>
        <div className="ohb-directory-path" title={current}>
          <button
            aria-label="Go to parent folder"
            disabled={!parent || loading}
            onClick={() => parent && void browse(parent)}
            type="button"
          >
            <ChevronLeft size={16} />
          </button>
          <span>{compactHomePath(current)}</span>
        </div>
        {error ? (
          <div className="ohb-directory-error" role="alert">
            {error}
          </div>
        ) : null}
        <div className="ohb-directory-list" aria-busy={loading}>
          {loading ? (
            <div className="ohb-directory-placeholder">Loading folders…</div>
          ) : entries.length > 0 ? (
            entries.map((entry) => (
              <button
                key={entry.directory}
                onDoubleClick={() => void browse(entry.directory)}
                onClick={() => void browse(entry.directory)}
                type="button"
              >
                <Folder size={16} />
                <span>{entry.name}</span>
                <ChevronDown size={14} />
              </button>
            ))
          ) : (
            <div className="ohb-directory-placeholder">No folders here</div>
          )}
        </div>
        <footer>
          <button
            className="ohb-directory-cancel"
            onClick={props.onClose}
            type="button"
          >
            Cancel
          </button>
          <button
            className="ohb-directory-open"
            disabled={!current || loading}
            onClick={() => void props.onOpen(current)}
            type="button"
          >
            Open this folder
          </button>
        </footer>
      </section>
    </div>
  );
}

function directoryParent(directory: string): string | null {
  if (!directory || directory === "/") return null;
  const normalized = directory.replace(/[\\/]+$/u, "");
  const index = Math.max(
    normalized.lastIndexOf("/"),
    normalized.lastIndexOf("\\"),
  );
  if (index < 0) return null;
  return index === 0 ? "/" : normalized.slice(0, index);
}

function SessionSidebar(props: {
  readonly open: boolean;
  readonly onArchiveSession: (sessionId: string) => void;
  readonly onCreateSession: () => void;
  readonly onSelectSession: (sessionId: string) => void;
  readonly view: ViewModel;
  readonly workspace: WorkspaceSnapshot;
}): ReactElement {
  const sessions = useMemo(
    () => sortedSessions(props.view.snapshot?.sessions ?? []),
    [props.view.snapshot?.sessions],
  );
  const activeSessionId = props.view.activeSession?.id;

  if (!props.open) return <></>;

  return (
    <aside className="ohb-sidebar">
      <header className="ohb-sidebar-header">
        <div className="ohb-project-header">
          <strong>
            {workspaceLabel(props.workspace.selectedDirectory ?? "")}
          </strong>
          <small title={props.workspace.selectedDirectory ?? ""}>
            {compactHomePath(props.workspace.selectedDirectory ?? "")}
          </small>
        </div>
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
              const disabled = props.view.composer.disabled;
              return (
                <div
                  className={`ohb-session-row ${
                    active ? "ohb-session-active" : ""
                  } ${running ? "ohb-session-running" : ""} ${
                    disabled ? "ohb-session-disabled" : ""
                  }`}
                  aria-current={active ? "page" : undefined}
                  key={session.id}
                >
                  <button
                    className="ohb-session-main"
                    disabled={disabled}
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
                  </button>
                  <button
                    aria-label={`Archive ${title}`}
                    className="ohb-session-archive"
                    disabled={disabled}
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onArchiveSession(session.id);
                    }}
                    title={`Archive ${title}`}
                    type="button"
                  >
                    <Archive size={14} />
                  </button>
                </div>
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

function workspaceLabel(directory: string): string {
  const segments = directory.split(/[\\/]/u).filter(Boolean);
  return segments.at(-1) ?? directory;
}

function compactHomePath(directory: string): string {
  const home = "/Users/";
  if (directory.startsWith(home)) {
    const parts = directory.slice(home.length).split("/");
    return parts.length > 1 ? `~/${parts.slice(1).join("/")}` : "~";
  }
  return directory;
}

function StatusBar(props: {
  readonly activeGoal: ViewModel["activeGoal"];
  readonly header: HeaderModel;
  readonly onOpenGoalPanel: (intent?: GoalPanelIntent) => void;
}): ReactElement {
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
        <GoalStatusChip
          goal={props.activeGoal}
          onOpen={props.onOpenGoalPanel}
        />
      </div>
    </header>
  );
}

function GoalStatusChip(props: {
  readonly goal: ViewModel["activeGoal"];
  readonly onOpen: (intent?: GoalPanelIntent) => void;
}): ReactElement | null {
  if (!props.goal) {
    return null;
  }
  return (
    <button
      className={`ohb-goal-chip ohb-goal-${props.goal.status}`}
      onClick={() => {
        props.onOpen(DEFAULT_GOAL_PANEL_INTENT);
      }}
      title={props.goal.objective}
      type="button"
    >
      <span />
      goal {props.goal.status}
    </button>
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

function ConversationStream(props: {
  readonly pendingPrompt: PendingPrompt | null;
  readonly view: ViewModel;
}): ReactElement {
  const streamRef = useRef<HTMLDivElement | null>(null);
  const streamInnerRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const scheduledScrollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messages = props.view.activeSession?.messages ?? [];
  const visibleMessages = filterTodoToolMessages(messages);
  const activeSessionId = props.view.activeSession?.id ?? null;
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
    stickToBottomRef.current = true;
    scheduleStickScroll();
  }, [activeSessionId, scheduleStickScroll]);

  useLayoutEffect(() => {
    if (props.pendingPrompt !== null) {
      stickToBottomRef.current = true;
    }
    scheduleStickScroll();
  }, [
    messagesSignature,
    props.pendingPrompt?.clientRequestId,
    props.pendingPrompt?.text,
    props.view.composer.isRunning,
    scheduleStickScroll,
  ]);

  useEffect(() => {
    const element = streamRef.current;
    if (!element) {
      return;
    }
    const onScroll = (): void => {
      stickToBottomRef.current = isNearBottom(element);
    };
    element.addEventListener("scroll", onScroll);
    return (): void => {
      element.removeEventListener("scroll", onScroll);
    };
  }, []);

  useEffect(() => {
    const inner = streamInnerRef.current;
    if (!inner || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      scheduleStickScroll();
    });
    observer.observe(inner);
    return (): void => {
      observer.disconnect();
    };
  }, [scheduleStickScroll]);

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
        {visibleMessages.map((message) => (
          <MessageRow
            key={message.id}
            message={message}
            reasoning={props.view.reasoningByMessageId[message.id]}
          />
        ))}
        {props.pendingPrompt ? (
          <PendingPromptRow prompt={props.pendingPrompt} />
        ) : null}
        <CommandNoticeList notices={props.view.commandNotices} />
        {props.view.composer.isRunning ? (
          <ThinkingIndicator
            startedAt={props.view.composer.activeRunStartedAt}
          />
        ) : null}
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
  readonly onInsertSkill: (text: string) => void;
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
          onInsertSkill={props.onInsertSkill}
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
  readonly onInsertSkill: (text: string) => void;
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
      return (
        <SkillsCommandResult
          data={data}
          notice={props.notice}
          onInsertSkill={props.onInsertSkill}
        />
      );
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
  readonly onInsertSkill: (text: string) => void;
}): ReactElement {
  const skills = commandDataArray(props.data, "skills").filter(
    (skill): skill is Record<string, unknown> =>
      isRecord(skill) && stringField(skill, "name") !== undefined,
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  useEffect(() => {
    setSelectedIndex(0);
  }, [props.notice.id]);
  const insertSkill = (skill: Record<string, unknown>): void => {
    const name = stringField(skill, "name");
    if (!name) {
      return;
    }
    props.onInsertSkill(`/${name} `);
  };
  useEffect(() => {
    if (skills.length === 0) {
      return;
    }
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((index) => clampIndex(index + 1, skills.length - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((index) => clampIndex(index - 1, skills.length - 1));
        return;
      }
      if (event.key === "PageDown") {
        event.preventDefault();
        setSelectedIndex((index) => clampIndex(index + 5, skills.length - 1));
        return;
      }
      if (event.key === "PageUp") {
        event.preventDefault();
        setSelectedIndex((index) => clampIndex(index - 5, skills.length - 1));
        return;
      }
      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault();
        insertSkill(skills[clampIndex(selectedIndex, skills.length - 1)]);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return (): void => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [props.onInsertSkill, selectedIndex, skills]);
  if (skills.length === 0) {
    return <FallbackCommandResult notice={props.notice} />;
  }
  const clampedIndex = clampIndex(selectedIndex, skills.length - 1);
  return (
    <div className="ohb-command-modal-body">
      <div className="ohb-list-result">
        {skills.map((skill, index) => {
          const selected = index === clampedIndex;
          return (
            <button
              aria-selected={selected}
              className={`ohb-list-row ohb-list-skill ${
                selected ? "ohb-list-selected" : ""
              }`}
              key={`${stringField(skill, "name") ?? "skill"}-${String(index)}`}
              onClick={() => {
                insertSkill(skill);
              }}
              type="button"
            >
              <strong>/{stringField(skill, "name") ?? "skill"}</strong>
              <span>{stringField(skill, "description") ?? ""}</span>
              <small>
                {stringField(skill, "source") ??
                  stringField(skill, "scope") ??
                  "skill"}
              </small>
            </button>
          );
        })}
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

function MessageRow(props: {
  readonly message: UiMessage;
  readonly reasoning?: ViewModel["reasoningByMessageId"][string];
}): ReactElement | null {
  const isUser = props.message.role === "user";
  const isAssistant = props.message.role === "assistant";
  const label = isUser ? "You" : isAssistant ? "ohbaby" : props.message.role;
  const visibleParts = filterTodoToolParts(props.message.parts);
  if (
    props.reasoning === undefined &&
    props.message.parts.length > 0 &&
    visibleParts.length === 0
  ) {
    return null;
  }
  return (
    <article className={`ohb-message ohb-message-${props.message.role}`}>
      <div className="ohb-message-label">
        {isUser ? <User size={14} /> : <Bot size={14} />}
        <span>{label}</span>
      </div>
      <div className="ohb-message-body">
        {props.reasoning ? (
          <details className="ohb-reasoning" open={!props.reasoning.folded}>
            <summary>Thought</summary>
            <pre>{props.reasoning.content}</pre>
          </details>
        ) : null}
        {visibleParts.map((part, index) => (
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

function filterTodoToolParts(
  parts: readonly UiMessagePart[],
): readonly UiMessagePart[] {
  const hiddenCallIds = new Set(
    parts
      .filter(
        (part) =>
          part.type === "tool-call" &&
          (part.call.name === "todo_read" || part.call.name === "todo_write"),
      )
      .map((part) => (part.type === "tool-call" ? part.call.id : "")),
  );
  if (hiddenCallIds.size === 0) {
    return parts;
  }
  return parts.filter(
    (part) =>
      !(
        (part.type === "tool-call" && hiddenCallIds.has(part.call.id)) ||
        (part.type === "tool-result" && hiddenCallIds.has(part.result.callId))
      ),
  );
}

function filterTodoToolMessages(
  messages: readonly UiMessage[],
): readonly UiMessage[] {
  const hiddenCallIds = new Set(
    messages
      .flatMap((message) => message.parts)
      .filter(
        (part) =>
          part.type === "tool-call" &&
          (part.call.name === "todo_read" || part.call.name === "todo_write"),
      )
      .map((part) => (part.type === "tool-call" ? part.call.id : "")),
  );
  if (hiddenCallIds.size === 0) {
    return messages;
  }

  return messages.flatMap((message) => {
    const parts = message.parts.filter(
      (part) =>
        !(
          (part.type === "tool-call" && hiddenCallIds.has(part.call.id)) ||
          (part.type === "tool-result" && hiddenCallIds.has(part.result.callId))
        ),
    );
    return parts.length === 0 ? [] : [{ ...message, parts }];
  });
}

function PendingPromptRow(props: {
  readonly prompt: PendingPrompt;
}): ReactElement {
  return (
    <div
      className="ohb-message-pending"
      data-client-request-id={props.prompt.clientRequestId}
    >
      <MessageRow
        message={{
          createdAt: props.prompt.createdAt,
          id: `pending:${props.prompt.clientRequestId}`,
          parts: [{ text: props.prompt.text, type: "text" }],
          role: "user",
        }}
      />
      <span className="ohb-message-pending-label">Sending…</span>
    </div>
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

function thinkingElapsedSeconds(startedAt: string | undefined): number {
  const parsed = startedAt === undefined ? Number.NaN : Date.parse(startedAt);
  return Number.isFinite(parsed)
    ? Math.max(0, Math.floor((Date.now() - parsed) / 1_000))
    : 0;
}

function ThinkingIndicator(props: {
  readonly startedAt: string | undefined;
}): ReactElement {
  const [elapsedSeconds, setElapsedSeconds] = useState(() =>
    thinkingElapsedSeconds(props.startedAt),
  );
  useEffect(() => {
    setElapsedSeconds(thinkingElapsedSeconds(props.startedAt));
    const timer = window.setInterval(() => {
      setElapsedSeconds(thinkingElapsedSeconds(props.startedAt));
    }, 1_000);
    return (): void => {
      window.clearInterval(timer);
    };
  }, [props.startedAt]);
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

function permissionButtonClass(choice: UiPermissionChoice): string {
  const base = "ohb-perm-btn";
  if (choice.id === "allow_always") {
    return `${base} ohb-perm-allow-secondary`;
  }
  if (choice.intent === "allow") {
    return `${base} ohb-perm-allow-primary`;
  }
  if (choice.intent === "abort") {
    return `${base} ohb-perm-abort`;
  }
  return `${base} ohb-perm-deny`;
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
              className={permissionButtonClass(choice)}
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
  readonly client: OhbabyWebClient;
  readonly compact?: boolean;
  readonly draftScopeKey: string;
  readonly onListCommands: () => Promise<UiWebCommandCatalog>;
  readonly onSetPermission: (input: {
    readonly level?: UiPermissionLevel;
    readonly mode?: UiPermissionMode;
  }) => void;
  readonly onStructuredCommand: (request: StructuredCommandRequest) => void;
  readonly onStop: () => void;
  readonly onSubmit: (
    text: string,
    clientRequestId?: string,
  ) => Promise<boolean>;
  readonly prefill?: ComposerPrefill | null;
  readonly view: ViewModel;
}): ReactElement {
  const [draft, setDraft] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [queuedEdit, setQueuedEdit] = useState<QueuedEditState | null>(null);
  const [leaseActivityVersion, setLeaseActivityVersion] = useState(0);
  const [queueAcquirePending, setQueueAcquirePending] = useState(false);
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [slashCatalog, setSlashCatalog] = useState<UiWebCommandCatalog | null>(
    null,
  );
  const [slashDismissedDraft, setSlashDismissedDraft] = useState<string | null>(
    null,
  );
  const [slashError, setSlashError] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastEscapeAt = useRef(0);
  const lastLeaseRenewalAt = useRef(0);
  const leaseRenewalTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueAcquirePendingRef = useRef(false);
  const queueAcquireGenerationRef = useRef(0);
  const canSend =
    props.view.composer.canSend && draft.trim().length > 0 && !isSubmitting;
  const canUseSlash = props.view.composer.canSend && !isSubmitting;
  const visibleQueuedPrompts = queueExpanded
    ? props.view.queuedPrompts
    : props.view.queuedPrompts.slice(0, 5);
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

  useLayoutEffect(() => {
    const stored = readSessionValue(
      composerDraftKey(props.draftScopeKey),
    ) as StoredComposerDraft | null;
    setDraft(stored?.text ?? "");
    setPendingRequestId(stored?.clientRequestId ?? null);
    setPendingText(stored?.pendingText ?? null);
    setQueueExpanded(false);
    queueAcquireGenerationRef.current += 1;
    queueAcquirePendingRef.current = false;
    setQueueAcquirePending(false);
    setQueueError(null);
    setLeaseActivityVersion(0);

    const storedLease = readSessionValue(
      composerLeaseKey(props.draftScopeKey),
    ) as StoredQueuedEdit | null;
    if (!storedLease) {
      setQueuedEdit(null);
      return;
    }
    setDraft(storedLease.editText);
    setQueuedEdit(storedLease);
    void props.client
      .renewPromptEditLease(storedLease.promptId, storedLease.editLeaseId)
      .then((lease) => {
        lastLeaseRenewalAt.current = Date.now();
        writeSessionValue(composerLeaseKey(props.draftScopeKey), {
          ...storedLease,
          expiresAt: lease.expiresAt,
        });
      })
      .catch(() => {
        setQueuedEdit(null);
        removeSessionValue(composerLeaseKey(props.draftScopeKey));
        writeSessionValue(composerDraftKey(props.draftScopeKey), {
          text: storedLease.editText,
        } satisfies StoredComposerDraft);
        setQueueError(
          "Queued edit lease expired. Your text is preserved and can be sent as a new prompt.",
        );
      });
  }, [props.client, props.draftScopeKey]);

  useEffect(() => {
    return (): void => {
      if (leaseRenewalTimer.current !== null) {
        globalThis.clearTimeout(leaseRenewalTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!props.prefill) {
      return;
    }
    setDraft(props.prefill.text);
    writeSessionValue(composerDraftKey(props.draftScopeKey), {
      text: props.prefill.text,
    } satisfies StoredComposerDraft);
    setSlashDismissedDraft(null);
    setSlashError(null);
    setSlashIndex(0);
    textareaRef.current?.focus();
  }, [props.draftScopeKey, props.prefill]);

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

  const persistDraft = useCallback(
    (text: string, requestId?: string, requestText?: string): void => {
      writeSessionValue(composerDraftKey(props.draftScopeKey), {
        ...(requestId === undefined ? {} : { clientRequestId: requestId }),
        ...(requestText === undefined ? {} : { pendingText: requestText }),
        text,
      } satisfies StoredComposerDraft);
    },
    [props.draftScopeKey],
  );

  const updateDraft = useCallback(
    (nextDraft: string): void => {
      setDraft(nextDraft);
      const keepPending =
        pendingRequestId !== null && pendingText === nextDraft.trim();
      if (!keepPending) {
        setPendingRequestId(null);
        setPendingText(null);
      }
      persistDraft(
        nextDraft,
        keepPending ? pendingRequestId : undefined,
        keepPending ? pendingText : undefined,
      );
      if (queuedEdit) {
        setLeaseActivityVersion((version) => version + 1);
        writeSessionValue(composerLeaseKey(props.draftScopeKey), {
          ...queuedEdit,
          editText: nextDraft,
          lastActivityAt: Date.now(),
        } satisfies StoredQueuedEdit);
      }
    },
    [
      pendingRequestId,
      pendingText,
      persistDraft,
      props.draftScopeKey,
      queuedEdit,
    ],
  );

  useEffect(() => {
    if (!queuedEdit || leaseActivityVersion === 0) return;
    if (leaseRenewalTimer.current !== null) {
      globalThis.clearTimeout(leaseRenewalTimer.current);
    }
    const delay = Math.max(
      0,
      20_000 - (Date.now() - lastLeaseRenewalAt.current),
    );
    leaseRenewalTimer.current = globalThis.setTimeout(() => {
      leaseRenewalTimer.current = null;
      void props.client
        .renewPromptEditLease(queuedEdit.promptId, queuedEdit.editLeaseId)
        .then((lease) => {
          lastLeaseRenewalAt.current = Date.now();
          writeSessionValue(composerLeaseKey(props.draftScopeKey), {
            ...queuedEdit,
            editText: draft,
            expiresAt: lease.expiresAt,
            lastActivityAt: Date.now(),
          } satisfies StoredQueuedEdit);
        })
        .catch(() => {
          setQueuedEdit(null);
          removeSessionValue(composerLeaseKey(props.draftScopeKey));
          persistDraft(draft);
          setQueueError(
            "Queued edit lease expired. Your text is preserved and can be sent as a new prompt.",
          );
        });
    }, delay);
    return (): void => {
      if (leaseRenewalTimer.current !== null) {
        globalThis.clearTimeout(leaseRenewalTimer.current);
        leaseRenewalTimer.current = null;
      }
    };
  }, [
    draft,
    leaseActivityVersion,
    persistDraft,
    props.client,
    props.draftScopeKey,
    queuedEdit,
  ]);

  const beginQueuedEdit = useCallback(
    (prompt: ViewModel["queuedPrompts"][number]): void => {
      if (queuedEdit || queueAcquirePendingRef.current) {
        setQueueError("Finish or cancel the current queued edit first.");
        return;
      }
      setQueueError(null);
      const acquireGeneration = queueAcquireGenerationRef.current + 1;
      queueAcquireGenerationRef.current = acquireGeneration;
      queueAcquirePendingRef.current = true;
      setQueueAcquirePending(true);
      void props.client
        .acquirePromptEditLease(prompt.promptId)
        .then((lease) => {
          if (queueAcquireGenerationRef.current !== acquireGeneration) {
            void props.client
              .releasePromptEditLease(prompt.promptId, lease.editLeaseId)
              .catch(() => undefined);
            return;
          }
          const next: QueuedEditState = {
            editLeaseId: lease.editLeaseId,
            expiresAt: lease.expiresAt,
            originalDraft: draft,
            ...(pendingRequestId === null
              ? {}
              : { originalPendingRequestId: pendingRequestId }),
            ...(pendingText === null
              ? {}
              : { originalPendingText: pendingText }),
            promptId: prompt.promptId,
          };
          lastLeaseRenewalAt.current = Date.now();
          setLeaseActivityVersion(0);
          setQueuedEdit(next);
          setDraft(prompt.text);
          setPendingRequestId(null);
          setPendingText(null);
          writeSessionValue(composerLeaseKey(props.draftScopeKey), {
            ...next,
            editText: prompt.text,
            lastActivityAt: Date.now(),
          } satisfies StoredQueuedEdit);
          textareaRef.current?.focus();
        })
        .catch((error: unknown) => {
          if (queueAcquireGenerationRef.current === acquireGeneration) {
            setQueueError(
              error instanceof Error ? error.message : String(error),
            );
          }
        })
        .finally(() => {
          if (queueAcquireGenerationRef.current === acquireGeneration) {
            queueAcquirePendingRef.current = false;
            setQueueAcquirePending(false);
          }
        });
    },
    [
      draft,
      pendingRequestId,
      pendingText,
      props.client,
      props.draftScopeKey,
      queuedEdit,
    ],
  );

  const finishQueuedEdit = useCallback((): void => {
    if (!queuedEdit || !draft.trim()) return;
    setIsSubmitting(true);
    void props.client
      .editQueuedPrompt(
        queuedEdit.promptId,
        queuedEdit.editLeaseId,
        draft.trim(),
      )
      .then(() => {
        const restored = queuedEdit.originalDraft;
        setQueuedEdit(null);
        setDraft(restored);
        setPendingRequestId(queuedEdit.originalPendingRequestId ?? null);
        setPendingText(queuedEdit.originalPendingText ?? null);
        persistDraft(
          restored,
          queuedEdit.originalPendingRequestId,
          queuedEdit.originalPendingText,
        );
        removeSessionValue(composerLeaseKey(props.draftScopeKey));
      })
      .catch((error: unknown) => {
        setQueueError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setIsSubmitting(false);
      });
  }, [draft, persistDraft, props.client, props.draftScopeKey, queuedEdit]);

  const releaseQueuedEdit = useCallback((): void => {
    if (!queuedEdit) return;
    const current = queuedEdit;
    void props.client
      .releasePromptEditLease(current.promptId, current.editLeaseId)
      .catch(() => undefined);
    setQueuedEdit(null);
    setDraft(current.originalDraft);
    setPendingRequestId(current.originalPendingRequestId ?? null);
    setPendingText(current.originalPendingText ?? null);
    persistDraft(
      current.originalDraft,
      current.originalPendingRequestId,
      current.originalPendingText,
    );
    removeSessionValue(composerLeaseKey(props.draftScopeKey));
  }, [persistDraft, props.client, props.draftScopeKey, queuedEdit]);

  const cancelQueuedPrompt = useCallback(
    (promptId: string): void => {
      const editLeaseId =
        queuedEdit?.promptId === promptId ? queuedEdit.editLeaseId : undefined;
      void props.client
        .cancelQueuedPrompt(promptId, editLeaseId)
        .then(() => {
          if (queuedEdit?.promptId === promptId) {
            setQueuedEdit(null);
            setDraft(queuedEdit.originalDraft);
            setPendingRequestId(queuedEdit.originalPendingRequestId ?? null);
            setPendingText(queuedEdit.originalPendingText ?? null);
            persistDraft(
              queuedEdit.originalDraft,
              queuedEdit.originalPendingRequestId,
              queuedEdit.originalPendingText,
            );
            removeSessionValue(composerLeaseKey(props.draftScopeKey));
          }
        })
        .catch((error: unknown) => {
          setQueueError(error instanceof Error ? error.message : String(error));
        });
    },
    [persistDraft, props.client, props.draftScopeKey, queuedEdit],
  );

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text || !props.view.composer.canSend) {
      return;
    }
    if (queuedEdit) {
      finishQueuedEdit();
      return;
    }
    const clientRequestId = pendingRequestId ?? globalThis.crypto.randomUUID();
    setPendingRequestId(clientRequestId);
    setPendingText(text);
    persistDraft(draft, clientRequestId, text);
    setIsSubmitting(true);
    void props
      .onSubmit(text, clientRequestId)
      .then((sent) => {
        if (sent) {
          setDraft("");
          setPendingRequestId(null);
          setPendingText(null);
          removeSessionValue(composerDraftKey(props.draftScopeKey));
        }
      })
      .finally(() => {
        setIsSubmitting(false);
      });
  }, [
    draft,
    finishQueuedEdit,
    pendingRequestId,
    persistDraft,
    props.draftScopeKey,
    props.onSubmit,
    props.view.composer.canSend,
    queuedEdit,
  ]);

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
        props.onStructuredCommand({ item, text: draft.trim() || item.label });
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
      if (event.key === "Escape" && queuedEdit) {
        event.preventDefault();
        releaseQueuedEdit();
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
      queuedEdit,
      releaseQueuedEdit,
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
      <TodoDock
        key={props.view.activeTodoList?.sessionId ?? "hidden"}
        todoList={props.view.activeTodoList}
      />
      {props.view.queuedPrompts.length > 0 ? (
        <section className="ohb-prompt-queue" aria-label="Queued prompts">
          <div className="ohb-prompt-queue-header">
            <span>Queued {String(props.view.queuedPrompts.length)}</span>
            {props.view.queuedPrompts.length > 5 ? (
              <button
                onClick={() => {
                  setQueueExpanded((expanded) => !expanded);
                }}
                title={
                  queueExpanded
                    ? "Collapse queued prompts"
                    : "Show all queued prompts"
                }
                type="button"
              >
                {queueExpanded ? "Show less" : "Show all"}
              </button>
            ) : null}
          </div>
          <div className="ohb-prompt-queue-items">
            {visibleQueuedPrompts.map((prompt) => {
              const editing = queuedEdit?.promptId === prompt.promptId;
              return (
                <div
                  className={`ohb-prompt-queue-item ${editing ? "is-editing" : ""}`}
                  key={prompt.promptId}
                >
                  <button
                    aria-label={`Edit queued prompt: ${prompt.text}`}
                    className="ohb-prompt-queue-edit"
                    disabled={isSubmitting || queueAcquirePending}
                    onClick={() => {
                      beginQueuedEdit(prompt);
                    }}
                    type="button"
                  >
                    <span aria-hidden="true">↳</span>
                    <span>{prompt.text.replaceAll("\n", " ")}</span>
                    {editing ? <small>editing</small> : null}
                  </button>
                  <button
                    aria-label={`Cancel queued prompt: ${prompt.text}`}
                    className="ohb-prompt-queue-cancel"
                    disabled={isSubmitting || queueAcquirePending}
                    onClick={() => {
                      cancelQueuedPrompt(prompt.promptId);
                    }}
                    title="Cancel queued prompt"
                    type="button"
                  >
                    <X size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
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
            updateDraft(nextDraft);
            setSlashIndex(0);
            if (nextDraft !== slashDismissedDraft) {
              setSlashDismissedDraft(null);
            }
          }}
          onKeyDown={onKeyDown}
          placeholder={composerPlaceholder(props.view)}
          ref={textareaRef}
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
        ) : null}
        <button
          className="ohb-send-button"
          disabled={!canSend}
          onClick={send}
          title={queuedEdit ? "Save queued prompt" : "Send message"}
          type="button"
        >
          <Send size={14} />
          <span>{queuedEdit ? "Save" : "Send"}</span>
        </button>
      </div>
      <div className="ohb-composer-tools">
        {slashError ? (
          <span className="ohb-slash-error">{slashError}</span>
        ) : null}
        {queueError ? (
          <span className="ohb-slash-error">{queueError}</span>
        ) : null}
        {queuedEdit ? (
          <span className="ohb-composer-hint">
            Editing queued prompt · Enter save · Esc keep original
          </span>
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

function TodoDock(props: {
  readonly todoList: ViewModel["activeTodoList"];
}): ReactElement | null {
  const [expanded, setExpanded] = useState(true);

  if (!props.todoList) {
    return null;
  }

  const completedCount = props.todoList.todos.filter(
    (todo) => todo.status === "completed",
  ).length;
  const preview = selectTodoDockPreview(props.todoList.todos);

  return (
    <section
      aria-label="Todo list"
      className={`ohb-todo-dock ${expanded ? "ohb-todo-dock-expanded" : "ohb-todo-dock-collapsed"}`}
    >
      <header>
        <button
          aria-controls="ohb-todo-items"
          aria-expanded={expanded}
          className="ohb-todo-toggle"
          onClick={() => {
            setExpanded((current) => !current);
          }}
          title={expanded ? "Collapse todo list" : "Expand todo list"}
          type="button"
        >
          <span className="ohb-todo-title">Tasks</span>
          <span className="ohb-todo-progress">
            {String(completedCount)}/{String(props.todoList.todos.length)}{" "}
            completed
          </span>
          <ChevronDown
            aria-hidden="true"
            className="ohb-todo-chevron"
            size={14}
          />
        </button>
      </header>
      {expanded ? (
        <div
          aria-label="Todo items"
          className="ohb-todo-items"
          id="ohb-todo-items"
          role="list"
          tabIndex={0}
        >
          {props.todoList.todos.map((todo, index) => (
            <TodoDockItem
              key={`${String(index)}:${todo.content}`}
              todo={todo}
            />
          ))}
        </div>
      ) : (
        <div
          aria-label="Current todo"
          className="ohb-todo-preview"
          id="ohb-todo-items"
          role="list"
        >
          {preview ? <TodoDockItem todo={preview} /> : null}
        </div>
      )}
    </section>
  );
}

function TodoDockItem(props: {
  readonly todo: NonNullable<ViewModel["activeTodoList"]>["todos"][number];
}): ReactElement {
  return (
    <div
      aria-label={`${todoStatusLabel(props.todo.status)}: ${props.todo.content}`}
      className={`ohb-todo-item ohb-todo-${props.todo.status}`}
      role="listitem"
    >
      <span aria-hidden="true" className="ohb-todo-marker">
        {todoStatusMarker(props.todo.status)}
      </span>
      <span>{props.todo.content}</span>
    </div>
  );
}

function selectTodoDockPreview(
  todos: NonNullable<ViewModel["activeTodoList"]>["todos"],
): NonNullable<ViewModel["activeTodoList"]>["todos"][number] | undefined {
  return (
    todos.find((todo) => todo.status === "in_progress") ??
    todos.find((todo) => todo.status === "pending") ??
    todos.at(-1)
  );
}

function todoStatusLabel(status: UiTodoStatus): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "in_progress":
      return "In progress";
    case "completed":
      return "Completed";
  }
}

function todoStatusMarker(status: UiTodoStatus): string {
  switch (status) {
    case "pending":
      return "○";
    case "in_progress":
      return "●";
    case "completed":
      return "✓";
  }
}

function StructuredCommandOverlay(props: {
  readonly client: OhbabyWebClient;
  readonly onClose: () => void;
  readonly overlay: StructuredOverlayState;
  readonly view: ViewModel;
}): ReactElement {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (dialogRef.current?.contains(document.activeElement)) {
      return;
    }
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
        ref={dialogRef}
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
        ) : props.overlay.kind === "goal" ? (
          <GoalOverlayBody
            client={props.client}
            intent={props.overlay.goalIntent ?? DEFAULT_GOAL_PANEL_INTENT}
            view={props.view}
          />
        ) : (
          <CompactOverlayBody client={props.client} view={props.view} />
        )}
      </section>
    </div>
  );
}

function GoalOverlayBody(props: {
  readonly client: OhbabyWebClient;
  readonly intent: GoalPanelIntent;
  readonly view: ViewModel;
}): ReactElement {
  const sessionId =
    props.view.composer.activeSessionId ?? props.view.activeSession?.id;
  const activeGoal = props.view.activeGoal;
  const [objective, setObjective] = useState(
    props.intent.objectiveDraft ?? activeGoal?.objective ?? "",
  );
  const [status, setStatus] = useState<OverlayStatus>({
    kind: "idle",
    message: sessionId ? "" : "No active session for goal commands.",
  });

  useEffect(() => {
    setObjective(props.intent.objectiveDraft ?? activeGoal?.objective ?? "");
  }, [activeGoal?.objective, props.intent.objectiveDraft]);

  const runGoalCommand = useCallback(
    (text: string, busyMessage: string, successMessage: string) => {
      if (!sessionId) {
        setStatus({
          kind: "error",
          message: "No active session for goal commands.",
        });
        return;
      }
      void runOverlayAction(
        setStatus,
        async () => {
          await props.client.executeSlashCommand({
            allowOverlay: true,
            sessionId,
            text,
          });
          return successMessage;
        },
        busyMessage,
      );
    },
    [props.client, sessionId],
  );

  const saveGoal = useCallback(() => {
    const trimmed = objective.trim();
    if (!trimmed) {
      setStatus({ kind: "error", message: "Goal objective is required." });
      return;
    }
    runGoalCommand(
      activeGoal ? `/goal replace ${trimmed}` : `/goal ${trimmed}`,
      activeGoal ? "Saving goal" : "Creating goal",
      activeGoal ? "goal updated" : "goal created",
    );
  }, [activeGoal, objective, runGoalCommand]);

  const pauseGoal = useCallback(() => {
    runGoalCommand("/goal pause", "Pausing goal", "goal paused");
  }, [runGoalCommand]);

  const resumeGoal = useCallback(() => {
    runGoalCommand("/goal resume", "Resuming goal", "goal resumed");
  }, [runGoalCommand]);

  const deleteGoal = useCallback(() => {
    runGoalCommand("/goal cancel", "Deleting goal", "goal deleted");
  }, [runGoalCommand]);
  const canSaveGoal = Boolean(sessionId) && objective.trim().length > 0;

  return (
    <div className="ohb-structured-body">
      {activeGoal ? (
        <OverlayResult
          rows={[
            ["status", activeGoal.status],
            ["objective", activeGoal.objective],
            ...(activeGoal.pauseReason
              ? [["reason", activeGoal.pauseReason] as const]
              : []),
          ]}
        />
      ) : (
        <p>No current goal for this session.</p>
      )}
      <label className="ohb-structured-field ohb-goal-objective-field">
        <span>Objective</span>
        <textarea
          autoFocus={props.intent.action === "save"}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
            setObjective(event.target.value);
          }}
          placeholder="Describe the goal"
          rows={4}
          value={objective}
        />
      </label>
      <OverlayStatusLine status={status} />
      <div className="ohb-structured-actions ohb-goal-actions">
        <button
          autoFocus={props.intent.action === "delete"}
          className={goalActionButtonClass(
            props.intent,
            "delete",
            "ohb-button",
          )}
          data-goal-action="delete"
          disabled={!sessionId || !activeGoal}
          onClick={deleteGoal}
          title="Delete goal"
          type="button"
        >
          Delete goal
        </button>
        <button
          autoFocus={props.intent.action === "pause"}
          className={goalActionButtonClass(props.intent, "pause", "ohb-button")}
          data-goal-action="pause"
          disabled={!sessionId || activeGoal?.status !== "active"}
          onClick={pauseGoal}
          title="Pause goal"
          type="button"
        >
          Pause
        </button>
        <button
          autoFocus={props.intent.action === "resume"}
          className={goalActionButtonClass(
            props.intent,
            "resume",
            "ohb-button",
          )}
          data-goal-action="resume"
          disabled={!sessionId || activeGoal?.status !== "paused"}
          onClick={resumeGoal}
          title="Resume goal"
          type="button"
        >
          Resume
        </button>
        <button
          className={goalActionButtonClass(
            props.intent,
            "save",
            "ohb-button-primary",
          )}
          data-goal-action="save"
          disabled={!canSaveGoal}
          onClick={saveGoal}
          title="Save goal"
          type="button"
        >
          Save
        </button>
      </div>
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
            apiKeyEnv: model.apiKeyEnv ?? "",
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
          placeholder="ZHIPU_API_KEY, or blank for local services"
          value={form.apiKeyEnv}
        />
        <TextField
          label="API key"
          onChange={(value) => {
            update("apiKey", value);
          }}
          placeholder="optional, writes to .env when provided"
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
            ...(result.warning ? [["warning", result.warning] as const] : []),
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

function clampIndex(index: number, maxIndex: number): number {
  return Math.max(0, Math.min(index, maxIndex));
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
  const apiKeyEnv = trimmedOrUndefined(form.apiKeyEnv);
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
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
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
    case "openGoalPanel":
      return "goal";
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
    case "goal":
      return "Goal";
  }
}

function goalPanelIntentFromArgs(rawArgs: string): GoalPanelIntent {
  const trimmed = rawArgs.trim();
  if (!trimmed) {
    return DEFAULT_GOAL_PANEL_INTENT;
  }
  const [command = "", ...rest] = trimmed.split(/\s+/u);
  switch (command) {
    case "status":
      return DEFAULT_GOAL_PANEL_INTENT;
    case "pause":
      return { action: "pause" };
    case "resume":
      return { action: "resume" };
    case "cancel":
      return { action: "delete" };
    case "replace":
      return {
        action: "save",
        objectiveDraft: rest.join(" "),
      };
    default:
      return { action: "save", objectiveDraft: trimmed };
  }
}

function goalActionButtonClass(
  intent: GoalPanelIntent,
  action: GoalPanelAction,
  baseClass: string,
): string {
  return intent.action === action
    ? `${baseClass} ohb-goal-action-highlight`
    : baseClass;
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
