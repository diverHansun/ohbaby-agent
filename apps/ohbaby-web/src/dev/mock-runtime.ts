import type { UiBackendClient, UiSnapshot } from "ohbaby-sdk";
import type { OhbabyWebRuntime } from "../runtime/index.js";
import { createDraftStore } from "../store/draft.js";
import { createGlobalCatalogStore } from "../store/global-catalog.js";
import { createOhbabyWebStore } from "../store/store.js";
import { globalSessionPinsKey } from "../ui/sidebar/session-pins.js";
import { DEFAULT_WORKSPACE, mockScenarios } from "./mock-scenarios.js";

const MOCK_PAGE = 100;

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
 * calls resolve without effect; anything else rejects with a clear message.
 */
export function createMockRuntime(name: string): OhbabyWebRuntime {
  const scenario = (mockScenarios[name] ?? mockScenarios.typical)();
  const store = createOhbabyWebStore();
  installSnapshot(store, scenario.snapshot);
  store.setCurrentModel(scenario.model);
  store.setConnectionState("live");
  const catalog = createGlobalCatalogStore();
  catalog.setProjects(scenario.workspace.scopes, DEFAULT_WORKSPACE);
  const page = (offset: number): void => {
    const rows = scenario.sessions.slice(offset, offset + MOCK_PAGE);
    const next = offset + MOCK_PAGE;
    const cursor = next < scenario.sessions.length ? String(next) : undefined;
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
  const client = new Proxy<Record<string, unknown>>(
    {},
    {
      get(_target, key): unknown {
        if (key === "then") return undefined;
        if (key === "listCommands")
          return (): Promise<unknown> =>
            Promise.resolve({ commands: [], version: "mock" });
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
    retryPermissions: () => undefined,
    retrySession: () => undefined,
    loadEarlierHistory: resolved,
    retryUnknownPrompts: resolved,
    forgetUnknownPrompt: () => undefined,
    abortSession: resolved,
    archiveSession: resolved,
    exportSession: () => Promise.reject(new Error("mock runtime: export")),
    createSession: resolved,
    dispose: resolved,
    executeSlashCommand: () =>
      Promise.reject(new Error("mock runtime: slash commands")),
    getWorkspaceSnapshot: () => scenario.workspace,
    getDirectoryPickerRoots: () =>
      Promise.resolve({ ok: true, roots: [{ directory: "/", name: "/" }] }),
    hideWorkspace: resolved,
    listDirectoryPicker: (directory) =>
      Promise.resolve({ ok: true, directory, parent: null, children: [] }),
    listWebCommands: () => Promise.resolve({ commands: [], version: "mock" }),
    openDraft: resolved,
    openFolder: (folder) => Promise.resolve(folder),
    openSession: resolved,
    refreshCatalog: resolved,
    loadMoreSessions,
    selectSession: resolved,
    submitPrompt: () =>
      Promise.reject(new Error("mock runtime: prompts are not sent")),
    subscribeWorkspaces: () => () => undefined,
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
