// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  UiCompactSessionUsage,
  UiRunStatus,
  UiSnapshot,
  UiWebCommandCatalog,
} from "ohbaby-sdk";
import type {
  OhbabyWebClient,
  OhbabyWebRuntime,
} from "../api/daemon/client.js";
import { createOhbabyWebStore } from "../store/store.js";
import type { OhbabyWebStore } from "../store/store.js";
import { OhbabyWebApp } from "./App.js";

const timestamp = "2026-06-12T00:00:00.000Z";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

interface MountedApp {
  readonly container: HTMLDivElement;
  readonly root: Root;
}

interface FakeRuntime {
  readonly compactSession: ReturnType<
    typeof vi.fn<OhbabyWebClient["compactSession"]>
  >;
  readonly createSession: ReturnType<
    typeof vi.fn<OhbabyWebClient["createSession"]>
  >;
  readonly executeSlashCommand: ReturnType<
    typeof vi.fn<OhbabyWebClient["executeSlashCommand"]>
  >;
  readonly connectModel: ReturnType<
    typeof vi.fn<OhbabyWebClient["connectModel"]>
  >;
  readonly listCommands: ReturnType<
    typeof vi.fn<OhbabyWebClient["listCommands"]>
  >;
  readonly runtime: OhbabyWebRuntime;
  readonly selectSession: ReturnType<
    typeof vi.fn<OhbabyWebClient["selectSession"]>
  >;
  readonly setPermission: ReturnType<
    typeof vi.fn<OhbabyWebClient["setPermission"]>
  >;
  readonly setSearchApiKey: ReturnType<
    typeof vi.fn<OhbabyWebClient["setSearchApiKey"]>
  >;
  readonly store: OhbabyWebStore;
}

const mountedApps: MountedApp[] = [];

afterEach(() => {
  for (const app of mountedApps.splice(0)) {
    act(() => {
      app.root.unmount();
    });
    app.container.remove();
  }
});

