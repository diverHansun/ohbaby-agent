import { Box, Text } from "ink";
import { useEffect, useRef } from "react";
import type { ReactElement } from "react";
import type { UiSnapshot } from "ohbaby-sdk";
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
  const state = useTuiStoreSelector(store, (current) => current);
  const hasDialog = state.permissions.length > 0 || state.interactions.length > 0;

  useEffect(() => {
    let disposed = false;
    let catalogRequestSequence = 0;

    const loadCatalog = async (): Promise<void> => {
      if (client.listCommands === undefined) {
        return;
      }

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
            runtime: {
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
            runtime: {
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
  }, [client, store]);

  return (
    <Box flexDirection="column">
      <MessageList messages={state.messages} notices={state.commandNotices} />
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
  value: TuiCommandCatalog | readonly TuiCommandSpec[],
): TuiCommandCatalog {
  if (Array.isArray(value)) {
    return {
      commands: value,
      loadedAt: Date.now(),
      surface: "tui",
      version: "local",
    };
  }

  return value as TuiCommandCatalog;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "TUI backend request failed";
}
