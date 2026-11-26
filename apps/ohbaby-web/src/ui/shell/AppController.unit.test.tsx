// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { UiBackendClient } from "ohbaby-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSnapshot } from "../../api/daemon/wire.js";
import { createMockRuntime } from "../../dev/mock-runtime.js";
import type { OhbabyWebRuntime } from "../../runtime/index.js";
import { OhbabyWebApp } from "../App.js";
import { SessionScreen } from "../session/SessionScreen.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const noFolder: WorkspaceSnapshot = { scopes: [], selectedDirectory: null };
const folder = (directory: string): WorkspaceSnapshot => ({
  scopes: [
    { available: true, directory, lastOpenedAt: 1, loaded: true, position: 0 },
  ],
  selectedDirectory: directory,
});

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

/**
 * The dev mock runtime with a switchable client and workspace, so a test can
 * walk through "no folder → folder opening → connected or failed".
 */
function switchableRuntime(): {
  readonly runtime: OhbabyWebRuntime;
  readonly mockClient: UiBackendClient;
  readonly setState: (
    client: UiBackendClient | null,
    workspace: WorkspaceSnapshot,
  ) => void;
} {
  const base = createMockRuntime("typical");
  const mockClient = base.client;
  if (!mockClient) throw new Error("mock runtime has no client");
  let client: UiBackendClient | null = null;
  let workspace = noFolder;
  const listeners = new Set<() => void>();
  const runtime: OhbabyWebRuntime = {
    ...base,
    get client() {
      return client;
    },
    getWorkspaceSnapshot: () => workspace,
    subscribeWorkspaces: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    runtime,
    mockClient,
    setState: (nextClient, nextWorkspace): void => {
      client = nextClient;
      workspace = nextWorkspace;
      for (const listener of listeners) listener();
    },
  };
}

function mount(runtime: OhbabyWebRuntime): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(<OhbabyWebApp runtime={runtime} />);
  });
  return container;
}

function textarea(container: ParentNode): HTMLTextAreaElement {
  const element = container.querySelector("textarea");
  if (!element) throw new Error("textarea not found");
  return element;
}

function typeText(container: ParentNode, text: string): void {
  const element = textarea(container);
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  );
  act(() => {
    if (descriptor?.set) {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- React controlled inputs need the native textarea setter in jsdom tests.
      const setValue = descriptor.set;
      Reflect.apply(setValue, element, [text]);
    } else {
      element.value = text;
    }
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(container: ParentNode, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) =>
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent === name,
  );
  if (!found) throw new Error(`button not found: ${name}`);
  return found;
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
}

async function openPicker(container: HTMLElement): Promise<void> {
  const trigger = container.querySelector<HTMLButtonElement>(
    ".ohb-workspace-picker",
  );
  if (!trigger) throw new Error("workspace picker not found");
  act(() => {
    trigger.click();
  });
  await settle();
}

describe("AppController new-chat draft", () => {
  it("keeps text typed while no instance is reachable and hands it to the composer", async () => {
    const { runtime, mockClient, setState } = switchableRuntime();
    const container = mount(runtime);
    expect(
      container.querySelector(".ohb-draft-fallback-reason"),
    ).not.toBeNull();

    typeText(container, "Keep this draft");
    act(() => {
      setState(mockClient, folder("/workspace"));
    });
    await settle();

    expect(container.querySelector(".ohb-draft-fallback-reason")).toBeNull();
    expect(textarea(container).value).toBe("Keep this draft");
  });

  it("changes the draft's workspace without touching its text", async () => {
    const { runtime, mockClient, setState } = switchableRuntime();
    setState(mockClient, folder("/Users/demo/Projects/ohbaby-agent"));
    const openDraft = vi.fn((directory?: string | null): Promise<void> => {
      runtime.draft.setWorkspace(directory ?? null);
      return Promise.resolve();
    });
    runtime.openDraft = openDraft;
    const container = mount(runtime);
    typeText(container, "Same words");
    expect(button(container, "Workspace: No workspace")).toBeTruthy();

    await openPicker(container);
    await act(async () => {
      const menu = document.querySelector('[role="menu"]');
      if (!menu) throw new Error("picker menu not open");
      button(menu, "pi-web").click();
      await Promise.resolve();
    });
    await settle();

    expect(openDraft).toHaveBeenCalledWith("/Users/demo/Projects/pi-web");
    expect(button(container, "Workspace: pi-web")).toBeTruthy();
    expect(textarea(container).value).toBe("Same words");
  });

  it("selects a folder opened from the picker and keeps the text", async () => {
    const { runtime, mockClient, setState } = switchableRuntime();
    setState(mockClient, folder("/workspace"));
    const openFolder = vi.fn((directory: string) => Promise.resolve(directory));
    const openDraft = vi.fn((): Promise<void> => Promise.resolve());
    runtime.openFolder = openFolder;
    runtime.openDraft = openDraft;
    const container = mount(runtime);
    typeText(container, "Question for the new folder");

    await openPicker(container);
    act(() => {
      const menu = document.querySelector('[role="menu"]');
      if (!menu) throw new Error("picker menu not open");
      button(menu, "Open folder…").click();
    });
    await settle();
    act(() => {
      button(container, "/").click();
    });
    await settle();
    await act(async () => {
      button(container, "Choose this folder").click();
      await Promise.resolve();
    });
    await settle();

    expect(openFolder).toHaveBeenCalledWith("/");
    expect(openDraft).toHaveBeenCalledWith("/");
    expect(textarea(container).value).toBe("Question for the new folder");
  });

  it("only registers a folder opened from the sidebar; the current place stays", async () => {
    const { runtime, mockClient, setState } = switchableRuntime();
    setState(mockClient, folder("/workspace"));
    const openFolder = vi.fn((directory: string) => Promise.resolve(directory));
    const openDraft = vi.fn((): Promise<void> => Promise.resolve());
    runtime.openFolder = openFolder;
    runtime.openDraft = openDraft;
    const container = mount(runtime);

    act(() => {
      const sidebar = container.querySelector(".ohb-sidebar");
      if (!sidebar) throw new Error("sidebar missing");
      button(sidebar, "Open folder…").click();
    });
    await settle();
    act(() => {
      button(container, "/").click();
    });
    await settle();
    await act(async () => {
      button(container, "Choose this folder").click();
      await Promise.resolve();
    });
    await settle();

    expect(openFolder).toHaveBeenCalledWith("/");
    expect(openDraft).not.toHaveBeenCalled();
  });

  it("shows no workspace picker once a session is open", async () => {
    const runtime = createMockRuntime("running");
    const container = mount(runtime);
    await settle();
    expect(container.querySelector(".ohb-workspace-picker")).toBeNull();
  });

  it("does not show a connection state when there is no instance to connect to", () => {
    const { runtime } = switchableRuntime();
    runtime.store.setConnectionState("connecting");
    const container = mount(runtime);

    expect(container.querySelector(".ohb-connection-state")).toBeNull();
  });
});

