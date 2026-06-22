// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  UiRunStatus,
  UiSnapshot,
  UiSlashCommandCatalog,
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
  readonly executeSlashCommand: ReturnType<
    typeof vi.fn<OhbabyWebClient["executeSlashCommand"]>
  >;
  readonly listCommands: ReturnType<
    typeof vi.fn<OhbabyWebClient["listCommands"]>
  >;
  readonly runtime: OhbabyWebRuntime;
  readonly setPermission: ReturnType<
    typeof vi.fn<OhbabyWebClient["setPermission"]>
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
    const nextCatalog = deferred<UiSlashCommandCatalog>();
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

  it("cycles permission policy directly without opening a menu", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    const app = mountApp(fake.runtime);

    await clickButton(app.container, "Permission policy");

    expect(fake.setPermission).toHaveBeenCalledWith({ level: "full-access" });
    expect(app.container.querySelector(".ohb-policy-menu")).toBeNull();
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
  const listCommands = vi.fn<OhbabyWebClient["listCommands"]>(() =>
    Promise.resolve(catalog(["status"])),
  );
  const setPermission = vi.fn<OhbabyWebClient["setPermission"]>(() =>
    Promise.resolve(),
  );
  const client: OhbabyWebClient = {
    abortSession: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    connect: vi.fn(() => Promise.resolve()),
    executeSlashCommand,
    getSnapshot: () => store.getSnapshot(),
    listCommands,
    respondPermission: vi.fn(() => Promise.resolve()),
    setPermission,
    submitPrompt: vi.fn(() => Promise.resolve()),
    subscribe: (listener) => store.subscribe(listener),
  };
  return {
    executeSlashCommand,
    listCommands,
    runtime: {
      client,
      ready: Promise.resolve(),
      store,
    },
    setPermission,
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

function catalog(ids: readonly ("skills" | "status")[]): UiSlashCommandCatalog {
  return {
    commands: ids.map((id) => ({
      argumentMode: "argv",
      category: id === "skills" ? "skill" : "system",
      description:
        id === "skills" ? "List available skills" : "Show backend status",
      id,
      path: [id],
      source: "builtin",
      surfaces: ["tui"],
    })),
    version: ids.join("-"),
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