describe("OhbabyWebApp slash command interactions", () => {
  it("does not open or execute the slash palette while the composer cannot send", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "running", runId: "run_1" }),
    });
    fake.listCommands.mockResolvedValue(catalog(["status"]));
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "/");

    expect(fake.listCommands).not.toHaveBeenCalled();
    expect(app.container.querySelector(".ohb-slash-palette")).toBeNull();
  });

  it("refreshes an already-open slash palette after the command catalog changes", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    const nextCatalog = deferred<UiWebCommandCatalog>();
    fake.listCommands
      .mockResolvedValueOnce(catalog(["status"]))
      .mockReturnValueOnce(nextCatalog.promise);
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "/");
    await waitFor(() => fake.listCommands.mock.calls.length === 1);
    expect(slashPaletteText(app.container)).toContain("/status");

    await act(async () => {
      fake.store.applyEvent(
        {
          reason: "test",
          timestamp: Date.parse(timestamp),
          type: "command.catalog.updated",
          version: "commands-v2",
        },
        2,
      );
      await Promise.resolve();
    });

    await waitFor(() => fake.listCommands.mock.calls.length === 2);
    expect(slashPaletteText(app.container)).not.toContain("/status");
    nextCatalog.resolve(catalog(["skills"]));
    await waitFor(() => slashPaletteText(app.container).includes("/skills"));
    expect(slashPaletteText(app.container)).not.toContain("/status");
    expect(slashPaletteText(app.container)).toContain("/skills");
  });

  it("moves slash selection with PageDown and PageUp", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    fake.listCommands.mockResolvedValue(catalog(["skills", "status"]));
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "/");
    await waitFor(() => slashCompletionText(app.container).includes("/skills"));

    await pressTextareaKey(app.container, "PageDown");
    expect(slashCompletionText(app.container)).toContain("/status");

    await pressTextareaKey(app.container, "PageUp");
    expect(slashCompletionText(app.container)).toContain("/skills");
  });

  it("keeps slash rows on the same grid when argsHint is absent", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    fake.listCommands.mockResolvedValue(catalog(["status"]));
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "/");
    await waitFor(() => slashPaletteText(app.container).includes("/status"));

    const row = app.container.querySelector(".ohb-slash-row");
    expect(row?.querySelector(".ohb-slash-args")).not.toBeNull();
    expect(row?.querySelector(".ohb-slash-description")?.textContent).toBe(
      "Show backend status",
    );
  });

  it("cycles permission policy directly without opening a menu", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    const app = mountApp(fake.runtime);

    await clickButton(app.container, "Permission policy");

    expect(fake.setPermission).toHaveBeenCalledWith({ level: "full-access" });
    expect(app.container.querySelector(".ohb-policy-menu")).toBeNull();
  });

  it("creates and selects sessions from the sidebar", async () => {
    const first = snapshotWithStatus({ kind: "idle" }).sessions[0];
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "idle" }),
        activeSessionId: "session_1",
        sessions: [
          first,
          {
            createdAt: timestamp,
            id: "session_2",
            messages: [],
            title: "Session 2",
            updatedAt: "2026-06-13T00:00:00.000Z",
          },
        ],
      },
    });
    const app = mountApp(fake.runtime);

    expect(app.container.querySelector(".ohb-sidebar")).not.toBeNull();
    expect(
      app.container.querySelector('button[title="Select Session 2"]')
        ?.textContent,
    ).not.toContain("0 messages");

    await clickButton(app.container, "New session");
    await clickButton(app.container, "Select Session 2");

    expect(fake.createSession).toHaveBeenCalledTimes(1);
    expect(fake.selectSession).toHaveBeenCalledWith("session_2");
  });

  it("selects the first listed sidebar session when no session is active", async () => {
    const first = snapshotWithStatus({ kind: "idle" }).sessions[0];
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "idle" }),
        activeSessionId: null,
        sessions: [first],
      },
    });
    const app = mountApp(fake.runtime);

    await clickButton(app.container, "Select Session");

    expect(fake.selectSession).toHaveBeenCalledWith("session_1");
  });

  it("loads the selected sidebar session transcript from an empty active state", async () => {
    const first = snapshotWithStatus({ kind: "idle" }).sessions[0];
    const selectedSnapshot: UiSnapshot = {
      ...snapshotWithStatus({ kind: "idle" }),
      activeSessionId: "session_1",
      sessions: [
        {
          ...first,
          messages: [
            {
              createdAt: timestamp,
              id: "message_user",
              parts: [{ text: "resume this session", type: "text" }],
              role: "user",
            },
            {
              createdAt: timestamp,
              id: "message_assistant",
              parts: [{ text: "loaded transcript", type: "text" }],
              role: "assistant",
            },
          ],
        },
      ],
    };
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "idle" }),
        activeSessionId: null,
        sessions: [first],
      },
    });
    fake.selectSession.mockImplementationOnce(() => {
      fake.store.replaceSnapshot(selectedSnapshot, 2);
      return Promise.resolve();
    });
    const app = mountApp(fake.runtime);

    expect(app.container.textContent).not.toContain("loaded transcript");

    await clickButton(app.container, "Select Session");

    await waitFor(() =>
      app.container.textContent.includes("loaded transcript"),
    );
    expect(app.container.textContent).toContain("resume this session");
    expect(fake.selectSession).toHaveBeenCalledWith("session_1");
  });

  it("opens the structured connect overlay from the slash palette", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    fake.listCommands.mockResolvedValue(catalog(["connect", "status"]));
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "/");
    await waitFor(() => slashPaletteText(app.container).includes("/connect"));
    await pressTextareaKey(app.container, "Enter");
    await waitFor(() =>
      Boolean(app.container.querySelector(".ohb-structured-overlay")),
    );

    await setInputValue(app.container, "Provider", "zhipu");
    await setInputValue(
      app.container,
      "Base URL",
      "https://open.bigmodel.cn/api/paas/v4",
    );
    await setInputValue(app.container, "API key env", "ZHIPU_API_KEY");
    await setInputValue(app.container, "Model", "glm-4.7");
    await clickButton(app.container, "Save model");

    expect(fake.connectModel).toHaveBeenCalledWith({
      apiKeyEnv: "ZHIPU_API_KEY",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      model: "glm-4.7",
      provider: "zhipu",
    });
    expect(fake.executeSlashCommand).not.toHaveBeenCalled();
  });

  it("opens the structured search overlay from the slash palette", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    fake.listCommands.mockResolvedValue(catalog(["connect-search"]));
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "/");
    await waitFor(() =>
      slashPaletteText(app.container).includes("/connect-search"),
    );
    await pressTextareaKey(app.container, "Enter");
    await waitFor(() =>
      Boolean(app.container.querySelector(".ohb-structured-overlay")),
    );

    await setInputValue(app.container, "API key env", "TAVILY_API_KEY");
    await setInputValue(app.container, "API key", "tvly-test");
    await clickButton(app.container, "Save search key");

    expect(fake.setSearchApiKey).toHaveBeenCalledWith({
      apiKey: "tvly-test",
      apiKeyEnv: "TAVILY_API_KEY",
      provider: "tavily",
    });
    expect(fake.executeSlashCommand).not.toHaveBeenCalled();
  });

  it("opens the structured compact overlay from the slash palette", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    fake.listCommands.mockResolvedValue(catalog(["compact"]));
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "/");
    await waitFor(() => slashPaletteText(app.container).includes("/compact"));
    await pressTextareaKey(app.container, "Enter");
    await waitFor(() =>
      Boolean(app.container.querySelector(".ohb-structured-overlay")),
    );
    await clickButton(app.container, "Compact session");

    expect(fake.compactSession).toHaveBeenCalledWith("session_1", {
      force: true,
    });
    expect(fake.executeSlashCommand).not.toHaveBeenCalled();
  });

  it("shows compact failures as overlay errors", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    fake.listCommands.mockResolvedValue(catalog(["compact"]));
    fake.compactSession.mockResolvedValueOnce({
      error: "summary failed",
      sessionId: "session_1",
      status: "failed",
      usageAfter: compactUsage(16_000),
      usageBefore: compactUsage(16_000),
    });
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "/");
    await waitFor(() => slashPaletteText(app.container).includes("/compact"));
    await pressTextareaKey(app.container, "Enter");
    await waitFor(() =>
      Boolean(app.container.querySelector(".ohb-structured-overlay")),
    );
    await clickButton(app.container, "Compact session");

    await waitFor(() =>
      Boolean(app.container.querySelector(".ohb-structured-error")),
    );
    expect(
      app.container.querySelector(".ohb-structured-error")?.textContent,
    ).toContain("summary failed");
    expect(app.container.querySelector(".ohb-structured-success")).toBeNull();
  });
});

