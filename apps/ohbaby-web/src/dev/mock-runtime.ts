import type {
  UiBackendClient,
  UiSnapshot,
  UiSessionSearchPage,
  UiSessionSearchResult,
  UiWebCommandCatalog,
} from "ohbaby-sdk";
import type { OhbabyWebRuntime } from "../runtime/index.js";
import { createDraftStore } from "../store/draft.js";
import { createGlobalCatalogStore } from "../store/global-catalog.js";
import { createOhbabyWebStore } from "../store/store.js";
import { SettingsLayer } from "../runtime/settings-layer.js";
import { selectSettings } from "../store/settings-cache.js";
import { globalSessionPinsKey } from "../ui/sidebar/session-pins.js";
import { DEFAULT_WORKSPACE, mockScenarios } from "./mock-scenarios.js";
import { createMockSettingsApi } from "./mock-settings.js";

/** A few real-shaped commands so the slash palette can be previewed. */
const MOCK_COMMANDS: UiWebCommandCatalog = {
  version: "mock",
  commands: [
    {
      action: "compactSession",
      argumentMode: "structured",
      argsHint: "[--session_id <id>] [--force]",
      category: "session",
      description: "Compact the current session context",
      executionKind: "overlay",
      id: "compact",
      path: ["compact"],
      source: "builtin",
      surfaces: ["tui"],
    },
    {
      acceptsArguments: true,
      action: "openGoalPanel",
      argumentMode: "argv",
      argsHint: "[<objective> | status | pause | resume [<turns> turns]]",
      category: "session",
      description: "Create and control a long-running goal",
      executionKind: "overlay",
      id: "goal",
      path: ["goal"],
      source: "builtin",
      surfaces: ["tui"],
    },
    {
      action: "executeCommand",
      argumentMode: "argv",
      category: "skills",
      description: "List available skills",
      executionKind: "passthrough",
      id: "skills",
      path: ["skills"],
      source: "builtin",
      surfaces: ["tui"],
    },
    {
      action: "executeCommand",
      argumentMode: "argv",
      category: "system",
      description: "Show backend status",
      executionKind: "passthrough",
      id: "status",
      path: ["status"],
      source: "builtin",
      surfaces: ["tui"],
    },
  ],
};

const MOCK_PAGE = 100;
const ARCHIVED_PAGE = 50;

/** Seeds the scenario's pins once, so a viewer's own pin changes persist. */
function seedPins(pins: Readonly<Record<string, number>> | undefined): void {
  if (!pins) return;
  try {
    const key = globalSessionPinsKey(undefined);
    if (localStorage.getItem(key) === null)
      localStorage.setItem(key, JSON.stringify(pins));
  } catch {
    // Pins are decoration in the mock.
  }
}

/**
 * Dev-only runtime that renders a fixed scenario without a daemon. Mutating
 * sidebar operations update in-memory fixtures; prompts never reach a model.
 */
