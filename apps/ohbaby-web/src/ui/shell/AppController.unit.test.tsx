// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { UiBackendClient } from "ohbaby-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSnapshot } from "../../api/daemon/wire.js";
import { createMockRuntime } from "../../dev/mock-runtime.js";
import type { OhbabyWebRuntime } from "../../runtime/index.js";
import { OhbabyWebApp } from "../App.js";

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
    ".ohb-project-picker",
  );
  if (!trigger) throw new Error("project picker not found");
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

  it("changes the draft's project without touching its text", async () => {
    const { runtime, mockClient, setState } = switchableRuntime();
    setState(mockClient, folder("/Users/demo/Projects/ohbaby-agent"));
    const openDraft = vi.fn((directory?: string | null): Promise<void> => {
      runtime.draft.setProject(directory ?? null);
      return Promise.resolve();
    });
    runtime.openDraft = openDraft;
    const container = mount(runtime);
    typeText(container, "Same words");
    expect(button(container, "Project: No project")).toBeTruthy();

    await openPicker(container);
    await act(async () => {
      button(document.body, "pi-web").click();
      await Promise.resolve();
    });
    await settle();

    expect(openDraft).toHaveBeenCalledWith("/Users/demo/Projects/pi-web");
    expect(button(container, "Project: pi-web")).toBeTruthy();
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
      button(document.body, "Open folder…").click();
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

  it("shows no project picker once a session is open", () => {
    const runtime = createMockRuntime("running");
    const container = mount(runtime);
    expect(container.querySelector(".ohb-project-picker")).toBeNull();
  });

  it("does not show a connection state when there is no instance to connect to", () => {
    const { runtime } = switchableRuntime();
    runtime.store.setConnectionState("connecting");
    const container = mount(runtime);

    expect(container.querySelector(".ohb-connection-state")).toBeNull();
  });
});

describe("AppController on a narrow window", () => {
  it("closes the sidebar drawer after a session is chosen", () => {
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
  });
});

describe("dev mock runtime", () => {
  it("returns synchronous unsubscribe functions for event subscriptions", () => {
    const client = createMockRuntime("running").client;
    const unsubscribe = client?.subscribeEvents(() => undefined);
    expect(typeof unsubscribe).toBe("function");
  });
});
