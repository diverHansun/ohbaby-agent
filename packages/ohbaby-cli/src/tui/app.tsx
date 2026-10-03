import {
  compareUiPromptQueueOrder,
  hasUnsentSteerAfterLatestStop,
} from "ohbaby-sdk";
import { createSubagentReader } from "ohbaby-sdk";
import {
  SubagentBrowser,
  SubagentWait,
} from "./components/subagent-browser.js";
import {
  DurationSampleContext,
  DurationDiagnosticContext,
} from "./components/execution-duration.js";
import { Box, Text, useApp, useInput, useStdout, useWindowSize } from "ink";
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
import { COMPACT_TODO_LIMIT, TodoPanel } from "./components/todo-panel.js";
import { AppShell } from "./layout/app-shell.js";
import { formatFooterContextUsage } from "./render/usage.js";
import { useFooterModel } from "./use-footer-model.js";
import { useSubagentState } from "./use-subagent-state.js";
import { createTuiStore } from "./store/events.js";
import {
  selectActiveGoal,
  selectActiveTodoList,
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
  readonly reportDurationClockAnomaly?: (identity: string) => void;
  readonly pendingPromptWorkspace?: string;
  readonly clearOnStart?: boolean;
  readonly client: CoreAPI;
  readonly initialNotices?: readonly string[];
  readonly subscribeEvents: (handler: UiEventHandler) => UiUnsubscribe;
  readonly subscribeDiagnosticsUnavailable?: (
    listener: () => void,
  ) => () => void;
}

