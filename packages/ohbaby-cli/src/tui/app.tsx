import { Text, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type {
  CoreAPI,
  UiCommandInvocation,
  UiCommandOutput,
  UiEventHandler,
  UiSnapshot,
  UiUnsubscribe,
} from "ohbaby-sdk";
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
import { Prompt } from "./components/prompt/index.js";
import { AppShell } from "./layout/app-shell.js";
import { formatContextWindowUsage } from "./render/usage.js";
import { createTuiStore } from "./store/events.js";
import {
  selectActiveGoal,
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
  TuiEvent,
  TuiStore,
  TuiRuntimeStatus,
} from "./store/snapshot.js";

export const SESSION_VIEW_CLEAR_SEQUENCE = "\x1b[2J\x1b[3J\x1b[H";
export const NEW_SESSION_CLEAR_SEQUENCE = SESSION_VIEW_CLEAR_SEQUENCE;

export const ESC_INTERRUPT_WINDOW_MS = 1500;
const ESC_INTERRUPT_HINT = "Press Esc again to interrupt";

type TranscriptSurfaceResetReason = "new-session" | "switch-session";

export interface TerminalUiOptions {
  readonly clearOnStart?: boolean;
  readonly client: CoreAPI;
  readonly subscribeEvents: (handler: UiEventHandler) => UiUnsubscribe;
}

export function OhbabyTerminalApp({
  clearOnStart = false,
  client,
  subscribeEvents,
}: TerminalUiOptions): ReactElement {
  const storeRef = useRef<TuiStore>(createTuiStore(createEmptySnapshot()));
  const keyboardCommandSequenceRef = useRef(0);
  const catalogRequestSequenceRef = useRef(0);
  const contextRefreshSequenceRef = useRef(0);
  const contextNoticeSequenceRef = useRef(0);
  const snapshotRefreshSequenceRef = useRef(0);
  const didClearOnStartRef = useRef(false);
  const disposedRef = useRef(false);
  const [screenGeneration, setScreenGeneration] = useState(0);
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
  if (clearOnStart && !didClearOnStartRef.current) {
    writeStdout(NEW_SESSION_CLEAR_SEQUENCE);
    didClearOnStartRef.current = true;
  }
  const activeSessionId = useTuiStoreSelector(
    store,
    (state) => state.activeSessionId,
  );
  activeSessionIdRef.current = activeSessionId;
  const activeContextWindowUsage = useTuiStoreSelector(
    store,
    selectActiveContextWindowUsage,
  );
  const activeGoal = useTuiStoreSelector(store, selectActiveGoal);
  const catalog = useTuiStoreSelector(store, (state) => state.catalog);
  const interactions = useTuiStoreSelector(
    store,
    (state) => state.interactions,
  );
  const permission = useTuiStoreSelector(store, (state) => state.permission);
  const permissions = useTuiStoreSelector(store, (state) => state.permissions);
  const runtime = useTuiStoreSelector(store, (state) => state.runtime);
  const hasBackendDialog = permissions.length > 0 || interactions.length > 0;
  const hasDialog = hasBackendDialog || commandPanel !== null;
  const contextWindowUsageLabel = formatContextWindowUsage(
    activeContextWindowUsage,
  );
  const [escInterruptArmedRunId, setEscInterruptArmedRunId] = useState<
    string | null
  >(null);
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
      runtime.kind !== "running" ||
      runtime.runId !== escInterruptArmedRunId
    ) {
      disarmEscInterrupt(escInterruptArmedRunId);
    }
  }, [disarmEscInterrupt, escInterruptArmedRunId, permissions.length, runtime]);
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
  const runtimeStatusLabel =
    runtime.kind === "running" && escInterruptArmedRunId === runtime.runId
      ? ESC_INTERRUPT_HINT
      : effectiveRuntime.kind === "error"
        ? formatRuntimeLabel(permissions, runtime)
        : undefined;
  const setActiveCommandPanel = useCallback(
    (panel: CommandPanelState | null): void => {
      commandPanelRef.current = panel;
      setCommandPanel(panel);
    },
    [],
  );
  const resetTranscriptSurface = useCallback(
    (_reason: TranscriptSurfaceResetReason): void => {
      writeStdout(SESSION_VIEW_CLEAR_SEQUENCE);
      setScreenGeneration((current) => current + 1);
      setActiveCommandPanel(null);
    },
    [setActiveCommandPanel, writeStdout],
  );
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
    (tuiEvent: TuiEvent): boolean => {
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
        error: sanitizeCommandPanelError(tuiEvent.error.message),
        status: "error",
      });
      return true;
    },
    [setActiveCommandPanel],
  );

  useInput(
    (value, key) => {
      if (commandPanelRef.current !== null) {
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

      if (key.escape) {
        if (permissions.length > 0 || runtime.kind !== "running") {
          disarmEscInterrupt();
          return;
        }
        if (escInterruptArmedRunIdRef.current !== runtime.runId) {
          armEscInterrupt(runtime.runId);
          return;
        }
        disarmEscInterrupt(runtime.runId);
        void client.abortRun(runtime.runId).catch((caught: unknown) => {
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

      if (permissions.length > 0) {
        void client.abortRun(permissions[0].runId).catch((caught: unknown) => {
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

      if (runtime.kind === "running") {
        void client.abortRun(runtime.runId).catch((caught: unknown) => {
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
        store.setCatalog(catalog);
      }
      return catalog;
    } catch (caught) {
      if (!disposedRef.current) {
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

    const unsubscribe = subscribeEvents((tuiEvent: TuiEvent) => {
      if (consumeCommandPanelEvent(tuiEvent)) {
        return;
      }

      const selectedExistingSessionId =
        selectedExistingSessionIdFromEvent(tuiEvent);
      if (selectedExistingSessionId !== undefined) {
        eventDispatcher.dispatch(
          commandResultWithoutSessionSelection(tuiEvent),
        );
        const requestSequence = snapshotRefreshSequenceRef.current + 1;
        snapshotRefreshSequenceRef.current = requestSequence;
        void client
          .getSnapshot()
          .then((snapshot) => {
            if (
              disposedRef.current ||
              requestSequence !== snapshotRefreshSequenceRef.current ||
              snapshot.activeSessionId !== selectedExistingSessionId
            ) {
              return;
            }
            resetTranscriptSurface("switch-session");
            store.replaceSnapshot(snapshot);
          })
          .catch((caught: unknown) => {
            if (
              !disposedRef.current &&
              requestSequence === snapshotRefreshSequenceRef.current
            ) {
              store.dispatch({
                status: {
                  kind: "error",
                  message: formatError(caught),
                  recoverable: true,
                },
                type: "runtime.updated",
              });
            }
          });
      } else {
        eventDispatcher.dispatch(tuiEvent);

        const isNewSessionSelection = isNewSessionSelectionEvent(tuiEvent);
        if (isNewSessionSelection) {
          snapshotRefreshSequenceRef.current += 1;
          resetTranscriptSurface("new-session");
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

    const requestSequence = snapshotRefreshSequenceRef.current + 1;
    snapshotRefreshSequenceRef.current = requestSequence;
    void client
      .getSnapshot()
      .then((snapshot) => {
        if (
          !disposedRef.current &&
          requestSequence === snapshotRefreshSequenceRef.current
        ) {
          store.replaceSnapshot(snapshot);
        }
      })
      .catch((caught: unknown) => {
        if (
          !disposedRef.current &&
          requestSequence === snapshotRefreshSequenceRef.current
        ) {
          store.dispatch({
            status: {
              kind: "error",
              message: formatError(caught),
              recoverable: true,
            },
            type: "runtime.updated",
          });
        }
      });
    void loadCatalog().catch(() => undefined);

    return (): void => {
      disposedRef.current = true;
      eventDispatcher.dispose();
      unsubscribe();
    };
  }, [
    client,
    consumeCommandPanelEvent,
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

  useEffect(() => {
    const sessionId = activeSessionId;
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
  }, [activeSessionId, client, store]);

  return (
    <ThemeProvider>
      <AppShell key={screenGeneration}>
        <HeaderContainer store={store} />
        <TranscriptViewportContainer store={store} />
        <DialogManager
          client={client}
          interactions={interactions}
          permissions={permissions}
        />
        <CommandPanelManager
          catalog={catalog}
          client={client}
          contextWindowUsage={activeContextWindowUsage}
          onClose={closeCommandPanel}
          panel={hasBackendDialog ? null : commandPanel}
          runtime={runtime}
        />
        <Prompt
          activeSessionId={activeSessionId}
          catalog={catalog}
          client={client}
          disabled={hasDialog}
          goalStatus={activeGoal?.status}
          isRuntimeRunning={runtime.kind === "running"}
          loadCatalog={loadCatalog}
          onCommandPanelOpen={openCommandPanel}
          permission={permission}
          contextWindowUsage={contextWindowUsageLabel}
          runtimeStatusLabel={runtimeStatusLabel}
        />
        <CatalogInvalidation store={store} />
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
    (state) => state.messages.length === 0,
  );

  return <Header isEmpty={isEmpty} />;
}

function TranscriptViewportContainer({
  store,
}: {
  readonly store: TuiStore;
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

  return (
    <TranscriptViewport
      key={activeSessionId ?? "none"}
      commandNotices={commandNotices}
      committedItems={committedItems}
      liveMessage={liveMessage}
      liveReasoning={liveReasoning}
      notices={notices}
      runtime={runtime}
    />
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

function isNewSessionSelectionEvent(tuiEvent: TuiEvent): boolean {
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
  tuiEvent: TuiEvent,
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

function commandResultWithoutSessionSelection(tuiEvent: TuiEvent): TuiEvent {
  if (
    tuiEvent.type !== "command.result.delivered" ||
    tuiEvent.action?.kind !== "session.selected"
  ) {
    return tuiEvent;
  }
  return {
    ...tuiEvent,
    action: undefined,
  };
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
    "mcps",
    "permission",
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
      return `error: ${effectiveRuntime.message}`;
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "TUI backend request failed";
}