describe("AppController on a narrow window", () => {
  it("closes the sidebar drawer after a session is chosen", async () => {
    vi.stubGlobal(
      "matchMedia",
      (query: string): Partial<MediaQueryList> => ({
        matches: query.includes("max-width"),
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    );
    const { runtime, mockClient, setState } = switchableRuntime();
    setState(mockClient, folder("/Users/demo/Projects/ohbaby-agent"));
    const container = mount(runtime);
    const shell = (): Element | null => container.querySelector(".ohb-shell");

    expect(shell()?.classList.contains("is-sidebar-open")).toBe(false);
    act(() => {
      button(container, "Open sidebar").click();
    });
    expect(shell()?.classList.contains("is-sidebar-open")).toBe(true);

    act(() => {
      button(container, "Select Refactor the session sidebar").click();
    });
    expect(shell()?.classList.contains("is-sidebar-open")).toBe(false);
    await settle();
  });
});

describe("dev mock runtime", () => {
  it("returns synchronous unsubscribe functions for event subscriptions", () => {
    const client = createMockRuntime("running").client;
    const unsubscribe = client?.subscribeEvents(() => undefined);
    expect(typeof unsubscribe).toBe("function");
  });
});

describe("improve-3 sidebar actions", () => {
  it("opens the search card with Cmd/Ctrl+K without opening a collapsed sidebar", () => {
    const container = mount(createMockRuntime("typical"));
    act(() => {
      button(container, "Collapse sidebar").click();
    });
    act(() => {
      textarea(container).focus();
    });
    const shortcut = (modifier: "ctrlKey" | "metaKey"): void => {
      act(() => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "k",
            [modifier]: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    };
    shortcut("ctrlKey");
    expect(
      container
        .querySelector(".ohb-shell")
        ?.classList.contains("is-sidebar-open"),
    ).toBe(false);
    const search = (): HTMLInputElement | null =>
      document.querySelector<HTMLInputElement>('[role="combobox"]');
    const input = search();
    if (!input) throw new Error("Missing search input");
    expect(input.closest('[role="dialog"]')?.getAttribute("aria-modal")).toBe(
      "true",
    );
    expect(document.activeElement).toBe(input);
    // A second shortcut while the card is open opens nothing new.
    shortcut("metaKey");
    expect(document.querySelectorAll('[role="combobox"]')).toHaveLength(1);
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(search()).toBeNull();
    expect(document.activeElement).toBe(textarea(container));
  });

  it("releases a search anchor in live messages as soon as a new prompt is sent", async () => {
    const runtime = createMockRuntime("running");
    const client = runtime.client;
    const session = runtime.store.getSnapshot().sessionSync.view?.session;
    const anchor = session?.messages[0];
    if (!client || !session || !anchor)
      throw new Error("Missing running chat fixture");
    const submit = vi.spyOn(runtime, "submitPrompt").mockImplementation(
      () =>
        new Promise(() => {
          // Keep the daemon receipt pending until after the follow assertion.
        }),
    );
    const clearLocation = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    act(() => {
      root.render(
        <SessionScreen
          runtime={runtime}
          client={client}
          location={{
            sessionId: session.id,
            messageId: anchor.id,
            ticket: 1,
            selection: runtime.getSelectionGeneration(),
          }}
          clearLocation={clearLocation}
          onOpenModelSettings={vi.fn()}
          onError={vi.fn()}
        />,
      );
    });
    expect(
      container.querySelector(`[data-message-id="${anchor.id}"]`),
    ).toBeTruthy();
    expect(clearLocation).not.toHaveBeenCalled();
    typeText(container, "Follow this new prompt");
    act(() => {
      button(container, "Send message").click();
    });
    await settle();
    expect(submit).toHaveBeenCalledOnce();
    expect(clearLocation).toHaveBeenCalledOnce();
  });

  it("opens a search result in another chat, displays its old message, and returns to the live conversation", async () => {
    vi.useFakeTimers();
    try {
      const runtime = createMockRuntime("typical");
      const container = mount(runtime);
      act(() => {
        button(container, "Search chats").click();
      });
      const input =
        document.querySelector<HTMLInputElement>('[role="combobox"]');
      const descriptor = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      );
      if (!input) throw new Error("Missing search input");
      act(() => {
        descriptor?.set?.call(input, "sidebar layout");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      const result = document.querySelector<HTMLElement>(".ohb-search-row");
      if (!result) throw new Error("Missing search result");
      act(() => {
        result.click();
      });
      await settle();
      const id = runtime.store.getSnapshot().sessionSync.scope?.sessionId;
      expect(id).toBeTruthy();
      const row = container.querySelector(
        `[data-message-id="${id ?? ""}-message"]`,
      );
      expect(row?.textContent).toContain(
        "A previous message about sidebar layout.",
      );
      act(() => {
        button(container, "Back to latest").click();
      });
      expect(container.contains(row)).toBe(false);
      expect(runtime.store.getSnapshot().sessionSync.scope?.sessionId).toBe(id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns focus to the Search button after the card closes", () => {
    const container = mount(createMockRuntime("typical"));
    act(() => {
      button(container, "Search chats").focus();
      button(container, "Search chats").click();
    });
    const layer = document.querySelector(".ohb-search-layer");
    if (!layer) throw new Error("Missing search layer");
    act(() => {
      layer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(document.querySelector('[role="combobox"]')).toBeNull();
    expect(document.activeElement).toBe(button(container, "Search chats"));
  });

  it("keeps the row and reports the backend reason when moving fails", async () => {
    const runtime = createMockRuntime("typical");
    const container = mount({
      ...runtime,
      moveSession: () =>
        Promise.reject(new Error("Workspace folder is not readable.")),
    });
    act(() => {
      button(container, "Actions for Refactor the session sidebar").click();
    });
    act(() => {
      button(document, "Move to workspace…").click();
    });
    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          '[role="menuitem"][title="/Users/demo/Projects/pi-web"]',
        )
        ?.click();
    });
    await settle();
    expect(container.textContent).toContain(
      "Workspace folder is not readable.",
    );
    expect(
      button(container, "Select Refactor the session sidebar").closest(
        ".ohb-workspace-group",
      )?.textContent,
    ).toContain("ohbaby-agent");
    expect(container.querySelector('[aria-label="Moving chat"]')).toBeNull();
  });
});

it("shows one actionable notice for repeated failures to open a chat and animates it out", async () => {
  const runtime = createMockRuntime("typical");
  runtime.openSession = vi.fn().mockRejectedValue(
    Object.assign(new Error("Internal directory validation failed"), {
      status: 400,
      code: "directory-unavailable",
    }),
  );
  vi.useFakeTimers();
  try {
    const container = mount(runtime);
    const select = button(container, "Select Refactor the session sidebar");
    await act(async () => {
      select.click();
      select.click();
      await Promise.resolve();
    });
    const notices = (): NodeListOf<Element> =>
      container.querySelectorAll(".ohb-notice-stack .ohb-banner");
    expect(notices()).toHaveLength(1);
    expect(notices()[0].textContent).toContain("Move to workspace");
    expect(notices()[0].textContent).not.toContain("Internal directory");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(container.querySelector(".ohb-notice.is-exiting")).not.toBeNull();
    expect(notices()).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(notices()).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps a notice open until both the pointer and keyboard focus leave it", async () => {
  const runtime = createMockRuntime("typical");
  runtime.openSession = vi
    .fn()
    .mockRejectedValue(new Error("Session not found"));
  vi.useFakeTimers();
  try {
    const container = mount(runtime);
    await act(async () => {
      button(container, "Select Refactor the session sidebar").click();
      await Promise.resolve();
    });
    const notice = container.querySelector(".ohb-notice");
    if (!(notice instanceof HTMLElement)) throw new Error("No notice shown");
    act(() => {
      notice.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(notice.classList.contains("is-exiting")).toBe(false);

    const dismiss = button(notice, "Dismiss");
    act(() => {
      dismiss.focus();
      notice.dispatchEvent(
        new MouseEvent("mouseout", {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(notice.classList.contains("is-exiting")).toBe(false);

    act(() => {
      dismiss.blur();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(notice.classList.contains("is-exiting")).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(container.querySelector(".ohb-notice")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
