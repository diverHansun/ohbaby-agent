import {
  compareUiPromptQueueOrder,
  getUnconsumedSteers,
  sessionActionErrorText,
} from "ohbaby-sdk";
import { SideChatPanel } from "./components/side-chat-panel.js";
import { RewindPanel } from "./components/rewind/RewindPanel.js";
import {
  rewindablePrompts,
  rewindConfirmation,
} from "./components/rewind/rewind-model.js";
import { createSubagentReader } from "ohbaby-sdk";
import {
  SubagentBrowser,
  SubagentWait,
} from "./components/subagent-browser.js";
import {
  DurationSampleContext,
  DurationDiagnosticContext,
} from "./components/execution-duration.js";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import type {
  CoreAPI,
  UiCommandInvocation,
  UiCommandOutput,
  UiEvent,
  UiEventHandler,
  UiSnapshot,
  UiUnsubscribe,
} from "ohbaby-sdk";
import { usePermissionSync } from "./use-permission-sync.js";
import {
  createTuiSessionRecovery,
  pendingPromptBlocks,
  type TuiSessionRecovery,
  type TuiRecoveryState,
} from "./session-recovery.js";
import { createPendingPromptStorage } from "./pending-prompts.js";
import {
  describeExportError,
  EXPORT_USAGE,
  parseExportFormat,
  runSessionExport,
} from "./session-export/run-export.js";
import { parseSlashInput, resolveCommand } from "./slash-commands/runtime.js";
import { formatError } from "./format-error.js";
import { DialogManager } from "./dialogs/manager.js";
import { CommandPanelManager } from "./components/dialog/command-panel-manager.js";
import {
  displayPanelKindForCommandId,
  interactivePanelKindForCommandId,
  type CommandPanelKind,
  type CommandPanelState,
} from "./components/dialog/command-panel-state.js";
import { Header } from "./components/header.js";
import { TranscriptViewport } from "./components/transcript/transcript-viewport.js";
import {
  Prompt,
  type PendingReasoningSelection,
} from "./components/prompt/index.js";
import { TodoPanel } from "./components/todo-panel.js";
import { AppShell } from "./layout/app-shell.js";
import { formatFooterContextUsage } from "./render/usage.js";
import { useFooterModel } from "./use-footer-model.js";
import { useSubagentState } from "./use-subagent-state.js";
import { createTuiStore } from "./store/events.js";
import {
  selectActiveGoal,
  selectActiveRawTodoList,
  selectActiveContextWindowUsage,
  useTuiStoreSelector,
} from "./store/selectors.js";
import {
  selectCommittedItems,
  selectLiveMessage,
  selectLiveReasoning,
} from "./store/selectors/transcript.js";
import { createCoalescedTuiEventDispatcher } from "./store/stream-coalescer.js";
import { ThemeProvider } from "./theme/index.js";
import type { ExitTranscript } from "./exit-transcript.js";
import type {
  TuiCommandCatalog,
  TuiStore,
  TuiRuntimeStatus,
} from "./store/snapshot.js";

export const SESSION_VIEW_CLEAR_SEQUENCE = "\x1b[2J\x1b[3J\x1b[H";
export const NEW_SESSION_CLEAR_SEQUENCE = SESSION_VIEW_CLEAR_SEQUENCE;

export const ESC_INTERRUPT_WINDOW_MS = 1500;
const ESC_INTERRUPT_HINT = "Press Esc again to interrupt";
const EMPTY_INITIAL_NOTICES: readonly string[] = [];

type TranscriptSurfaceResetReason = "new-session" | "switch-session";

export interface TerminalUiOptions {
  /** Internal exit snapshot; emitted after pending stream events are flushed. */
  readonly onExitTranscript?: (transcript: ExitTranscript) => void;
  /** A fixed transcript viewport and dock, owned by Ink alternate screen. */
  readonly fullscreen?: boolean;
  readonly reportDurationClockAnomaly?: (identity: string) => void;
  readonly pendingPromptWorkspace?: string;
  readonly clearOnStart?: boolean;
  readonly client: CoreAPI;
  readonly initialNotices?: readonly string[];
  readonly subscribeEvents: (handler: UiEventHandler) => UiUnsubscribe;
  readonly subscribeDiagnosticsUnavailable?: (
    listener: () => void,
  ) => () => void;
  /** Connected to a daemon with --remote-port; /btw is unavailable then. */
  readonly remote?: boolean;
}

