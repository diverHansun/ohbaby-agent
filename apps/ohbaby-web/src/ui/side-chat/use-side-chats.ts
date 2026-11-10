import { useCallback, useEffect, useRef, useState } from "react";
import type { OhbabyWebRuntime } from "../../runtime/index.js";
import type {
  SideChatConnection,
  SideChatEntry,
} from "../../runtime/side-chat.js";
import type { SidePanelTab } from "../side-panel/side-pages.js";
import type { SidePanelControls } from "../side-panel/use-side-panel.js";

type SideChatTab = Extract<SidePanelTab, { kind: "sideChat" }>;

export const SIDE_CHAT_NOT_STARTED = "Send a message first";

/**
 * Side chat tabs and their clients (side chat 02 Stage 2). A tab opens only
 * after the server made the side chat. Each one keeps its own client while
 * its tab is hidden or the panel is collapsed, so approvals still arrive; a
 * reload lists the main chat's open side chats and puts them back.
 */
export function useSideChats(input: {
  readonly runtime: Pick<
    OhbabyWebRuntime,
    "openSideChat" | "listSideChats" | "closeSideChat" | "connectSideChat"
  >;
  readonly panel: SidePanelControls;
  /** The open main chat; undefined for a new-chat draft. */
  readonly mainSessionId: string | undefined;
  /** The main chat has had a message; a side chat needs one to read. */
  readonly started: boolean;
  readonly onError: (error: unknown) => void;
}): {
  /** Why no side chat can be opened now. */
  readonly unavailable: string | undefined;
  readonly connection: (sideChatId: string) => SideChatConnection | undefined;
  readonly open: () => void;
  readonly close: (tab: SideChatTab, remove: (id: string) => void) => void;
  /** Quotes into the side chat on screen, else into a new one; never sends. */
  readonly quote: (selection: string) => void;
} {
  const { runtime, mainSessionId, onError } = input;
  const { addTabs, openPage, updateTabs } = input.panel;
  const connections = useRef(new Map<string, SideChatConnection>());
  const watchers = useRef(new Map<string, () => void>());
  // The pages read connections from a ref; this re-renders them when one arrives.
  const [, setVersion] = useState(0);

  const attach = useCallback(
    (entry: SideChatEntry): SideChatConnection => {
      const existing = connections.current.get(entry.sideChatId);
      if (existing) return existing;
      const connection = runtime.connectSideChat(entry);
      connections.current.set(entry.sideChatId, connection);
      watchers.current.set(
        entry.sideChatId,
        connection.store.subscribe(() => {
          const awaiting =
            connection.store.getSnapshot().permissionSync.requests.length > 0;
          updateTabs("sideChat", (state) =>
            state.entry.sideChatId === entry.sideChatId &&
            (state.awaitingApproval === true) !== awaiting
              ? { ...state, awaitingApproval: awaiting }
              : state,
          );
        }),
      );
      setVersion((version) => version + 1);
      return connection;
    },
    [runtime, updateTabs],
  );
  const detach = useCallback((sideChatId: string): void => {
    watchers.current.get(sideChatId)?.();
    watchers.current.delete(sideChatId);
    const connection = connections.current.get(sideChatId);
    connections.current.delete(sideChatId);
    void connection?.close();
  }, []);

  // Clients end with the page; the side chats themselves stay on the server.
  useEffect(() => {
    const open = connections.current;
    return (): void => {
      for (const sideChatId of [...open.keys()]) detach(sideChatId);
    };
  }, [detach]);

  // After a reload, or on returning to a main chat: put its side chats back.
  useEffect(() => {
    if (mainSessionId === undefined) return;
    let current = true;
    void runtime.listSideChats(mainSessionId).then(
      (entries) => {
        if (!current || entries.length === 0) return;
        for (const entry of entries) attach(entry);
        addTabs(
          "sideChat",
          entries.map((entry) => ({ mainSessionId, entry })),
          (left, right) => left.entry.sideChatId === right.entry.sideChatId,
        );
      },
      // A failed read proves nothing; the tabs already open stay as they are.
      () => undefined,
    );
    return (): void => {
      current = false;
    };
  }, [runtime, mainSessionId, attach, addTabs]);

  const opening = useRef<Promise<SideChatConnection | undefined> | null>(null);
  const openOne = useCallback((): Promise<SideChatConnection | undefined> => {
    if (opening.current) return opening.current;
    if (mainSessionId === undefined || !input.started)
      return Promise.resolve(undefined);
    const pending = runtime
      .openSideChat(mainSessionId)
      .then(
        (entry) => {
          const connection = attach(entry);
          connection.draft.requestFocus();
          openPage("sideChat", { mainSessionId, entry });
          return connection;
        },
        (error: unknown) => {
          onError(error);
          return undefined;
        },
      )
      .finally(() => {
        opening.current = null;
      });
    opening.current = pending;
    return pending;
  }, [runtime, mainSessionId, input.started, attach, openPage, onError]);

  const close = useCallback(
    (tab: SideChatTab, remove: (id: string) => void): void => {
      const { entry } = tab.state;
      remove(tab.id);
      void runtime
        .closeSideChat(entry)
        .catch(onError)
        .finally(() => {
          detach(entry.sideChatId);
        });
    },
    [runtime, detach, onError],
  );

  const panelState = input.panel.state;
  const quote = useCallback(
    (selection: string): void => {
      const active = panelState.open
        ? panelState.tabs.find((tab) => tab.id === panelState.activeTabId)
        : undefined;
      const shown =
        active?.kind === "sideChat"
          ? connections.current.get(active.state.entry.sideChatId)
          : undefined;
      if (shown) shown.draft.quote(selection);
      else
        void openOne().then((connection) => {
          connection?.draft.quote(selection);
        });
    },
    [panelState, openOne],
  );

  return {
    unavailable:
      mainSessionId !== undefined && input.started
        ? undefined
        : SIDE_CHAT_NOT_STARTED,
    connection: (sideChatId) => connections.current.get(sideChatId),
    open: (): void => {
      void openOne();
    },
    close,
    quote,
  };
}
