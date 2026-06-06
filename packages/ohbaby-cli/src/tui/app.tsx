import { Text, useApp, useInput } from "ink";
import { useCallback, useEffect, useRef } from "react";
import type { ReactElement } from "react";
import type {
  CoreAPI,
  UiCommandInvocation,
  UiEventHandler,
  UiSnapshot,
  UiUnsubscribe,
} from "ohbaby-sdk";
import { DialogManager } from "./dialogs/manager.js";
import { Header } from "./components/header.js";
import { MessageList } from "./components/message/message-list.js";
import { Prompt } from "./components/prompt/index.js";
import { AppShell } from "./layout/app-shell.js";
import { formatContextWindowUsage } from "./render/usage.js";
import { createTuiStore } from "./store/events.js";
import {
  selectActiveContextWindowUsage,
  selectEffectiveRuntime,
  selectRuntimeLabel,
  useTuiStoreSelector,
} from "./store/selectors.js";
import type {
  TuiCommandCatalog,
  TuiEvent,
  TuiStore,
} from "./store/snapshot.js";

export interface TerminalUiOptions {
  readonly client: CoreAPI;
  readonly subscribeEvents: (handler: UiEventHandler) => UiUnsubscribe;
}

export function OhbabyTerminalApp({
  client,
  subscribeEvents,
}: TerminalUiOptions): ReactElement {
  const storeRef = useRef<TuiStore>(createTuiStore(createEmptySnapshot()));
  const keyboardCommandSequenceRef = useRef(0);
  const catalogRequestSequenceRef = useRef(0);
  const contextRefreshSequenceRef = useRef(0);
  const contextNoticeSequenceRef = useRef(0);
  const disposedRef = useRef(false);
  const store = storeRef.current;
  const { exit } = useApp();
  const state = useTuiStoreSelector(store, (current) => current);
  const hasDialog =
    state.permissions.length > 0 || state.interactions.length > 0;
  const contextWindowUsageLabel = formatContextWindowUsage(
    selectActiveContextWindowUsage(state),
  );
  const runtime = selectEffectiveRuntime(state);
  const runtimeStatusLabel =
    runtime.kind === "error" ? selectRuntimeLabel(state) : undefined;

  useInput(
    (value, key) => {
      if (key.tab && key.shift && state.permissions.length === 0) {
        const command = nextPermissionModeCommand(
          state.permission,
          state.activeSessionId ?? undefined,
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

      if (value !== "\u0003" && !(key.ctrl && value === "c")) {
        return;
      }

      if (state.permissions.length > 0) {
        void client
          .abortRun(state.permissions[0].runId)
          .catch((caught: unknown) => {
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

      if (state.runtime.kind === "running") {
        void client.abortRun(state.runtime.runId).catch((caught: unknown) => {
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
    { isActive: state.interactions.length === 0 },
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

    const unsubscribe = subscribeEvents((tuiEvent: TuiEvent) => {
      store.dispatch(tuiEvent);

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

    void client
      .getSnapshot()
      .then((snapshot) => {
        if (!disposedRef.current) {
          store.replaceSnapshot(snapshot);
        }
      })
      .catch((caught: unknown) => {
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
      });
    void loadCatalog().catch(() => undefined);

    return (): void => {
      disposedRef.current = true;
      unsubscribe();
    };
  }, [client, exit, loadCatalog, store, subscribeEvents]);

  useEffect(() => {
    const sessionId = state.activeSessionId;
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
  }, [client, state.activeSessionId, store]);

  return (
    <AppShell>
      <Header state={state} />
      <MessageList
        commandNotices={state.commandNotices}
        messages={state.messages}
        notices={state.notices}
      />
      <DialogManager
        client={client}
        interactions={state.interactions}
        permissions={state.permissions}
      />
      <Prompt
        activeSessionId={state.activeSessionId}
        catalog={state.catalog}
        client={client}
        disabled={hasDialog}
        loadCatalog={loadCatalog}
        permission={state.permission}
        contextWindowUsage={contextWindowUsageLabel}
        runtimeStatusLabel={runtimeStatusLabel}
      />
      {state.catalogInvalidation === null ? null : (
        <Text dimColor>
          command catalog refresh: {state.catalogInvalidation.version ?? "new"}
        </Text>
      )}
    </AppShell>
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
