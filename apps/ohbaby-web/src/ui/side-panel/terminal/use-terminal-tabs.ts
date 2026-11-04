import { useCallback, useEffect, useRef, useState } from "react";
import { TERMINAL_ERROR_CODES, type TerminalInfo } from "ohbaby-sdk";
import { isDaemonRequestError } from "../../../api/daemon/http.js";
import type { TerminalApi } from "../../../api/daemon/terminals.js";
import type { SidePageStates, SidePanelTab } from "../side-pages.js";
import type { SidePanelControls } from "../use-side-panel.js";

type TerminalTab = Extract<SidePanelTab, { kind: "terminal" }>;

/** Asked before closing a terminal that still runs a program (D7). */
export interface TerminalCloseConfirmation {
  readonly tab: TerminalTab;
  readonly process: string;
  readonly remove?: (id: string) => void;
}

/** The terminal's cols and rows before the view measures the panel. */
const INITIAL_SIZE = { cols: 80, rows: 24 } as const;

function sameInfo(left: TerminalInfo, right: TerminalInfo): boolean {
  return (
    left.state === right.state &&
    left.error === right.error &&
    left.title === right.title
  );
}

function createFailure(error: unknown): Error {
  if (isDaemonRequestError(error)) {
    if (error.code === TERMINAL_ERROR_CODES.LIMIT_REACHED)
      return new Error(
        "You already have 16 terminals open. Close one you no longer need and try again.",
      );
    if (error.code === TERMINAL_ERROR_CODES.UNAVAILABLE)
      return new Error(`Terminal unavailable: ${error.message}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Terminal tabs follow the daemon's terminals (D9, F1b): a load or window
 * focus re-reads the list, adds the missing tabs without moving the panel,
 * and marks tabs whose terminal is gone. Opening and closing go through the
 * server first, so a tab always stands for a real terminal (D1, D7).
 */
export function useTerminalTabs(input: {
  readonly api: TerminalApi;
  readonly panel: SidePanelControls;
  readonly directory: () => string | null;
  readonly onError: (error: unknown) => void;
}): {
  readonly createTerminal: () => void;
  /** `remove` takes the tab away once closed; the panel passes its focus-keeping close. */
  readonly closeTerminal: (
    tab: TerminalTab,
    force?: boolean,
    remove?: (id: string) => void,
  ) => void;
  readonly confirmation: TerminalCloseConfirmation | null;
  readonly dismissConfirmation: () => void;
  readonly markExited: (tab: TerminalTab, exitCode: number) => void;
  readonly sync: () => void;
} {
  const { api, onError } = input;
  const { addTabs, updateTabs, closeTab } = input.panel;
  // Patch by terminal id, so a close and an exit arriving together both land.
  const patch = useCallback(
    (
      id: string,
      change: (state: SidePageStates["terminal"]) => SidePageStates["terminal"],
    ): void => {
      updateTabs("terminal", (state) =>
        state.terminal.id === id ? change(state) : state,
      );
    },
    [updateTabs],
  );
  const directory = useRef(input.directory);
  directory.current = input.directory;
  const [confirmation, setConfirmation] =
    useState<TerminalCloseConfirmation | null>(null);
  // Creates and closes finished during a list read make that read stale.
  const writes = useRef(0);

  const sync = useCallback((): void => {
    const before = writes.current;
    void api.list().then(
      (terminals) => {
        if (writes.current !== before) return;
        const byId = new Map(
          terminals.map((terminal) => [terminal.id, terminal]),
        );
        updateTabs("terminal", (state) => {
          // A close in progress owns the tab; the screen stays until it ends.
          if (state.closing) return state;
          const current = byId.get(state.terminal.id);
          if (!current) return state.gone ? state : { ...state, gone: true };
          if (!state.gone && sameInfo(current, state.terminal)) return state;
          return { ...state, terminal: current, gone: false };
        });
        addTabs(
          "terminal",
          [...terminals]
            .sort((left, right) => left.createdAt - right.createdAt)
            .map((terminal) => ({ terminal })),
          (left, right) => left.terminal.id === right.terminal.id,
        );
      },
      // A failed read proves nothing about the terminals; keep the tabs as they are.
      () => undefined,
    );
  }, [api, addTabs, updateTabs]);

  useEffect(() => {
    sync();
    window.addEventListener("focus", sync);
    return (): void => {
      window.removeEventListener("focus", sync);
    };
  }, [sync]);

  // No spinner (D1), so a second click while one create is pending is ignored.
  const creating = useRef(false);
  const createTerminal = useCallback((): void => {
    if (creating.current) return;
    creating.current = true;
    void api
      .create({ directory: directory.current(), ...INITIAL_SIZE })
      .then(
        (terminal) => {
          writes.current += 1;
          // A focus sync may have added this terminal already; select that tab.
          addTabs(
            "terminal",
            [{ terminal }],
            (left, right) => left.terminal.id === right.terminal.id,
            true,
          );
        },
        (error: unknown) => {
          onError(createFailure(error));
        },
      )
      .finally(() => {
        creating.current = false;
      });
  }, [api, addTabs, onError]);

  const closeTerminal = useCallback(
    (
      tab: TerminalTab,
      force = false,
      remove: (id: string) => void = closeTab,
    ): void => {
      if (tab.state.closing) return;
      if (tab.state.gone) {
        remove(tab.id);
        return;
      }
      const id = tab.state.terminal.id;
      setConfirmation(null);
      patch(id, (state) => ({ ...state, closing: true }));
      void api.close(id, force).then(
        () => {
          writes.current += 1;
          remove(tab.id);
        },
        (error: unknown) => {
          if (isDaemonRequestError(error)) {
            if (error.status === 404) {
              writes.current += 1;
              remove(tab.id);
              return;
            }
            if (error.code === TERMINAL_ERROR_CODES.BUSY) {
              patch(id, (state) => ({ ...state, closing: false }));
              setConfirmation({
                tab,
                process: error.process ?? "A program",
                remove,
              });
              return;
            }
            if (error.code === TERMINAL_ERROR_CODES.CLOSE_FAILED) {
              patch(id, (state) => ({
                ...state,
                closing: false,
                terminal: {
                  ...state.terminal,
                  state: "close_failed",
                  error: error.message,
                },
              }));
              return;
            }
          }
          patch(id, (state) => ({ ...state, closing: false }));
          onError(error);
        },
      );
    },
    [api, closeTab, onError, patch],
  );

  const markExited = useCallback(
    (tab: TerminalTab, exitCode: number): void => {
      patch(tab.state.terminal.id, (state) => ({ ...state, exitCode }));
    },
    [patch],
  );

  return {
    createTerminal,
    closeTerminal,
    confirmation,
    dismissConfirmation: (): void => {
      setConfirmation(null);
    },
    markExited,
    sync,
  };
}
