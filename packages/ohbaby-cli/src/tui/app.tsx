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
  useTuiStoreSelector,
} from "./store/selectors.js";
import { createCoalescedTuiEventDispatcher } from "./store/stream-coalescer.js";
import { ThemeProvider } from "./theme/index.js";
import type {
  TuiCommandCatalog,
  TuiEvent,
  TuiStore,
  TuiRuntimeStatus,
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
  const activeSessionId = useTuiStoreSelector(
    store,
    (state) => state.activeSessionId,
  );
  const activeContextWindowUsage = useTuiStoreSelector(
    store,
    selectActiveContextWindowUsage,
  );
  const catalog = useTuiStoreSelector(store, (state) => state.catalog);
  const interactions = useTuiStoreSelector(
    store,
    (state) => state.interactions,
  );
  const permission = useTuiStoreSelector(store, (state) => state.permission);
  const permissions = useTuiStoreSelector(store, (state) => state.permissions);
  const runtime = useTuiStoreSelector(store, (state) => state.runtime);
  const hasDialog = permissions.length > 0 || interactions.length > 0;
  const contextWindowUsageLabel = formatContextWindowUsage(
    activeContextWindowUsage,
  );
  const effectiveRuntime = resolveEffectiveRuntime(permissions, runtime);
  const runtimeStatusLabel =
    effectiveRuntime.kind === "error"
      ? formatRuntimeLabel(permissions, runtime)
      : undefined;

  useInput(
    (value, key) => {
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
    { isActive: interactions.length === 0 },
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
      eventDispatcher.dispatch(tuiEvent);

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
      eventDispatcher.dispose();
      unsubscribe();
    };
  }, [client, exit, loadCatalog, store, subscribeEvents]);

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
      <AppShell>
        <HeaderContainer store={store} />
        <MessageListContainer store={store} />
        <DialogManager
          client={client}
          interactions={interactions}
          permissions={permissions}
        />
        <Prompt
          activeSessionId={activeSessionId}
          catalog={catalog}
          client={client}
          disabled={hasDialog}
          loadCatalog={loadCatalog}
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

function MessageListContainer({
  store,
}: {
  readonly store: TuiStore;
}): ReactElement {
  const commandNotices = useTuiStoreSelector(
    store,
    (state) => state.commandNotices,
  );
  const messages = useTuiStoreSelector(store, (state) => state.messages);
  const notices = useTuiStoreSelector(store, (state) => state.notices);

  return (
    <MessageList
      commandNotices={commandNotices}
      messages={messages}
      notices={notices}
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