function mountApp(runtime: OhbabyWebRuntime): MountedApp {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(<OhbabyWebApp runtime={runtime} />);
  });
  const app = { container, root };
  mountedApps.push(app);
  return app;
}

function createFakeRuntime(input: {
  readonly snapshot: UiSnapshot;
}): FakeRuntime {
  const store = createOhbabyWebStore();
  store.replaceSnapshot(input.snapshot, 1);
  store.setConnectionState("live");
  const executeSlashCommand = vi.fn<OhbabyWebClient["executeSlashCommand"]>(
    () => Promise.resolve(),
  );
  const createSession = vi.fn<OhbabyWebClient["createSession"]>(() =>
    Promise.resolve(),
  );
  const selectSession = vi.fn<OhbabyWebClient["selectSession"]>(() =>
    Promise.resolve(),
  );
  const connectModel = vi.fn<OhbabyWebClient["connectModel"]>(() =>
    Promise.resolve({
      apiKeyEnv: "ZHIPU_API_KEY",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      contextWindowSource: "default",
      contextWindowTokens: 128_000,
      envPath: ".env",
      interfaceProvider: "openai-compatible",
      model: "glm-4.7",
      modelJsonPath: "model.json",
      provider: "zhipu",
      saved: true,
    }),
  );
  const listCommands = vi.fn<OhbabyWebClient["listCommands"]>(() =>
    Promise.resolve(catalog(["status"])),
  );
  const setPermission = vi.fn<OhbabyWebClient["setPermission"]>(() =>
    Promise.resolve(),
  );
  const compactSession = vi.fn<OhbabyWebClient["compactSession"]>(() =>
    Promise.resolve({
      sessionId: "session_1",
      status: "compacted",
      usageAfter: compactUsage(8_000),
      usageBefore: compactUsage(16_000),
    }),
  );
  const setSearchApiKey = vi.fn<OhbabyWebClient["setSearchApiKey"]>(() =>
    Promise.resolve({
      apiKeyEnv: "TAVILY_API_KEY",
      envPath: ".env",
      provider: "tavily",
      searchJsonPath: "search.json",
    }),
  );
  const client: OhbabyWebClient = {
    abortSession: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    compactSession,
    connect: vi.fn(() => Promise.resolve()),
    connectModel,
    createSession,
    executeSlashCommand,
    getContextWindowUsage: vi.fn(() =>
      Promise.resolve({
        contextWindowRatio: 0.125,
        contextWindowTokens: 128_000,
        currentTokens: 16_000,
        estimatedAt: timestamp,
        modelId: "glm-4.7",
        sessionId: "session_1",
      }),
    ),
    getCurrentModel: vi.fn(() => Promise.resolve(null)),
    getSnapshot: () => store.getSnapshot(),
    listCommands,
    probeModelContextWindow: vi.fn(() =>
      Promise.resolve({
        contextWindowSource: "default" as const,
        contextWindowTokens: 128_000,
      }),
    ),
    respondPermission: vi.fn(() => Promise.resolve()),
    selectSession,
    setPermission,
    setSearchApiKey,
    submitPrompt: vi.fn(() => Promise.resolve()),
    subscribe: (listener) => store.subscribe(listener),
  };
  return {
    compactSession,
    connectModel,
    createSession,
    executeSlashCommand,
    listCommands,
    runtime: {
      client,
      ready: Promise.resolve(),
      store,
    },
    selectSession,
    setPermission,
    setSearchApiKey,
    store,
  };
}

