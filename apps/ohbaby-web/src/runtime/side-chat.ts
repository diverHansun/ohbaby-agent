import type { UiBackendClient, UiSideChatEntry } from "ohbaby-sdk";
import { createBrowserDaemonClient } from "../api/daemon/client.js";
import type { OhbabyBootstrapConfig } from "../api/daemon/wire.js";
import { createOhbabyWebStore, type OhbabyWebStore } from "../store/store.js";

/** What a side chat tab needs to find its session again. */
export type SideChatEntry = Pick<
  UiSideChatEntry,
  "sideChatId" | "title" | "boundaryMessageId" | "workingDirectory"
>;

export interface SideChatDraftSnapshot {
  readonly text: string;
  /** Bumped to move focus to the input: a new side chat, or a quote landing. */
  readonly focusToken: number;
}

/**
 * The input text of one side chat. It lives with the connection, not the
 * page: the page unmounts on every tab switch and when the panel collapses.
 */
export interface SideChatDraft {
  readonly getSnapshot: () => SideChatDraftSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly set: (text: string) => void;
  /** Appends the selection as a Markdown quote; nothing is sent. */
  readonly quote: (selection: string) => void;
  readonly requestFocus: () => void;
  /** True once per focus request, so a remounted page does not steal focus. */
  readonly consumeFocus: () => boolean;
}

/**
 * One side chat's own daemon client: its store, event stream and approvals,
 * apart from the main client (side chat 02 Stage 2 step 2). It stays connected
 * while the tab is hidden, so approvals still arrive.
 */
export interface SideChatConnection {
  readonly sideChatId: string;
  readonly store: OhbabyWebStore;
  readonly client: UiBackendClient;
  readonly draft: SideChatDraft;
  abortSession(sessionId: string, runId?: string): Promise<void>;
  retryPermissions(): void;
  retrySession(): void;
  loadEarlierHistory(): Promise<void>;
  /** Drops the client and its stream; the side chat itself is kept. */
  close(): Promise<void>;
}

/** `> ` on every line and a blank line after, ready for the question. */
export function quoteSelection(selection: string): string {
  const lines = selection
    .replace(/\r\n?/gu, "\n")
    .trim()
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`));
  return `${lines.join("\n")}\n\n`;
}

export function createSideChatDraft(): SideChatDraft {
  let snapshot: SideChatDraftSnapshot = { text: "", focusToken: 0 };
  let consumed = 0;
  const listeners = new Set<() => void>();
  const publish = (next: SideChatDraftSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: (): SideChatDraftSnapshot => snapshot,
    subscribe: (listener): (() => void) => {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    set: (text): void => {
      if (text !== snapshot.text) publish({ ...snapshot, text });
    },
    requestFocus: (): void => {
      publish({ ...snapshot, focusToken: snapshot.focusToken + 1 });
    },
    consumeFocus: (): boolean => {
      if (consumed === snapshot.focusToken) return false;
      consumed = snapshot.focusToken;
      return true;
    },
    quote: (selection): void => {
      const quote = quoteSelection(selection);
      const before = snapshot.text.trimEnd();
      publish({
        text: before === "" ? quote : `${before}\n\n${quote}`,
        focusToken: snapshot.focusToken + 1,
      });
    },
  };
}

/**
 * Connects a new client bound to the side chat. It is built outside the
 * instance layer, so switching the main chat never closes it.
 */
export function connectSideChat(input: {
  readonly config: OhbabyBootstrapConfig;
  readonly fetch?: typeof fetch;
  readonly entry: SideChatEntry;
}): SideChatConnection {
  const store = createOhbabyWebStore();
  const client = createBrowserDaemonClient({
    config: {
      baseUrl: input.config.baseUrl,
      token: input.config.token,
      clientId: globalThis.crypto.randomUUID(),
      directory: input.entry.workingDirectory,
      startupIntent: { resumeSessionId: input.entry.sideChatId },
    },
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    store,
  });
  void client.connect().catch((error: unknown) => {
    if (!client.closed)
      store.setError(error instanceof Error ? error.message : String(error));
  });
  return {
    sideChatId: input.entry.sideChatId,
    store,
    client,
    draft: createSideChatDraft(),
    abortSession: (sessionId, runId) =>
      client.abortSessionForRuntime(sessionId, runId),
    retryPermissions: (): void => {
      client.retryPermissions();
    },
    retrySession: (): void => {
      client.retrySession();
    },
    loadEarlierHistory: () => client.loadEarlierHistory(),
    close: () => client.close(),
  };
}