export function createMockRuntime(name: string): OhbabyWebRuntime {
  const scenario = (mockScenarios[name] ?? mockScenarios.typical)();
  const store = createOhbabyWebStore();
  installSnapshot(store, scenario.snapshot);
  store.setCurrentModel(scenario.model);
  store.setConnectionState("live");
  let sessions = [...scenario.sessions];
  let workspace = scenario.workspace;
  const hidden = new Set<string>();
  const catalog = createGlobalCatalogStore();
  catalog.setWorkspaces(scenario.workspace.scopes, DEFAULT_WORKSPACE);
  const page = (offset: number): void => {
    const visible = sessions.filter(
      (row) =>
        row.status !== "archived" && !hidden.has(row.workspaceDirectory ?? ""),
    );
    const rows = visible.slice(offset, offset + MOCK_PAGE);
    const next = offset + MOCK_PAGE;
    const cursor = next < visible.length ? String(next) : undefined;
    if (offset === 0) catalog.replaceSessions(rows, cursor);
    else catalog.appendSessions(rows, cursor);
  };
  page(0);
  seedPins(scenario.pins);
  const loadMoreSessions: OhbabyWebRuntime["loadMoreSessions"] = async (
    enough,
  ) => {
    catalog.setLoadingMore(true);
    try {
      let cursor = catalog.getSnapshot().nextCursor;
      while (cursor !== undefined && !enough(catalog.getSnapshot().sessions)) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        page(Number(cursor));
        cursor = catalog.getSnapshot().nextCursor;
      }
    } finally {
      catalog.setLoadingMore(false);
    }
  };

  const resolved = (): Promise<void> => Promise.resolve();
  // `archived-error`: the first read fails, so Retry can be tried.
  let archivedReads = 0;
  // `&delay=<ms>` slows settings requests so loading states can be seen.
  const delayMs = Number(
    new URLSearchParams(location.search).get("delay") ?? 0,
  );
  const settings = new SettingsLayer(
    createMockSettingsApi(
      name,
      () => new Promise((resolve) => setTimeout(resolve, delayMs)),
    ),
    () => DEFAULT_WORKSPACE,
  );
  // Stands in for `model.invalidated`: the instance model follows the default.
  settings.cache.subscribe(() => {
    const models = selectSettings(settings.cache.getSnapshot(), "models").data;
    if (!models) return;
    const active = models.models.find(
      (entry) => entry.id === models.active?.id,
    );
    if (
      (active?.model ?? null) ===
      (store.getSnapshot().currentModel?.model ?? null)
    )
      return;
    store.setCurrentModel(
      active
        ? {
            provider: active.provider,
            model: active.model,
            baseUrl: active.baseUrl ?? "",
            contextWindowTokens: active.contextWindowTokens,
            interfaceProvider: active.interfaceProvider ?? "openai-compatible",
          }
        : null,
    );
  });
  const client = new Proxy<Record<string, unknown>>(
    {},
    {
      get(_target, key): unknown {
        if (key === "then") return undefined;
        if (key === "listCommands")
          return (): Promise<unknown> => Promise.resolve(MOCK_COMMANDS);
        if (key === "respondPermission" || key === "abortRun") return resolved;
        // Event subscriptions are synchronous and return an unsubscribe function.
        if (typeof key === "string" && key.startsWith("subscribe"))
          return (): (() => void) => () => undefined;
        return (): Promise<never> =>
          Promise.reject(
            new Error(`mock runtime: ${String(key)} is not available`),
          );
      },
    },
  ) as unknown as UiBackendClient;

  return {
    client,
    ready: Promise.resolve(),
    store,
    catalog,
    draft: createDraftStore(),
    settings,
    retryPermissions: () => undefined,
    retrySession: () => undefined,
    loadEarlierHistory: resolved,
    retryUnknownPrompts: resolved,
    forgetUnknownPrompt: () => undefined,
    abortSession: resolved,
    archiveSession: (id): Promise<void> => {
      sessions = sessions.map((row) =>
        row.id === id
          ? { ...row, status: "archived", updatedAt: new Date().toISOString() }
          : row,
      );
      catalog.removeSession(id);
      return Promise.resolve();
    },
    listArchivedSessions: async (cursor) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (name === "archived-error" && archivedReads++ === 0)
        throw new Error("Can't reach ohbaby. Check that it's still running.");
      const archived = sessions
        .filter((row) => row.status === "archived")
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const offset = Number(cursor ?? 0);
      const next = offset + ARCHIVED_PAGE;
      return {
        sessions: archived.slice(offset, next),
        ...(next < archived.length ? { nextCursor: String(next) } : {}),
      };
    },
    unarchiveSession: async (id): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const row = sessions.find((entry) => entry.id === id);
      if (row?.status !== "archived")
        throw new Error("This chat is no longer archived.");
      // A workspace folder that is gone sends the chat to Recents (D4).
      const available = workspace.scopes.some(
        (scope) => scope.directory === row.workspaceDirectory,
      );
      const restored = {
        ...row,
        status: "active" as const,
        updatedAt: new Date().toISOString(),
        workspaceDirectory: available ? row.workspaceDirectory : null,
      };
      sessions = sessions.map((entry) => (entry.id === id ? restored : entry));
      catalog.upsertSession(restored);
    },
    deleteSession: async (id): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (name === "archived-error")
        throw new Error("The chat couldn't be deleted. Try again.");
      sessions = sessions.filter((row) => row.id !== id);
    },
    moveSession: (id, directory): Promise<void> => {
      const previous = sessions.find((row) => row.id === id);
      if (!previous) return Promise.reject(new Error("Chat no longer exists"));
      const moved = {
        ...previous,
        workspaceDirectory: directory,
        ...(directory === null ? {} : { pendingWorkingDirectory: directory }),
      };
      sessions = sessions.map((row) => (row.id === id ? moved : row));
      catalog.upsertSession(moved);
      return Promise.resolve();
    },
    searchSessions: ({
      query,
      cursor,
      signal,
    }): Promise<UiSessionSearchPage> => {
      if (signal?.aborted)
        return Promise.reject(new DOMException("Aborted", "AbortError"));
      if (query === "error")
        return Promise.reject(new Error("Search is temporarily unavailable."));
      const needle = query.trim().toLowerCase();
      const found: UiSessionSearchResult[] = [];
      for (const session of sessions) {
        if (session.status === "archived") continue;
        const snippet = `A previous message about sidebar layout. <img src=x onerror=alert(1)> stays plain text.`;
        if (session.title.toLowerCase().includes(needle))
          found.push({ session, matchType: "title", snippet: session.title });
        else if (snippet.toLowerCase().includes(needle))
          found.push({ session, matchType: "message", snippet });
      }
      found.sort(
        (a, b) =>
          Number(a.matchType === "message") - Number(b.matchType === "message"),
      );
      const start = Number(cursor ?? 0);
      return Promise.resolve({
        results: found.slice(start, start + 20),
        ...(start + 20 < found.length
          ? { nextCursor: String(start + 20) }
          : {}),
      });
    },
    exportSession: () => Promise.reject(new Error("mock runtime: export")),
    createSession: resolved,
    dispose: resolved,
    executeSlashCommand: () =>
      Promise.reject(new Error("mock runtime: slash commands")),
    getWorkspaceSnapshot: () => workspace,
    getDirectoryPickerRoots: () =>
      Promise.resolve({ ok: true, roots: [{ directory: "/", name: "/" }] }),
    hideWorkspace: (directory): Promise<void> => {
      hidden.add(directory);
      workspace = {
        ...workspace,
        scopes: workspace.scopes.filter(
          (scope) => scope.directory !== directory,
        ),
      };
      catalog.removeWorkspace(directory);
      return Promise.resolve();
    },
    listDirectoryPicker: (directory) =>
      Promise.resolve({ ok: true, directory, parent: null, children: [] }),
    listWebCommands: () => Promise.resolve(MOCK_COMMANDS),
    openDraft: resolved,
    openFolder: (folder) => Promise.resolve(folder),
    openSession: (id): Promise<void> => {
      const row = sessions.find((entry) => entry.id === id);
      if (!row) return Promise.resolve();
      const existing = scenario.snapshot.sessions.find(
        (entry) => entry.id === id,
      );
      installSnapshot(store, {
        ...scenario.snapshot,
        activeSessionId: id,
        status: { kind: "idle" },
        sessions: [{ ...row, messages: existing?.messages ?? [] }],
      });
      return Promise.resolve();
    },
    refreshCatalog: resolved,
    loadMoreSessions,
    selectSession: resolved,
    getSelectionGeneration: () => 0,
    submitPrompt: () =>
      Promise.reject(new Error("mock runtime: prompts are not sent")),
    subscribeWorkspaces: (listener) => catalog.subscribe(listener),
  };
}

function installSnapshot(
  store: ReturnType<typeof createOhbabyWebStore>,
  snapshot: UiSnapshot,
): void {
  const sessionId = snapshot.activeSessionId;
  store.setSessionIndex(
    snapshot.sessions.map(({ messages: _messages, ...entry }) => entry),
  );
  store.setSessionSync({
    status: sessionId ? "ready" : "idle",
    scope: sessionId ? { sessionId, runtimeEpoch: "mock" } : null,
    attempts: 1,
  });
  store.setSessionControl(
    sessionId
      ? {
          sessionId,
          rootSessionId: sessionId,
          runtimeEpoch: "mock",
          runId:
            snapshot.status.kind === "running" ? snapshot.status.runId : null,
          driver: "user",
        }
      : null,
  );
  store.setPermissionSync({
    status: "ready",
    binding: {
      permissionEpoch: "mock",
      rootSessionId: sessionId,
      bindingGeneration: 1,
    },
    requests: snapshot.permissions,
    permissionRevision: 1,
    attempts: 1,
  });
  store.replaceSnapshot(snapshot, 1);
}