export function OhbabyTerminalApp({
  fullscreen = false,
  onExitTranscript,
  clearOnStart = false,
  pendingPromptWorkspace,
  client,
  initialNotices = EMPTY_INITIAL_NOTICES,
  subscribeEvents,
  subscribeDiagnosticsUnavailable,
  reportDurationClockAnomaly,
  remote = false,
}: TerminalUiOptions): ReactElement {
  const storeRef = useRef<TuiStore>(createTuiStore(createEmptySnapshot()));
  const keyboardCommandSequenceRef = useRef(0);
  const compactCommandRef = useRef<AbortController | null>(null);
  const [queueInputMode, setQueueInputMode] = useState(false);
  const [toolView, setToolView] = useState<{
    sessionId: string | null;
    expanded: boolean;
  }>({ sessionId: null, expanded: false });
  const catalogRequestSequenceRef = useRef(0);
  const contextRefreshSequenceRef = useRef(0);
  const contextNoticeSequenceRef = useRef(0);
  const diagnosticsNoticeSequenceRef = useRef(0);
  const recoveryRef = useRef<TuiSessionRecovery | null>(null);
  const [recoveryState, setRecoveryState] = useState<TuiRecoveryState>({
    sync: { status: "idle", scope: null, attempts: 0 },
    control: null,
    initialized: false,
    pending: [],
  });
  const didClearOnStartRef = useRef(false);
  const disposedRef = useRef(false);
  const [screenGeneration, setScreenGeneration] = useState(0);
  const submissionGenerationRef = useRef(0);
  const [submissionContextGeneration, setSubmissionContextGeneration] =
    useState(0);
  const submissionEpochRef = useRef<string | undefined>(undefined);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [pendingReasoning, setPendingReasoning] =
    useState<PendingReasoningSelection | null>(null);
  // A draft's `/models` choice, sent with its first prompt (session-model D20).
  const [pendingModelEntryId, setPendingModelEntryId] = useState<string | null>(
    null,
  );
  const [commandPanel, setCommandPanel] = useState<CommandPanelState | null>(
    null,
  );
  const activeSessionIdRef = useRef<string | null>(null);
  const commandPanelRef = useRef<CommandPanelState | null>(null);
  const pendingDisplayCommandInvocationsRef = useRef<
    Map<string, { readonly sessionId: string | null }>
  >(new Map());
  const store = storeRef.current;
  const { exit } = useApp();
  const { write: writeStdout } = useStdout();
  if (!fullscreen && clearOnStart && !didClearOnStartRef.current) {
    writeStdout(NEW_SESSION_CLEAR_SEQUENCE);
    didClearOnStartRef.current = true;
  }
  const activeSessionId = useTuiStoreSelector(
    store,
    (state) => state.activeSessionId,
  );
  activeSessionIdRef.current = activeSessionId;
  useEffect(
    () => (): void => {
      compactCommandRef.current?.abort();
      compactCommandRef.current = null;
    },
    [activeSessionId],
  );
  const exportNoticeSequenceRef = useRef(0);
  const emitLocalNotice = useCallback(
    (
      source: string,
      level: "info" | "error",
      title: string,
      message: string,
    ): void => {
      exportNoticeSequenceRef.current += 1;
      store.dispatch({
        notice: {
          createdAt: new Date().toISOString(),
          id: `${source}_notice_${String(exportNoticeSequenceRef.current)}`,
          level,
          message,
          source,
          title,
        },
        type: "notice.emitted",
      });
    },
    [store],
  );
  const emitExportNotice = useCallback(
    (level: "info" | "error", title: string, message: string): void => {
      emitLocalNotice("export", level, title, message);
    },
    [emitLocalNotice],
  );
  // /btw replaces the main view while open (frontend design §3.2).
  const [sideChat, setSideChat] = useState<{
    readonly sideChatId: string;
    readonly boundaryMessageId: string;
    readonly firstQuestion?: string;
  } | null>(null);
  const [rewindOpen, setRewindOpen] = useState(false);
  const promptDraftRef = useRef("");
  const [promptPrefill, setPromptPrefill] = useState<{
    readonly nonce: number;
    readonly text: string;
  }>();
  /** Runs /btw, /fork and /rewind here; each reports through a notice. */
  const runSessionAction = useCallback(
    async (
      invocation: Parameters<CoreAPI["executeCommand"]>[0],
    ): ReturnType<CoreAPI["executeCommand"]> => {
      const base = {
        clientInvocationId: invocation.clientInvocationId,
        commandRunId: `local_${invocation.commandId}_${invocation.clientInvocationId}`,
        eventCount: 0,
        outputCount: 0,
      };
      const sessionId = activeSessionIdRef.current;
      const fail = (title: string, message: string) => {
        emitLocalNotice(invocation.commandId, "error", title, message);
        return {
          ...base,
          error: { code: "COMMAND_FAILED", message, recoverable: true },
          status: "failed" as const,
        };
      };
      const done = { ...base, status: "completed" as const };
      if (invocation.commandId === "rewind") {
        if (sessionId === null) return fail("Rewind", "Nothing to rewind yet.");
        setRewindOpen(true);
        return done;
      }
      if (invocation.commandId === "fork") {
        if (sessionId === null)
          return fail("Fork failed", "Nothing to fork yet");
        try {
          const forked = await client.forkSession({ sessionId });
          await client.selectSession(forked.sessionId);
          emitLocalNotice(
            "fork",
            "info",
            "Forked",
            `Forked to ${forked.title}`,
          );
          return { ...done, sessionId: forked.sessionId };
        } catch (caught) {
          return fail("Fork failed", sessionActionErrorText("fork", caught));
        }
      }
      // /btw
      if (remote)
        return fail(
          "Side chat",
          "/btw is not available when connected to a remote daemon",
        );
      const started =
        sessionId !== null &&
        store
          .getState()
          .prompts.some((prompt) => prompt.sessionId === sessionId);
      if (!started)
        return fail(
          "Side chat",
          "/btw is unavailable until this conversation has started. Send a message first, then try /btw again.",
        );
      try {
        const opened = await client.openSideChat({ mainSessionId: sessionId });
        const question = invocation.rawArgs.trim();
        setSideChat({
          sideChatId: opened.sideChatId,
          boundaryMessageId: opened.boundaryMessageId,
          ...(question === "" ? {} : { firstQuestion: question }),
        });
        return done;
      } catch (caught) {
        return fail("Side chat", formatError(caught));
      }
    },
    [client, emitLocalNotice, remote, store],
  );
  const closeSideChat = useCallback((): void => {
    const current = sideChat;
    if (!current) return;
    setSideChat(null);
    // The main view was unmounted; reprint it as the subagent browser does.
    if (!fullscreen) writeStdout(SESSION_VIEW_CLEAR_SEQUENCE);
    void client
      .closeSideChat({ sideChatId: current.sideChatId })
      .catch((caught: unknown) => {
        emitLocalNotice("btw", "error", "Side chat", formatError(caught));
      });
  }, [client, emitLocalNotice, fullscreen, sideChat, writeStdout]);
  const runExportCommand = useCallback(
    async (
      invocation: Parameters<CoreAPI["executeCommand"]>[0],
    ): ReturnType<CoreAPI["executeCommand"]> => {
      const base = {
        clientInvocationId: invocation.clientInvocationId,
        commandRunId: `local_export_${invocation.clientInvocationId}`,
        eventCount: 0,
        outputCount: 0,
      };
      const fail = (message: string): ReturnType<CoreAPI["executeCommand"]> => {
        emitExportNotice("error", "Export failed", message);
        return Promise.resolve({
          ...base,
          error: { code: "EXPORT_FAILED", message, recoverable: true },
          status: "failed",
        });
      };
      const format = parseExportFormat(invocation.argv);
      if (format === undefined) return fail(EXPORT_USAGE);
      const sessionId = activeSessionIdRef.current;
      if (sessionId === null) return fail("No session to export.");
      try {
        const outcome = await runSessionExport({ client, sessionId, format });
        emitExportNotice(
          "info",
          "Session exported",
          `Exported ${String(outcome.messageCount)} messages to ${outcome.path}\nThe file may contain command output or file contents; review it before sharing.`,
        );
        return { ...base, sessionId, status: "completed" };
      } catch (caught) {
        return fail(describeExportError(caught));
      }
    },
    [client, emitExportNotice],
  );
  const executePromptCommand = useCallback<CoreAPI["executeCommand"]>(
    async (invocation) => {
      // /export runs locally so the file lands on this machine, even with a remote backend.
      if (invocation.commandId === "export")
        return runExportCommand(invocation);
      if (["btw", "fork", "rewind"].includes(invocation.commandId))
        return runSessionAction(invocation);
      if (invocation.commandId !== "compact")
        return client.executeCommand(invocation);
      if (compactCommandRef.current)
        throw new Error("Context compaction is already running");
      const controller = new AbortController();
      compactCommandRef.current = controller;
      try {
        return await client.executeCommand(invocation, {
          signal: controller.signal,
        });
      } finally {
        if (compactCommandRef.current === controller)
          compactCommandRef.current = null;
      }
    },
    [client, runExportCommand, runSessionAction],
  );
  const footerModel = useFooterModel(
    client,
    activeSessionId,
    subscribeEvents,
    pendingModelEntryId,
  );
  useEffect(() => {
    // A removed draft choice now resolves to the default. Submitting its old
    // explicit id would fail admission even though the footer shows the fallback.
    if (
      activeSessionId === null &&
      pendingModelEntryId &&
      footerModel?.source === "default"
    ) {
      setPendingModelEntryId(null);
      setPendingReasoning(null);
    }
  }, [activeSessionId, pendingModelEntryId, footerModel]);
  const activeSession = useTuiStoreSelector(store, (state) =>
    state.sessions.find((session) => session.id === state.activeSessionId),
  );
  useEffect(() => {
    if (activeSessionId === null) return;
    setPendingReasoning(null);
    setPendingModelEntryId(null);
  }, [activeSessionId]);
  const toolsExpanded =
    toolView.sessionId === activeSessionId && toolView.expanded;
  const exitTranscriptRef = useRef({ onExitTranscript, toolsExpanded });
  exitTranscriptRef.current = { onExitTranscript, toolsExpanded };
  useEffect(() => {
    setToolView((view) => ({
      sessionId: activeSessionId,
      expanded:
        view.sessionId === null && activeSessionId !== null
          ? view.expanded
          : false,
    }));
  }, [activeSessionId]);
  const activeContextWindowUsage = useTuiStoreSelector(
    store,
    selectActiveContextWindowUsage,
  );
  const activeGoal = useTuiStoreSelector(store, selectActiveGoal);
  const subagents = useMemo(
    () => createSubagentReader(client, activeSessionId ?? ""),
    [client, activeSessionId],
  );
  const [subagentBrowserOpen, setSubagentBrowserOpen] = useState(false);
  const subagentState = useSubagentState(subagents, subagentBrowserOpen);
  useEffect(() => {
    setSubagentBrowserOpen(false);
    if (!activeSessionId) return;
    void subagents.refresh();
    const timer = setInterval(() => {
      void subagents.refresh();
    }, 1000);
    return () => {
      clearInterval(timer);
      subagents.dispose();
    };
  }, [subagents, activeSessionId]);
  const activeTodoList = useTuiStoreSelector(store, selectActiveRawTodoList);
  const catalog = useTuiStoreSelector(store, (state) => state.catalog);
  const interactions = useTuiStoreSelector(
    store,
    (state) => state.interactions,
  );
  const permission = useTuiStoreSelector(store, (state) => state.permission);
  const pendingPermissions = useTuiStoreSelector(
    store,
    (state) => state.permissions,
  );
  const permissionSync = usePermissionSync(client, store, activeSessionId);
  const permissions = pendingPermissions.filter(
    (request) => request.rootSessionId === activeSessionId,
  );
  const prompts = useTuiStoreSelector(store, (state) => state.prompts);
  const runs = useTuiStoreSelector(store, (state) => state.runs);
  const latestPrompt = prompts
    .filter((prompt) => prompt.sessionId === activeSessionId)
    .reduce<
      (typeof prompts)[number] | null
    >((current, prompt) => (current === null || compareUiPromptQueueOrder(prompt, current) >= 0 ? prompt : current), null);
  const latestRun = runs
    .filter((run) => run.sessionId === activeSessionId)
    .reduce<
      (typeof runs)[number] | null
    >((current, run) => (current === null || run.startedAt > current.startedAt ? run : current), null);
  const queuedPrompts = useMemo(
    () =>
      prompts
        .filter(
          (prompt) =>
            prompt.sessionId === activeSessionId &&
            (prompt.status === "queued" || prompt.status === "retained"),
        )
        .sort(compareUiPromptQueueOrder),
    [activeSessionId, prompts],
  );
  const runtime = useTuiStoreSelector(store, (state) => state.runtime);
  const hasBackendDialog = permissions.length > 0 || interactions.length > 0;
  const hasDialog = hasBackendDialog || commandPanel !== null || rewindOpen;
  const rewindPrompts = useMemo(
    () => rewindablePrompts(prompts, activeSessionId),
    [prompts, activeSessionId],
  );
  const contextWindowUsageLabel = formatFooterContextUsage(
    activeContextWindowUsage,
  );
  const [escInterruptArmedRunId, setEscInterruptArmedRunId] = useState<
    string | null
  >(null);
  const [todoChoices, setTodoChoices] = useState<Record<string, boolean>>({});
  const todoBindings = useRef(
    new Map<string, { runId: string; stopped: boolean }>(),
  );
  const escInterruptArmedRunIdRef = useRef<string | null>(null);
  const escInterruptTimerRef = useRef<{
    readonly runId: string;
    readonly timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const disarmEscInterrupt = useCallback((runId?: string): void => {
    if (runId !== undefined && escInterruptArmedRunIdRef.current !== runId) {
      return;
    }
    if (
      escInterruptTimerRef.current !== null &&
      (runId === undefined || escInterruptTimerRef.current.runId === runId)
    ) {
      clearTimeout(escInterruptTimerRef.current.timer);
      escInterruptTimerRef.current = null;
    }
    escInterruptArmedRunIdRef.current = null;
    setEscInterruptArmedRunId((current) =>
      runId !== undefined && current !== runId ? current : null,
    );
  }, []);
  const armEscInterrupt = useCallback((runId: string): void => {
    if (escInterruptTimerRef.current !== null) {
      clearTimeout(escInterruptTimerRef.current.timer);
    }
    escInterruptArmedRunIdRef.current = runId;
    setEscInterruptArmedRunId(runId);
    escInterruptTimerRef.current = {
      runId,
      timer: setTimeout(() => {
        if (escInterruptTimerRef.current?.runId === runId) {
          escInterruptTimerRef.current = null;
        }
        if (escInterruptArmedRunIdRef.current === runId) {
          escInterruptArmedRunIdRef.current = null;
        }
        setEscInterruptArmedRunId((current) =>
          current === runId ? null : current,
        );
      }, ESC_INTERRUPT_WINDOW_MS),
    };
  }, []);
  useEffect(() => {
    if (escInterruptArmedRunId === null) {
      return;
    }
    if (
      permissions.length > 0 ||
      recoveryState.control?.runId !== escInterruptArmedRunId
    ) {
      disarmEscInterrupt(escInterruptArmedRunId);
    }
  }, [
    disarmEscInterrupt,
    escInterruptArmedRunId,
    permissions.length,
    recoveryState.control,
  ]);
  const todoScope = `${recoveryState.runtimeEpoch ?? "unknown"}:${activeSessionId ?? "none"}`;
  const trustedView =
    recoveryState.sync.status === "ready" &&
    recoveryState.sync.view?.version.sessionId === activeSessionId &&
    recoveryState.sync.view.version.runtimeEpoch === recoveryState.runtimeEpoch
      ? recoveryState.sync.view
      : undefined;
  const boundRun = trustedView?.runs
    .filter((run) => run.sessionId === activeSessionId)
    .reduce<
      (typeof runs)[number] | undefined
    >((current, run) => (!current || run.startedAt > current.startedAt ? run : current), undefined);
  const controlAgrees =
    recoveryState.control === null ||
    recoveryState.control.runId === null ||
    recoveryState.control.runId === boundRun?.id;
  let currentTodoBinding = todoBindings.current.get(todoScope);
  if (
    boundRun &&
    controlAgrees &&
    (boundRun.endedAt !== undefined ||
      boundRun.terminalReason !== undefined ||
      boundRun.status.kind === "running" ||
      boundRun.status.kind === "waiting-for-permission")
  ) {
    currentTodoBinding = {
      runId: boundRun.id,
      stopped:
        boundRun.endedAt !== undefined || boundRun.terminalReason !== undefined,
    };
  }
  if (
    !boundRun &&
    trustedView &&
    recoveryState.control?.rootSessionId === activeSessionId &&
    recoveryState.control.runtimeEpoch === recoveryState.runtimeEpoch &&
    recoveryState.control.runId === null
  ) {
    currentTodoBinding = { runId: "idle", stopped: true };
  }
  const todoBinding = currentTodoBinding;
  useEffect(() => {
    if (todoBinding) todoBindings.current.set(todoScope, todoBinding);
  }, [todoScope, todoBinding]);
  const todoIdentity = todoBinding
    ? `${todoScope}:${todoBinding.runId}:${todoBinding.stopped ? "stopped" : "active"}`
    : null;
  const todoShown =
    todoIdentity !== null &&
    (todoChoices[todoIdentity] ?? !todoBinding?.stopped);
  const todoExpanded = todoBinding?.stopped
    ? todoShown
    : todoIdentity !== null && (todoChoices[todoIdentity] ?? false);
  const presentedTodos =
    activeTodoList &&
    todoIdentity !== null &&
    (todoBinding?.stopped ? todoShown : activeTodoList.visible)
      ? { ...activeTodoList, visible: true }
      : null;
  useEffect(
    () => (): void => {
      if (escInterruptTimerRef.current !== null) {
        clearTimeout(escInterruptTimerRef.current.timer);
        escInterruptTimerRef.current = null;
      }
      escInterruptArmedRunIdRef.current = null;
    },
    [],
  );
  const effectiveRuntime = resolveEffectiveRuntime(permissions, runtime);
  const executionRecovery =
    (recoveryState.sync.status === "ready" &&
    recoveryState.sync.view?.version.sessionId === activeSessionId &&
    recoveryState.sync.view.version.runtimeEpoch === recoveryState.runtimeEpoch
      ? recoveryState.sync.view.executionRecovery
      : undefined) ??
    (recoveryState.control?.rootSessionId === activeSessionId &&
    recoveryState.control.runtimeEpoch === recoveryState.runtimeEpoch
      ? recoveryState.control.executionRecovery
      : undefined);
  const executionRecoveryLabel =
    executionRecovery?.status === "recovering"
      ? "Checking execution records…"
      : executionRecovery?.status === "blocked"
        ? executionRecovery.message
        : undefined;
  const runtimeStatusLabel =
    recoveryState.control?.runId &&
    escInterruptArmedRunId === recoveryState.control.runId
      ? ESC_INTERRUPT_HINT
      : effectiveRuntime.kind === "error"
        ? formatRuntimeLabel(permissions, runtime)
        : runtime.kind === "idle" &&
            !(
              recoveryState.control?.rootSessionId === activeSessionId &&
              recoveryState.control.sessionId === activeSessionId &&
              recoveryState.control.runtimeEpoch ===
                recoveryState.runtimeEpoch &&
              recoveryState.control.runId === null &&
              latestRun?.status.kind === "idle" &&
              latestRun.id !== latestPrompt?.runId &&
              latestPrompt !== null &&
              Date.parse(latestRun.startedAt) >=
                Date.parse(latestPrompt.acceptedAt ?? latestPrompt.createdAt)
            ) &&
            (latestPrompt?.status === "failed" ||
              latestPrompt?.status === "interrupted")
          ? `error: ${formatError(latestPrompt.error)}`
          : undefined;
  const setActiveCommandPanel = useCallback(
    (panel: CommandPanelState | null): void => {
      commandPanelRef.current = panel;
      setCommandPanel(panel);
    },
    [],
  );

  useEffect(() => {
    const emitNotice = (input: {
      readonly message: string;
      readonly source: string;
      readonly title: string;
    }): void => {
      diagnosticsNoticeSequenceRef.current += 1;
      store.dispatch({
        notice: {
          createdAt: new Date().toISOString(),
          id: `diagnostics_notice_${String(diagnosticsNoticeSequenceRef.current)}`,
          level: "warning",
          ...input,
        },
        type: "notice.emitted",
      });
    };
    for (const notice of initialNotices) {
      emitNotice({
        message: notice,
        source: "startup",
        title: "Startup warning",
      });
    }
    return subscribeDiagnosticsUnavailable?.(() => {
      emitNotice({
        message:
          "File logging became unavailable; this session is continuing without it.",
        source: "diagnostics",
        title: "Diagnostics unavailable",
      });
    });
  }, [initialNotices, store, subscribeDiagnosticsUnavailable]);
  const resetTranscriptSurface = useCallback(
    (
      _reason: TranscriptSurfaceResetReason,
      invalidateSubmission = true,
    ): void => {
      if (invalidateSubmission) {
        submissionGenerationRef.current += 1;
        setSubmissionContextGeneration(submissionGenerationRef.current);
      }
      if (!fullscreen) writeStdout(SESSION_VIEW_CLEAR_SEQUENCE);
      setScreenGeneration((current) => current + 1);
      setActiveCommandPanel(null);
    },
    [fullscreen, setActiveCommandPanel, writeStdout],
  );
  useEffect(() => {
    if (
      submissionEpochRef.current !== undefined &&
      recoveryState.runtimeEpoch !== undefined &&
      submissionEpochRef.current !== recoveryState.runtimeEpoch
    ) {
      submissionGenerationRef.current += 1;
      setSubmissionContextGeneration(submissionGenerationRef.current);
    }
    submissionEpochRef.current = recoveryState.runtimeEpoch;
  }, [recoveryState.runtimeEpoch]);
  const submitPrompt = useCallback(
    (
      text: string,
      reasoning?: PendingReasoningSelection["reasoning"],
      source?: { sessionId: string | null; creationGeneration: number },
      modelEntryId?: string,
    ) => {
      if (!recoveryRef.current)
        return Promise.reject(new Error("Session recovery unavailable"));
      if (
        source &&
        (source.creationGeneration !== submissionGenerationRef.current ||
          (source.sessionId !== null &&
            source.sessionId !== activeSessionIdRef.current))
      )
        return Promise.reject(
          new Error("Submission cancelled because the session changed"),
        );
      return recoveryRef.current.submit(text, reasoning, modelEntryId);
    },
    [],
  );
  const closeSubagentBrowser = useCallback((): void => {
    subagents.select();
    // The browser unmounts Static history. Re-entering the root must replace
    // that terminal projection before the newly mounted Static prints it.
    if (!fullscreen) writeStdout(SESSION_VIEW_CLEAR_SEQUENCE);
    setSubagentBrowserOpen(false);
  }, [fullscreen, subagents, writeStdout]);
  const closeCommandPanel = useCallback((): void => {
    setActiveCommandPanel(null);
  }, [setActiveCommandPanel]);
  const openCommandPanel = useCallback(
    (input: {
      readonly invocation: UiCommandInvocation;
      readonly kind: CommandPanelKind;
    }): void => {
      const interactiveKind = interactivePanelKindForCommandId(input.kind);
      if (interactiveKind !== null) {
        setActiveCommandPanel({
          kind: interactiveKind,
          mode: "interactive",
          openedAt: Date.now(),
          sessionId: activeSessionId,
        });
        return;
      }
      const displayKind = displayPanelKindForCommandId(input.kind);
      if (displayKind === null) {
        return;
      }

      pendingDisplayCommandInvocationsRef.current.set(
        input.invocation.clientInvocationId,
        {
          sessionId: activeSessionId,
        },
      );
      setActiveCommandPanel({
        clientInvocationId: input.invocation.clientInvocationId,
        kind: displayKind,
        mode: "display",
        openedAt: Date.now(),
        sessionId: activeSessionId,
        status: "loading",
      });
    },
    [activeSessionId, setActiveCommandPanel],
  );
  const refreshOpenModels = useCallback((): void => {
    const panel = commandPanelRef.current;
    const catalog = store.getState().catalog;
    if (panel?.mode !== "display" || panel.kind !== "models" || !catalog)
      return;
    const result = resolveCommand(parseSlashInput("/models"), catalog, {
      surface: "tui",
      sessionId: panel.sessionId ?? undefined,
    });
    if (result.kind !== "resolved") return;
    const { invocation } = result;
    const { clientInvocationId } = invocation;
    pendingDisplayCommandInvocationsRef.current.set(clientInvocationId, {
      sessionId: panel.sessionId,
    });
    // Keep the current rows visible until the newest invocation returns.
    setActiveCommandPanel({ ...panel, clientInvocationId });
    void client.executeCommand(invocation).catch((error: unknown) => {
      pendingDisplayCommandInvocationsRef.current.delete(clientInvocationId);
      const current = commandPanelRef.current;
      if (
        current?.mode === "display" &&
        current.clientInvocationId === clientInvocationId
      ) {
        setActiveCommandPanel({
          ...current,
          status: "error",
          error: sanitizeCommandPanelError(formatError(error)),
        });
      }
    });
  }, [client, setActiveCommandPanel, store]);
  const consumeCommandPanelEvent = useCallback(
    (tuiEvent: UiEvent): boolean => {
      if (
        tuiEvent.type === "command.started" &&
        displayPanelKindForCommandId(tuiEvent.command.commandId) !== null
      ) {
        return pendingDisplayCommandInvocationsRef.current.has(
          tuiEvent.command.clientInvocationId,
        );
      }

      if (
        tuiEvent.type !== "command.result.delivered" &&
        tuiEvent.type !== "command.failed"
      ) {
        return false;
      }

      const pendingDisplayCommand =
        pendingDisplayCommandInvocationsRef.current.get(
          tuiEvent.clientInvocationId,
        );
      if (pendingDisplayCommand === undefined) {
        return false;
      }
      pendingDisplayCommandInvocationsRef.current.delete(
        tuiEvent.clientInvocationId,
      );

      if (
        pendingDisplayCommand.sessionId !== store.getState().activeSessionId
      ) {
        return true;
      }

      const panel = commandPanelRef.current;
      if (panel === null) {
        return true;
      }
      if (panel.mode !== "display") {
        return true;
      }
      if (
        panel.clientInvocationId !== tuiEvent.clientInvocationId ||
        panel.sessionId !== pendingDisplayCommand.sessionId
      ) {
        return true;
      }

      if (tuiEvent.type === "command.result.delivered") {
        setActiveCommandPanel({
          ...panel,
          output:
            tuiEvent.output === undefined
              ? undefined
              : sanitizeCommandPanelOutput(tuiEvent.output),
          status: "ready",
        });
        return true;
      }

      setActiveCommandPanel({
        ...panel,
        error: sanitizeCommandPanelError(formatError(tuiEvent.error)),
        status: "error",
      });
      return true;
    },
    [setActiveCommandPanel],
  );

  useInput(
    (value, key) => {
      if (
        compactCommandRef.current &&
        (key.escape || value === "\u0003" || (key.ctrl && value === "c"))
      ) {
        compactCommandRef.current.abort();
        return;
      }
      // The side chat and the rewind list own the keyboard while open.
      if (sideChat !== null || rewindOpen) return;
      if (
        (!hasDialog || subagentBrowserOpen) &&
        key.ctrl &&
        value === "g" &&
        client.listSubagentExecutions
      ) {
        if (subagentBrowserOpen) closeSubagentBrowser();
        else setSubagentBrowserOpen(true);
        return;
      }
      if (subagentBrowserOpen) return;
      if (commandPanelRef.current !== null) {
        return;
      }

      if (
        !hasDialog &&
        !queueInputMode &&
        key.ctrl &&
        (value === "o" || value === "\u000f")
      ) {
        setToolView((view) => ({
          sessionId: activeSessionId,
          expanded: !(view.sessionId === activeSessionId && view.expanded),
        }));
        return;
      }

      if (
        !hasDialog &&
        activeTodoList !== null &&
        activeTodoList.todos.length > 0 &&
        !queueInputMode &&
        todoIdentity !== null &&
        key.ctrl &&
        (value === "t" || value === "\u0014")
      ) {
        setTodoChoices((choices) => ({
          ...choices,
          [todoIdentity]: !todoExpanded,
        }));
        return;
      }

      if (key.tab && key.shift && permissions.length === 0) {
        const command = nextPermissionModeCommand(
          permission,
          activeSessionId ?? undefined,
          () => {
            keyboardCommandSequenceRef.current += 1;
            return `tui_key_${String(keyboardCommandSequenceRef.current)}`;
          },
        );

        if (command !== null) {
          void client.executeCommand(command).catch((caught: unknown) => {
            store.dispatch({
              status: {
                kind: "error",
                message: formatError(caught),
                recoverable: true,
              },
              type: "runtime.updated",
            });
          });
        }
        return;
      }

      if (key.ctrl && value === "x") {
        recoveryRef.current?.discardPending(
          recoveryState.pending.map((item) => item.clientRequestId),
        );
        return;
      }
      if (key.escape) {
        if (queueInputMode) {
          disarmEscInterrupt();
          return;
        }
        const stopRunId = recoveryState.control?.runId;
        if (permissions.length > 0 || !stopRunId) {
          disarmEscInterrupt();
          return;
        }
        if (escInterruptArmedRunIdRef.current !== stopRunId) {
          armEscInterrupt(stopRunId);
          return;
        }
        disarmEscInterrupt(stopRunId);
        void recoveryRef.current?.stop(stopRunId).catch((caught: unknown) => {
          store.dispatch({
            status: {
              kind: "error",
              message: formatError(caught),
              recoverable: true,
            },
            type: "runtime.updated",
          });
        });
        return;
      }

      if (value !== "\u0003" && !(key.ctrl && value === "c")) {
        return;
      }

      if (
        permissions.length > 0 &&
        (recoveryState.control?.rootSessionId !==
          permissions[0].rootSessionId ||
          !recoveryState.control.runId)
      )
        return;

      // Unknown control is neither a confirmed idle session nor a Stop target.
      if (activeSessionId !== null && recoveryState.control === null) return;
      const stopRunId = recoveryState.control?.runId;
      if (stopRunId) {
        void recoveryRef.current?.stop(stopRunId).catch((caught: unknown) => {
          store.dispatch({
            status: {
              kind: "error",
              message: formatError(caught),
              recoverable: true,
            },
            type: "runtime.updated",
          });
        });
        return;
      }

      exit();
    },
    { isActive: interactions.length === 0 && commandPanel === null },
  );

  const loadCatalog = useCallback(async (): Promise<TuiCommandCatalog> => {
    const requestSequence = catalogRequestSequenceRef.current + 1;
    catalogRequestSequenceRef.current = requestSequence;

    try {
      const catalog = await client.listCommands({ surface: "tui" });

      if (
        !disposedRef.current &&
        requestSequence === catalogRequestSequenceRef.current
      ) {
        setCatalogError(null);
        store.setCatalog(catalog);
      }
      return catalog;
    } catch (caught) {
      if (!disposedRef.current) {
        setCatalogError(`error: ${formatError(caught)}`);
        store.dispatch({
          status: {
            kind: "error",
            message: formatError(caught),
            recoverable: true,
          },
          type: "runtime.updated",
        });
      }
      throw caught;
    }
  }, [client, store]);

  useEffect(() => {
    disposedRef.current = false;
    const eventDispatcher = createCoalescedTuiEventDispatcher((events) => {
      store.dispatchMany(events);
    });

    const pendingStorage = createPendingPromptStorage(pendingPromptWorkspace);
    let installedSessionId: string | undefined;
    const recovery = createTuiSessionRecovery({
      client,
      store,
      onChange: (state) => {
        if (state.sync.status === "ready" && state.sync.view) {
          const id = state.sync.view.session.id;
          if (installedSessionId !== undefined && installedSessionId !== id)
            resetTranscriptSurface("switch-session");
          installedSessionId = id;
        }
        setRecoveryState(state);
      },
      pending: pendingStorage.read(),
      savePending: (pending) => {
        pendingStorage.write(pending);
      },
      onHistory: () => {
        resetTranscriptSurface("switch-session", false);
      },
      onModelInvalidated: () => {
        refreshOpenModels();
        void loadCatalog().catch(() => undefined);
      },
    });
    recoveryRef.current = recovery;
    const unsubscribe = subscribeEvents((tuiEvent: UiEvent) => {
      if (consumeCommandPanelEvent(tuiEvent)) {
        return;
      }

      if (recovery.receive(tuiEvent)) return;
      const selectedExistingSessionId =
        selectedExistingSessionIdFromEvent(tuiEvent);
      if (selectedExistingSessionId !== undefined) {
        eventDispatcher.dispatch(tuiEvent);
        recovery.select(selectedExistingSessionId);
      } else {
        eventDispatcher.dispatch(tuiEvent);
        if (isNewSessionSelectionEvent(tuiEvent)) {
          installedSessionId = undefined;
          setToolView({ sessionId: null, expanded: false });
          resetTranscriptSurface("new-session");
          recovery.select(null);
        }
      }

      if (
        tuiEvent.type === "command.result.delivered" &&
        tuiEvent.action?.kind === "app.exit"
      ) {
        exit();
      }

      if (tuiEvent.type === "command.catalog.updated") {
        void loadCatalog().catch(() => undefined);
      }
    });

    void recovery.start();
    void loadCatalog().catch(() => undefined);

    return (): void => {
      disposedRef.current = true;
      recovery.dispose();
      recoveryRef.current = null;
      eventDispatcher.dispose();
      unsubscribe();
    };
  }, [
    client,
    consumeCommandPanelEvent,
    pendingPromptWorkspace,
    refreshOpenModels,
    exit,
    loadCatalog,
    resetTranscriptSurface,
    setActiveCommandPanel,
    store,
    subscribeEvents,
  ]);

  // Registered after the event subscription so its cleanup flushes pending
  // deltas before we take the final snapshot. No writes while alternate is active.
  useEffect(
    () => (): void => {
      const state = store.getState();
      const { onExitTranscript: capture, toolsExpanded: expanded } =
        exitTranscriptRef.current;
      capture?.({
        committedItems: state.committedItems,
        liveMessage: state.liveMessage,
        liveReasoning: selectLiveReasoning(state),
        toolsExpanded: expanded,
      });
    },
    [store],
  );

  useEffect(() => {
    const panel = commandPanelRef.current;
    if (panel !== null && panel.sessionId !== activeSessionId) {
      setActiveCommandPanel(null);
    }
  }, [activeSessionId, setActiveCommandPanel]);

  // A selected ID can arrive before its view. Wait for that initial install so
  // its empty context snapshot cannot overwrite a faster explicit usage query.
  // This scalar identity stays stable through ordinary text/model deltas.
  const contextReadySessionId =
    recoveryState.sync.status === "ready" &&
    recoveryState.sync.view?.version.sessionId === activeSessionId
      ? activeSessionId
      : null;
  useEffect(() => {
    const sessionId = contextReadySessionId;
    if (!sessionId) {
      return;
    }

    const requestSequence = contextRefreshSequenceRef.current + 1;
    contextRefreshSequenceRef.current = requestSequence;
    let cancelled = false;

    void client
      .getContextWindowUsage({ sessionId })
      .then((usage) => {
        if (
          cancelled ||
          disposedRef.current ||
          requestSequence !== contextRefreshSequenceRef.current ||
          !usage
        ) {
          return;
        }
        store.dispatch({
          type: "context.window.updated",
          usage,
        });
      })
      .catch((caught: unknown) => {
        if (
          cancelled ||
          disposedRef.current ||
          requestSequence !== contextRefreshSequenceRef.current
        ) {
          return;
        }

        contextNoticeSequenceRef.current += 1;
        store.dispatch({
          notice: {
            createdAt: new Date().toISOString(),
            id: `context_notice_${String(contextNoticeSequenceRef.current)}`,
            key: `context-window:${sessionId}`,
            level: "warning",
            message: `Context window usage could not be refreshed: ${formatError(
              caught,
            )}`,
            source: "context",
            title: "Context unavailable",
          },
          type: "notice.emitted",
        });
      });

    return (): void => {
      cancelled = true;
    };
  }, [contextReadySessionId, client, store]);

  return (
    <ThemeProvider>
      <AppShell
        priorityDock={hasDialog}
        fullscreen={fullscreen}
        identity={`${activeSessionId ?? "empty"}:${String(screenGeneration)}:${String(subagentBrowserOpen)}:${sideChat?.sideChatId ?? ""}`}
        scrollEnabled={!subagentBrowserOpen && sideChat === null}
        output={
          <>
            {permissions.length === 0 && sideChat === null ? (
              <HeaderContainer store={store} />
            ) : null}
            {sideChat !== null ? (
              <SideChatPanel
                key={sideChat.sideChatId}
                client={client}
                subscribeEvents={subscribeEvents}
                sideChatId={sideChat.sideChatId}
                boundaryMessageId={sideChat.boundaryMessageId}
                firstQuestion={sideChat.firstQuestion}
                mainNeedsApproval={permissions.length > 0}
                footer={{
                  model: footerModel,
                  workingDirectory: activeSession?.workingDirectory,
                }}
                onClose={closeSideChat}
              />
            ) : subagentBrowserOpen ? (
              <>
                {permissions.length > 0 ? (
                  <Text dimColor>
                    Approval pending · Ctrl+G close browser to review
                  </Text>
                ) : null}
                <SubagentBrowser
                  reader={subagents}
                  state={subagentState}
                  onClose={closeSubagentBrowser}
                />
              </>
            ) : (
              <>
                {permissions.length === 0 && client.listSubagentExecutions ? (
                  <Text dimColor>
                    Ctrl+G subagents ·{" "}
                    {subagentState.list?.executions.length ?? 0} executions
                  </Text>
                ) : null}
                {permissions.length === 0 ? (
                  <SubagentWait
                    state={subagentState}
                    run={recoveryState.sync.view?.runs.find(
                      (run) => run.id === recoveryState.control?.runId,
                    )}
                  />
                ) : null}
                <DurationDiagnosticContext.Provider
                  value={reportDurationClockAnomaly}
                >
                  <TranscriptViewportContainer
                    key={screenGeneration}
                    store={store}
                    toolsExpanded={toolsExpanded}
                    waitingForSubagents={subagentState.list?.waiting}
                  />
                </DurationDiagnosticContext.Provider>
              </>
            )}
          </>
        }
      >
        {!subagentBrowserOpen && sideChat === null ? (
          <>
            {rewindOpen && activeSessionId !== null ? (
              <RewindPanel
                prompts={rewindPrompts}
                active={permissions.length === 0 && interactions.length === 0}
                confirmation={(turns) =>
                  rewindConfirmation({
                    turns,
                    goal: activeGoal,
                    running: runtime.kind === "running",
                    queued: queuedPrompts.length,
                    hasDraft: promptDraftRef.current.trim() !== "",
                  })
                }
                onConfirm={async (prompt) => {
                  try {
                    const result = await client.rewindSession({
                      sessionId: activeSessionId,
                      promptId: prompt.promptId,
                    });
                    setRewindOpen(false);
                    // The original text comes back to the input to edit.
                    setPromptPrefill((current) => ({
                      nonce: (current?.nonce ?? 0) + 1,
                      text: result.restoredText,
                    }));
                    return null;
                  } catch (caught) {
                    return sessionActionErrorText("rewind", caught);
                  }
                }}
                onClose={() => {
                  setRewindOpen(false);
                }}
              />
            ) : null}
            <DialogManager
              client={client}
              interactions={interactions}
              permissions={permissions}
              permissionSync={permissionSync.state}
              onRetryPermissions={permissionSync.retry}
              approvalRetryHint={
                recoveryState.error
                  ? undefined
                  : recoveryState.connected === false
                    ? "Reconnecting…"
                    : recoveryState.pending.length > 0
                      ? recoveryState.pending.some(
                          (item) =>
                            item.runtimeEpoch !== undefined &&
                            item.runtimeEpoch !== recoveryState.runtimeEpoch,
                        )
                        ? "Submission unconfirmed"
                        : "Confirming submission…"
                      : recoveryState.sync.status === "error"
                        ? "Syncing session…"
                        : undefined
              }
              approvalStatus={
                runtime.kind === "error"
                  ? formatError(runtime)
                  : recoveryState.error
              }
              controllableRun={Boolean(
                recoveryState.control?.runId &&
                recoveryState.control.rootSessionId === activeSessionId &&
                recoveryState.control.runtimeEpoch ===
                  recoveryState.runtimeEpoch,
              )}
            />
            <CommandPanelManager
              fullscreen={fullscreen}
              catalog={catalog}
              client={client}
              contextWindowUsage={activeContextWindowUsage}
              onClose={closeCommandPanel}
              onEffortSelect={async (reasoning) => {
                if (activeSessionId === null) {
                  const model = await client.getCurrentModel(
                    pendingModelEntryId === null
                      ? undefined
                      : { modelEntryId: pendingModelEntryId },
                  );
                  if (!model) throw new Error("No model is connected");
                  setPendingReasoning({ reasoning, model });
                } else {
                  await client.updateSessionReasoning({
                    sessionId: activeSessionId,
                    reasoning,
                  });
                }
              }}
              pendingReasoning={pendingReasoning?.reasoning ?? null}
              pendingModelEntryId={pendingModelEntryId}
              onDraftModelSelect={(entryId) => {
                // A /effort choice belongs to the model it was made for.
                if (pendingReasoning && pendingReasoning.model.id !== entryId)
                  setPendingReasoning(null);
                setPendingModelEntryId(entryId);
              }}
              sessionReasoning={recoveryState.sync.view?.session.reasoning}
              panel={hasBackendDialog ? null : commandPanel}
              runtime={runtime}
            />
            <Box display={hasDialog ? "none" : "flex"} flexDirection="column">
              <TodoPanel
                expanded={todoExpanded}
                inputEnabled={!hasDialog && !queueInputMode}
                todoList={presentedTodos}
                stopped={todoBinding?.stopped}
              />
            </Box>
            {permissions.length === 0 ? (
              <CatalogInvalidation store={store} />
            ) : null}
          </>
        ) : null}
        <Box
          display={subagentBrowserOpen || sideChat !== null ? "none" : "flex"}
          flexDirection="column"
        >
          <Prompt
            prefill={promptPrefill}
            draftRef={promptDraftRef}
            footerOnly={hasDialog}
            onQueueModeChange={setQueueInputMode}
            activeSessionId={activeSessionId}
            activeRunId={recoveryState.control?.runId ?? undefined}
            pendingReasoning={pendingReasoning}
            pendingModelEntryId={pendingModelEntryId}
            catalog={catalog}
            client={client}
            disabled={hasDialog || subagentBrowserOpen || sideChat !== null}
            executeCommand={executePromptCommand}
            canSubmit={
              executionRecovery?.status !== "recovering" &&
              recoveryState.initialized &&
              recoveryState.runtimeEpoch !== undefined &&
              !recoveryState.pending.some((item) =>
                pendingPromptBlocks(
                  item,
                  activeSessionId,
                  recoveryState.runtimeEpoch,
                ),
              ) &&
              !recoveryState.error?.includes("SESSION_RECOVERY_UNSUPPORTED") &&
              (activeSessionId === null ||
                recoveryState.sync.status === "ready")
            }
            onLoadHistory={() => {
              void recoveryRef.current?.loadHistory();
            }}
            submitPrompt={submitPrompt}
            submissionContextGeneration={submissionContextGeneration}
            goal={activeGoal ?? undefined}
            isRuntimeRunning={runtime.kind === "running"}
            loadCatalog={loadCatalog}
            onCommandPanelOpen={openCommandPanel}
            permission={permission}
            workingDirectory={activeSession?.workingDirectory}
            model={footerModel}
            reasoning={activeSession?.reasoning}
            queuedPrompts={queuedPrompts}
            unconsumedSteers={getUnconsumedSteers(activeSession)}
            contextWindowUsage={contextWindowUsageLabel}
            runtimeStatusLabel={
              escInterruptArmedRunId !== null
                ? ESC_INTERRUPT_HINT
                : (catalogError ??
                  recoveryState.error ??
                  executionRecoveryLabel ??
                  (recoveryState.connected === false
                    ? `Reconnecting…${recoveryState.sync.error ? ` ${recoveryState.sync.error}` : ""}`
                    : recoveryState.sync.status === "error"
                      ? `Syncing session… ${recoveryState.sync.error ?? ""}`
                      : !recoveryState.initialized ||
                          recoveryState.runtimeEpoch === undefined ||
                          recoveryState.sync.status === "syncing"
                        ? "Syncing session…"
                        : recoveryState.pending.length > 0
                          ? recoveryState.pending.some(
                              (item) =>
                                item.runtimeEpoch !== undefined &&
                                item.runtimeEpoch !==
                                  recoveryState.runtimeEpoch,
                            )
                            ? "Submission unconfirmed · Ctrl+X forget all (may still run)"
                            : "Confirming submission… · Ctrl+X forget all (may still run)"
                          : runtimeStatusLabel))
            }
          />
        </Box>
      </AppShell>
    </ThemeProvider>
  );
}

function HeaderContainer({
  store,
}: {
  readonly store: TuiStore;
}): ReactElement {
  const isEmpty = useTuiStoreSelector(
    store,
    (state) => state.activeSessionId === null && state.messages.length === 0,
  );

  return <Header isEmpty={isEmpty} />;
}

function TranscriptViewportContainer({
  store,
  toolsExpanded,
  waitingForSubagents,
}: {
  readonly store: TuiStore;
  readonly waitingForSubagents?: boolean;
  readonly toolsExpanded?: boolean;
}): ReactElement {
  const activeSessionId = useTuiStoreSelector(
    store,
    (state) => state.activeSessionId,
  );
  const commandNotices = useTuiStoreSelector(
    store,
    (state) => state.commandNotices,
  );
  const activeSession = useTuiStoreSelector(store, (state) =>
    state.sessions.find((session) => session.id === state.activeSessionId),
  );
  const committedItems = useTuiStoreSelector(store, selectCommittedItems);
  const liveMessage = useTuiStoreSelector(store, selectLiveMessage);
  const liveReasoning = useTuiStoreSelector(store, selectLiveReasoning);
  const notices = useTuiStoreSelector(store, (state) => state.notices);
  const runtime = useTuiStoreSelector(store, (state) => state.runtime);

  const sample = useTuiStoreSelector(store, (state) => state.durationSample);
  const modelActivity = useTuiStoreSelector(
    store,
    (state) =>
      state.runs.find(
        (run) =>
          run.sessionId === state.activeSessionId &&
          state.runtime.kind === "running" &&
          run.id === state.runtime.runId,
      )?.modelActivity,
  );
  return (
    <DurationSampleContext.Provider value={sample}>
      <TranscriptViewport
        key={activeSessionId ?? "none"}
        commandNotices={commandNotices}
        unconsumedSteers={getUnconsumedSteers(activeSession)}
        committedItems={committedItems}
        toolsExpanded={toolsExpanded}
        liveMessage={liveMessage}
        liveReasoning={liveReasoning}
        notices={notices}
        runtime={runtime}
        modelActivity={waitingForSubagents ? undefined : modelActivity}
      />
    </DurationSampleContext.Provider>
  );
}

function CatalogInvalidation({
  store,
}: {
  readonly store: TuiStore;
}): ReactElement | null {
  const catalogInvalidation = useTuiStoreSelector(
    store,
    (state) => state.catalogInvalidation,
  );

  return catalogInvalidation === null ? null : (
    <Text dimColor>
      command catalog refresh: {catalogInvalidation.version ?? "new"}
    </Text>
  );
}

function createEmptySnapshot(): UiSnapshot {
  return {
    activeSessionId: null,
    permission: {
      level: "default",
      mode: "auto",
      sessionRules: [],
    },
    permissions: [],
    runs: [],
    sessions: [],
    status: { kind: "idle" },
  };
}

function isNewSessionSelectionEvent(tuiEvent: UiEvent): boolean {
  if (
    tuiEvent.type !== "command.result.delivered" ||
    tuiEvent.action?.kind !== "session.selected"
  ) {
    return false;
  }
  const data = tuiEvent.action.data;
  return isStringRecord(data) && data.source === "new";
}

function selectedExistingSessionIdFromEvent(
  tuiEvent: UiEvent,
): string | undefined {
  if (
    tuiEvent.type !== "command.result.delivered" ||
    tuiEvent.action?.kind !== "session.selected"
  ) {
    return undefined;
  }
  const data = tuiEvent.action.data;
  if (!isStringRecord(data) || data.source === "new") {
    return undefined;
  }
  const choiceId = data.choiceId;
  return typeof choiceId === "string" && choiceId.length > 0
    ? choiceId
    : undefined;
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeCommandPanelOutput(output: UiCommandOutput): UiCommandOutput {
  if (output.kind !== "data") {
    return output;
  }

  switch (output.subject) {
    case "models.current":
      return {
        ...output,
        data: {
          current: sanitizePublicModelRecord(
            getRecordValue(output.data, "current"),
          ),
          models: sanitizePublicModelList(output.data.models),
        },
      };
    case "status":
      return {
        ...output,
        data: sanitizeStatusPanelData(output.data),
      };
    default:
      return output;
  }
}

function sanitizeCommandPanelError(message: string): string {
  return message
    .replace(/https?:\/\/[^\s)]*/giu, "[redacted-url]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [redacted]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|auth[_-]?token|token)=)[^&\s)]+/giu,
      "$1[redacted]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "sk-[redacted]")
    .replace(
      /\b[A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\b/gu,
      "[redacted-env]",
    );
}

function sanitizeStatusPanelData(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of [
    "context",
    "contextWindow",
    "diagnosticsFilePath",
    "mcps",
    "permission",
    "promptCacheUsage",
    "projectRoot",
    "sessionId",
    "skillsCount",
    "status",
    "tools",
  ]) {
    const value = data[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  result.model = sanitizePublicModelRecord(getRecordValue(data, "model"));
  result.models = sanitizePublicModelList(data.models);
  return result;
}

function sanitizePublicModelList(
  value: unknown,
): readonly Record<string, unknown>[] {
  return Array.isArray(value)
    ? value
        .map((item) =>
          isStringRecord(item) ? sanitizePublicModelRecord(item) : undefined,
        )
        .filter((item): item is Record<string, unknown> => item !== undefined)
    : [];
}

function sanitizePublicModelRecord(
  record: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!record) {
    return undefined;
  }

  const result: Record<string, unknown> = {};
  for (const key of ["id", "label", "provider", "model", "interfaceProvider"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      result[key] = value;
    }
  }
  if (typeof record.active === "boolean") {
    result.active = record.active;
  }
  if (typeof record.default === "boolean") {
    result.default = record.default;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function getRecordValue(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return isStringRecord(value) ? value : undefined;
}

function resolveEffectiveRuntime(
  permissions: UiSnapshot["permissions"],
  runtime: TuiRuntimeStatus,
): TuiRuntimeStatus {
  if (permissions.length > 0) {
    return {
      kind: "waiting-for-permission",
      requestId: permissions[0].id,
    };
  }
  return runtime;
}

function formatRuntimeLabel(
  permissions: UiSnapshot["permissions"],
  runtime: TuiRuntimeStatus,
): string {
  const effectiveRuntime = resolveEffectiveRuntime(permissions, runtime);

  switch (effectiveRuntime.kind) {
    case "idle":
      return "idle";
    case "running":
      return effectiveRuntime.title
        ? `running: ${trimLabel(effectiveRuntime.title)}`
        : "running";
    case "waiting-for-permission":
      return formatPermissionWaitLabel(permissions);
    case "error":
      return `error: ${formatError(effectiveRuntime)}`;
  }
}

function formatPermissionWaitLabel(
  permissions: UiSnapshot["permissions"],
): string {
  const request = permissions.at(0);
  const title =
    request?.title === undefined || request.title.trim() === ""
      ? "permission"
      : trimLabel(request.title);

  return permissions.length > 1
    ? `waiting: ${title} (+${String(permissions.length - 1)})`
    : `waiting: ${title}`;
}

function trimLabel(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const maxLength = 48;

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function nextPermissionModeCommand(
  permission: UiSnapshot["permission"],
  sessionId: string | undefined,
  createInvocationId: () => string,
): UiCommandInvocation | null {
  if (permission === undefined) {
    return null;
  }

  const path = ["permission", "toggle-mode"] as const;

  return {
    argv: [],
    clientInvocationId: createInvocationId(),
    commandId: "permission.toggle-mode",
    path,
    raw: "<shift-tab>",
    rawArgs: "",
    sessionId,
    surface: "tui",
  };
}