function snapshotWithStatus(status: UiRunStatus): UiSnapshot {
  const run =
    status.kind === "running"
      ? [
          {
            id: status.runId,
            sessionId: "session_1",
            startedAt: timestamp,
            status,
            updatedAt: timestamp,
          },
        ]
      : [];
  return {
    activeSessionId: "session_1",
    permission: {
      level: "default",
      mode: "auto",
      sessionRules: [],
    },
    permissions: [],
    runs: run,
    sessions: [
      {
        createdAt: timestamp,
        id: "session_1",
        messages:
          status.kind === "running"
            ? [
                {
                  createdAt: timestamp,
                  id: "message_1",
                  parts: [{ text: "hello", type: "text" }],
                  role: "user",
                },
              ]
            : [],
        title: "Session",
        updatedAt: timestamp,
      },
    ],
    status,
  };
}

function catalog(ids: readonly CatalogId[]): UiWebCommandCatalog {
  return {
    commands: ids.map((id) => ({
      action: catalogAction(id),
      argumentMode: catalogArgumentMode(id),
      category: catalogCategory(id),
      description:
        id === "skills"
          ? "List available skills"
          : id === "connect"
            ? "Connect model"
            : id === "connect-search"
              ? "Connect search"
              : id === "compact"
                ? "Compact session"
                : "Show backend status",
      executionKind:
        id === "status" || id === "skills" ? "passthrough" : "overlay",
      id,
      path: [id],
      source: "builtin",
      surfaces: ["tui"],
    })),
    version: ids.join("-"),
  };
}

type CatalogId = "compact" | "connect" | "connect-search" | "skills" | "status";

function catalogAction(
  id: CatalogId,
): UiWebCommandCatalog["commands"][number]["action"] {
  switch (id) {
    case "compact":
      return "compactSession";
    case "connect":
      return "connectModel";
    case "connect-search":
      return "connectSearch";
    case "skills":
    case "status":
      return "executeCommand";
  }
}

function catalogArgumentMode(
  id: CatalogId,
): UiWebCommandCatalog["commands"][number]["argumentMode"] {
  return id === "skills" || id === "status" ? "argv" : "structured";
}

function catalogCategory(id: CatalogId): string {
  switch (id) {
    case "compact":
      return "session";
    case "connect":
    case "connect-search":
      return "setup";
    case "skills":
      return "skill";
    case "status":
      return "system";
  }
}

function compactUsage(currentTokens: number): UiCompactSessionUsage {
  return {
    contextLimit: 128_000,
    currentTokens,
    modelId: "glm-4.7",
    remainingTokens: 128_000 - currentTokens,
    shouldCompress: false,
    usageRatio: currentTokens / 128_000,
  };
}

async function setTextareaValue(
  container: ParentNode,
  value: string,
): Promise<void> {
  const textarea = container.querySelector("textarea");
  if (!(textarea instanceof HTMLTextAreaElement)) {
    throw new Error("textarea not found");
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  );
  await act(async () => {
    if (descriptor?.set) {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- React controlled inputs need the native textarea setter in jsdom tests.
      const setValue = descriptor.set;
      Reflect.apply(setValue, textarea, [value]);
    } else {
      textarea.value = value;
    }
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error("condition was not met before timeout");
}

function slashPaletteText(container: ParentNode): string {
  return container.querySelector(".ohb-slash-palette")?.textContent ?? "";
}

function slashCompletionText(container: ParentNode): string {
  return container.querySelector(".ohb-slash-completion")?.textContent ?? "";
}

async function pressTextareaKey(
  container: ParentNode,
  key: string,
): Promise<void> {
  const textarea = container.querySelector("textarea");
  if (!(textarea instanceof HTMLTextAreaElement)) {
    throw new Error("textarea not found");
  }
  await act(async () => {
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key }),
    );
    await Promise.resolve();
  });
}

async function clickButton(
  container: ParentNode,
  title: string,
): Promise<void> {
  const button = container.querySelector(`button[title="${title}"]`);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`button not found: ${title}`);
  }
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

async function setInputValue(
  container: ParentNode,
  labelText: string,
  value: string,
): Promise<void> {
  const labels = Array.from(container.querySelectorAll("label"));
  const label = labels.find(
    (candidate) => candidate.querySelector("span")?.textContent === labelText,
  );
  const input = label?.querySelector("input");
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`input not found: ${labelText}`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  );
  await act(async () => {
    if (descriptor?.set) {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- React controlled inputs need the native input setter in jsdom tests.
      const setValue = descriptor.set;
      Reflect.apply(setValue, input, [value]);
    } else {
      input.value = value;
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