export function OhbabyTerminalApp({
  clearOnStart = false,
  pendingPromptWorkspace,
  client,
  initialNotices = EMPTY_INITIAL_NOTICES,
  subscribeEvents,
  subscribeDiagnosticsUnavailable,
  reportDurationClockAnomaly,
}: TerminalUiOptions): ReactElement {
  const storeRef = useRef<TuiStore>(createTuiStore(createEmptySnapshot()));
  const keyboardCommandSequenceRef = useRef(0);
  const [queueInputMode, setQueueInputMode] = useState(false);
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
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [pendingReasoning, setPendingReasoning] =
    useState<PendingReasoningSelection | null>(null);
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
  const terminalSize = useWindowSize();
  const { write: writeStdout } = useStdout();
  if (clearOnStart && !didClearOnStartRef.current) {
    writeStdout(NEW_SESSION_CLEAR_SEQUENCE);
    didClearOnStartRef.current = true;
  }
  const activeSessionId = useTuiStoreSelector(
    store,
    (state) => state.activeSessionId,
  );
  activeSessionIdRef.current = activeSessionId;
  const footerModel = useFooterModel(client, activeSessionId, subscribeEvents);
  const activeSession = useTuiStoreSelector(store, (state) =>
    state.sessions.find((session) => session.id === state.activeSessionId),
  );
  useEffect(() => {
    if (activeSessionId !== null) setPendingReasoning(null);
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
  const activeTodoList = useTuiStoreSelector(store, selectActiveTodoList);
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
  const hasDialog = hasBackendDialog || commandPanel !== null;
  const contextWindowUsageLabel = formatFooterContextUsage(
    activeContextWindowUsage,
  );
  const [escInterruptArmedRunId, setEscInterruptArmedRunId] = useState<
    string | null
  >(null);
  const [todoExpanded, setTodoExpanded] = useState(false);
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
  const todoRunId =
    runtime.kind === "running"
      ? runtime.runId
      : runtime.kind === "waiting-for-permission"
        ? (permissions.find((request) => request.id === runtime.requestId)
            ?.runId ?? null)
        : null;
  useEffect(() => {
    setTodoExpanded(false);
  }, [activeSessionId, activeTodoList === null, todoRunId]);
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
    (_reason: TranscriptSurfaceResetReason): void => {
      writeStdout(SESSION_VIEW_CLEAR_SEQUENCE);
      setScreenGeneration((current) => current + 1);
      setActiveCommandPanel(null);
    },
    [setActiveCommandPanel, writeStdout],
  );
  const closeSubagentBrowser = useCallback((): void => {
    subagents.select();
    // The browser unmounts Static history. Re-entering the root must replace
    // that terminal projection before the newly mounted Static prints it.
    writeStdout(SESSION_VIEW_CLEAR_SEQUENCE);
    setSubagentBrowserOpen(false);
  }, [subagents, writeStdout]);
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
      if (key.ctrl && value === "g" && client.listSubagentExecutions) {
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
        activeTodoList !== null &&
        activeTodoList.todos.length > COMPACT_TODO_LIMIT &&
        key.ctrl &&
        (value === "t" || value === "\u0014")
      ) {
        setTodoExpanded((expanded) => !expanded);
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

      if (key.ctrl && value === "r") {
        recoveryRef.current?.retry();
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
        resetTranscriptSurface("switch-session");
      },
      onModelInvalidated: () => {
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
    exit,
    loadCatalog,
    resetTranscriptSurface,
    setActiveCommandPanel,
    store,
    subscribeEvents,
  ]);

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
      <AppShell>
        <HeaderContainer store={store} />
        {subagentBrowserOpen ? (
          <SubagentBrowser
            reader={subagents}
            state={subagentState}
            onClose={closeSubagentBrowser}
          />
        ) : (
          <>
            {client.listSubagentExecutions ? (
              <Text dimColor>
                Ctrl+G subagents · {subagentState.list?.executions.length ?? 0}{" "}
                executions
              </Text>
            ) : null}
            <SubagentWait
              state={subagentState}
              run={recoveryState.sync.view?.runs.find(
                (run) => run.id === recoveryState.control?.runId,
              )}
            />
            <DurationDiagnosticContext.Provider
              value={reportDurationClockAnomaly}
            >
              <TranscriptViewportContainer
                key={screenGeneration}
                store={store}
                waitingForSubagents={subagentState.list?.waiting}
              />
            </DurationDiagnosticContext.Provider>
            <DialogManager
              client={client}
              interactions={interactions}
              permissions={permissions}
              permissionSync={permissionSync.state}
              onRetryPermissions={permissionSync.retry}
            />
            {permissions.length > 0 ? (
              <Text dimColor>
                {recoveryState.control?.rootSessionId ===
                  permissions[0].rootSessionId && recoveryState.control.runId
                  ? "Ctrl+C stop root run"
                  : "Stop target syncing · Ctrl+R retry"}
              </Text>
            ) : null}
            <CommandPanelManager
              catalog={catalog}
              client={client}
              contextWindowUsage={activeContextWindowUsage}
              onClose={closeCommandPanel}
              onEffortSelect={async (reasoning) => {
                if (activeSessionId === null) {
                  const model = await client.getCurrentModel();
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
              sessionReasoning={recoveryState.sync.view?.session.reasoning}
              panel={hasBackendDialog ? null : commandPanel}
              runtime={runtime}
            />
            <TodoPanel
              expanded={todoExpanded}
              inputEnabled={!hasDialog}
              todoList={activeTodoList}
              summaryOnly={hasDialog && terminalSize.rows <= 24}
            />
            <CatalogInvalidation store={store} />
          </>
        )}
        <Box
          display={subagentBrowserOpen ? "none" : "flex"}
          flexDirection="column"
        >
          <Prompt
            onQueueModeChange={setQueueInputMode}
            activeSessionId={activeSessionId}
            activeRunId={recoveryState.control?.runId ?? undefined}
            pendingReasoning={pendingReasoning}
            catalog={catalog}
            client={client}
            disabled={hasDialog || subagentBrowserOpen}
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
            submitPrompt={(text, reasoning) => {
              if (!recoveryRef.current)
                return Promise.reject(
                  new Error("Session recovery unavailable"),
                );
              return recoveryRef.current.submit(text, reasoning);
            }}
            goalStatus={activeGoal?.status}
            isRuntimeRunning={runtime.kind === "running"}
            loadCatalog={loadCatalog}
            onCommandPanelOpen={openCommandPanel}
            permission={permission}
            projectRoot={activeSession?.projectRoot}
            model={footerModel}
            reasoning={activeSession?.reasoning}
            queuedPrompts={queuedPrompts}
            unsentSteer={hasUnsentSteerAfterLatestStop(runs, activeSessionId)}
            contextWindowUsage={contextWindowUsageLabel}
            runtimeStatusLabel={
              escInterruptArmedRunId !== null
                ? ESC_INTERRUPT_HINT
                : (catalogError ??
                  recoveryState.error ??
                  executionRecoveryLabel ??
                  (recoveryState.sync.status === "error"
                    ? `Sync failed: ${recoveryState.sync.error ?? "unknown"} · Ctrl+R retry`
                    : !recoveryState.initialized ||
                        recoveryState.runtimeEpoch === undefined ||
                        recoveryState.sync.status === "syncing"
                      ? "Syncing session… draft kept"
                      : recoveryState.pending.length > 0
                        ? recoveryState.pending.some(
                            (item) =>
                              item.runtimeEpoch !== undefined &&
                              item.runtimeEpoch !== recoveryState.runtimeEpoch,
                          )
                          ? "Previous runtime submission unconfirmed · Ctrl+X forget all (may still run)"
                          : "Submission outcome unknown · Ctrl+R query · Ctrl+X forget all (may still run)"
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
  waitingForSubagents,
}: {
  readonly store: TuiStore;
  readonly waitingForSubagents?: boolean;
}): ReactElement {
  const activeSessionId = useTuiStoreSelector(
    store,
    (state) => state.activeSessionId,
  );
  const commandNotices = useTuiStoreSelector(
    store,
    (state) => state.commandNotices,
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
        committedItems={committedItems}
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
          switching: sanitizeSwitchingRecord(
            getRecordValue(output.data, "switching"),
          ),
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

  return Object.keys(result).length > 0 ? result : undefined;
}

function sanitizeSwitchingRecord(
  record: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!record) {
    return undefined;
  }

  const result: Record<string, unknown> = {};
  if (typeof record.available === "boolean") {
    result.available = record.available;
  }
  if (typeof record.mode === "string" && record.mode.trim() !== "") {
    result.mode = record.mode;
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
