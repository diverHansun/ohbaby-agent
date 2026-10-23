// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { UiBackendClient } from "ohbaby-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSnapshot } from "../../api/daemon/wire.js";
import { createMockRuntime } from "../../dev/mock-runtime.js";
import type { OhbabyWebRuntime } from "../../runtime.js";
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

async function chooseFolder(container: HTMLElement): Promise<void> {
  act(() => {
    button(container, "Open folder…").click();
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
}

describe("AppController without an open folder", () => {
  it("keeps the folderless draft when connecting to the chosen folder fails", async () => {
    const { runtime, mockClient, setState } = switchableRuntime();
    let failConnect: (error: Error) => void = () => undefined;
    runtime.openWorkspace = (directory): Promise<void> =>
      new Promise<void>((_resolve, reject) => {
        // The real runtime creates the client before it connects.
        setState(mockClient, folder(directory));
        failConnect = (error): void => {
          setState(null, noFolder);
          reject(error);
        };
      });
    const container = mount(runtime);

    typeText(container, "Keep this draft");
    await chooseFolder(container);
    expect(textarea(container).value).toBe("Keep this draft");

    await act(async () => {
      failConnect(new Error("connect failed"));
      await Promise.resolve();
    });
    await settle();

    expect(container.querySelector(".ohb-composer-hero textarea")).toBe(
      textarea(container),
    );
    expect(textarea(container).value).toBe("Keep this draft");
  });

  it("hands the draft over once the folder opened successfully", async () => {
    const { runtime, mockClient, setState } = switchableRuntime();
    runtime.openWorkspace = (directory): Promise<void> => {
      setState(mockClient, folder(directory));
      return Promise.resolve();
    };
    const container = mount(runtime);

    typeText(container, "First question");
    await chooseFolder(container);
    await settle();
    expect(textarea(container).value).toBe("First question");

    // Back to no folder later: the handed-over draft does not come back.
    act(() => {
      setState(null, noFolder);
    });
    expect(textarea(container).value).toBe("");
  });

  it.each(["picker", "project"] as const)(
    "keeps the draft when opening via %s restores a remembered session",
    async (entry) => {
      const { runtime, mockClient, setState } = switchableRuntime();
      const snapshot = runtime.store.getSnapshot().view.snapshot;
      if (!snapshot) throw new Error("mock snapshot missing");
      const session = snapshot.sessions[0];
      let finishOpen: () => void = () => undefined;
      const open = (directory: string): Promise<void> =>
        new Promise<void>((resolve) => {
          // Match runtime ordering: publish a client before connecting and
          // restoring its remembered session into a different draft scope.
          runtime.store.reset();
          setState(mockClient, folder(directory));
          finishOpen = (): void => {
            runtime.store.replaceSnapshot(
              { ...snapshot, activeSessionId: session.id },
              2,
            );
            resolve();
          };
        });
      runtime.openWorkspace = open;
      runtime.switchWorkspace = open;
      if (entry === "project") {
        setState(null, {
          ...folder("/workspace"),
          selectedDirectory: null,
        });
      }
      const container = mount(runtime);
      typeText(container, "Keep my question after restoring the session");
      if (entry === "picker") {
        await chooseFolder(container);
      } else {
        act(() => {
          button(container, "workspace").click();
        });
        await settle();
      }

      await act(async () => {
        finishOpen();
        await Promise.resolve();
      });
      await settle();
      expect(textarea(container).value).toBe(
        "Keep my question after restoring the session",
      );

      // Later renders must not overwrite edits or resurrect the handed-off text.
      typeText(container, "My revised question");
      act(() => {
        runtime.store.setConnectionState("live");
      });
      expect(textarea(container).value).toBe("My revised question");
      act(() => {
        runtime.store.replaceSnapshot(
          { ...snapshot, activeSessionId: null },
          3,
        );
      });
      expect(textarea(container).value).toBe("");
      act(() => {
        setState(null, noFolder);
      });
      expect(textarea(container).value).toBe("");
    },
  );

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
