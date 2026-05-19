import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useRef } from "react";
import type { ReactElement } from "react";
import type { UiCommandCatalog, UiSnapshot } from "ohbaby-sdk";
import { DialogManager } from "./dialogs/manager.js";
import { MessageList } from "./components/message/message-list.js";
import { Prompt } from "./components/prompt/index.js";
import { StatusBar } from "./components/status-bar.js";
import { createTuiStore } from "./store/events.js";
import { useTuiStoreSelector } from "./store/selectors.js";
import type {
  TuiBackendClient,
  TuiCommandCatalog,
  TuiCommandSpec,
  TuiEvent,
  TuiStore,
} from "./store/snapshot.js";

export interface TerminalUiOptions {
  readonly client: TuiBackendClient;
}

export function OhbabyTerminalApp({ client }: TerminalUiOptions): ReactElement {
  const storeRef = useRef<TuiStore>(createTuiStore(createEmptySnapshot()));
  const store = storeRef.current;
  const { exit } = useApp();
  const state = useTuiStoreSelector(store, (current) => current);
  const hasDialog = state.permissions.length > 0 || state.interactions.length > 0;

  useInput(
    (value, key) => {
      if (value !== "\u0003" && !(key.ctrl && value === "c")) {
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
    { isActive: !hasDialog },
  );

  useEffect(() => {
    let disposed = false;
    let catalogRequestSequence = 0;

    const loadCatalog = async (): Promise<void> => {
      const requestSequence = catalogRequestSequence + 1;
      catalogRequestSequence = requestSequence;

      try {
        const catalog = normalizeCommandCatalog(
          await client.listCommands({ surface: "tui" }),
        );

        if (!disposed && requestSequence === catalogRequestSequence) {
          store.setCatalog(catalog);
        }
      } catch (caught) {
        if (!disposed) {
          store.dispatch({
            status: {
              kind: "error",
              message: formatError(caught),
              recoverable: true,
            },
            type: "runtime.updated",
          });
        }
      }
    };

    const unsubscribe = client.subscribeEvents((tuiEvent: TuiEvent) => {
      store.dispatch(tuiEvent);

      if (
        tuiEvent.type === "command.result.delivered" &&
        tuiEvent.action?.kind === "app.exit"
      ) {
        exit();
      }

      if (tuiEvent.type === "command.catalog.updated") {
        void loadCatalog();
      }
    });

    void client
      .getSnapshot()
      .then((snapshot) => {
        if (!disposed) {
          store.replaceSnapshot(snapshot);
        }
      })
      .catch((caught: unknown) => {
        if (!disposed) {
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
    void loadCatalog();

    return (): void => {
      disposed = true;
      unsubscribe();
    };
  }, [client, exit, store]);

  return (
    <Box flexDirection="column">
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
      />
      <StatusBar state={state} />
      {state.catalogInvalidation === null ? null : (
        <Text dimColor>
          command catalog refresh: {state.catalogInvalidation.version ?? "new"}
        </Text>
      )}
    </Box>
  );
}

function createEmptySnapshot(): UiSnapshot {
  return {
    activeSessionId: null,
    permissions: [],
    runs: [],
    sessions: [],
    status: { kind: "idle" },
  };
}

function normalizeCommandCatalog(
  value: UiCommandCatalog | TuiCommandCatalog | readonly TuiCommandSpec[],
): TuiCommandCatalog {
  if (isCommandArray(value)) {
    return {
      commands: value,
      loadedAt: Date.now(),
      surface: "tui",
      version: "local",
    };
  }

  return {
    commands: value.commands,
    loadedAt: "loadedAt" in value ? value.loadedAt : Date.now(),
    surface: "surface" in value ? value.surface : "tui",
    version: value.version,
  };
}

function isCommandArray(
  value: UiCommandCatalog | TuiCommandCatalog | readonly TuiCommandSpec[],
): value is readonly TuiCommandSpec[] {
  return Array.isArray(value);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "TUI backend request failed";
}
