// @vitest-environment jsdom
import { act, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiBackendClient, UiEvent, UiEventHandler } from "ohbaby-sdk";
import type {
  SessionFileContent,
  SessionFileEntry,
  SessionFilesApi,
} from "../../../api/daemon/session-files.js";
import { FilesPage } from "./FilesPage.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of mounted.splice(0)) cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const NOW = new Date().toISOString();

function entry(
  path: string,
  patch: Partial<SessionFileEntry> = {},
): SessionFileEntry {
  return { path, size: 1200, modifiedAt: NOW, ...patch };
}

function codedError(code: string, status: number): Error {
  return Object.assign(new Error(code), { code, status });
}

function fakeClient(): {
  readonly client: UiBackendClient;
  readonly emit: (event: UiEvent) => void;
} {
  const handlers = new Set<UiEventHandler>();
  return {
    client: {
      subscribeEvents: (handler: UiEventHandler) => {
        handlers.add(handler);
        return () => {
          handlers.delete(handler);
        };
      },
    } as unknown as UiBackendClient,
    emit: (event): void => {
      for (const handler of handlers) handler(event);
    },
  };
}

function Harness(props: {
  readonly api: SessionFilesApi;
  readonly client: UiBackendClient;
}): ReactElement {
  const [path, setPath] = useState<string>();
  return (
    <FilesPage
      api={props.api}
      client={props.client}
      rootSessionId="root"
      selectedPath={path}
      onSelect={setPath}
    />
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 5; index++) await Promise.resolve();
  });
}

async function render(
  api: SessionFilesApi,
  client: UiBackendClient,
): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Harness api={api} client={client} />);
    await Promise.resolve();
  });
  await settle();
  mounted.push(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });
  return container;
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent.includes(text) ||
      candidate.getAttribute("aria-label") === text,
  );
  if (!found) throw new Error(`No button "${text}"`);
  return found;
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click();
    await Promise.resolve();
  });
  await settle();
}

function api(
  files: () => readonly SessionFileEntry[],
  read: (path: string) => Promise<SessionFileContent>,
): SessionFilesApi & {
  readonly list: ReturnType<typeof vi.fn>;
  readonly read: ReturnType<typeof vi.fn>;
} {
  return {
    list: vi.fn(() => Promise.resolve(files())),
    read: vi.fn((_root: string, path: string) => read(path)),
  };
}

describe("Files page", () => {
  it("lists scratch files with their folder and size, in the server's order", async () => {
    const files = api(
      () => [entry("build.log", { size: 5500 }), entry("reports/review.md")],
      () => Promise.reject(new Error("unused")),
    );
    const view = await render(files, fakeClient().client);
    const rows = [...view.querySelectorAll(".ohb-file-row")];
    expect(rows.map((row) => row.getAttribute("data-file-path"))).toEqual([
      "build.log",
      "reports/review.md",
    ]);
    expect(rows[0]?.textContent).toContain("5.4 KB");
    expect(rows[1]?.querySelector("small")?.textContent).toBe("reports");
    expect(files.list).toHaveBeenCalledWith("root", expect.any(AbortSignal));
  });

  it("explains an empty scratch folder", async () => {
    const view = await render(
      api(
        () => [],
        () => Promise.reject(new Error("unused")),
      ),
      fakeClient().client,
    );
    expect(view.textContent).toContain("No files yet");
    expect(view.textContent).toContain("stay out of your workspace");
  });

  it("renders markdown, shows its numbered source, and returns focus to the row", async () => {
    const view = await render(
      api(
        () => [entry("notes/plan.md")],
        () => Promise.resolve({ kind: "text", text: "# Plan\n\nShip it\n" }),
      ),
      fakeClient().client,
    );
    await click(button(view, "plan.md"));
    expect(view.querySelector(".ohb-file-markdown h1")?.textContent).toBe(
      "Plan",
    );
    expect(
      view.querySelector(".ohb-file-preview-title p")?.textContent,
    ).toContain("notes · 1.2 KB");
    await click(button(view, "Source"));
    expect(
      [...view.querySelectorAll(".ohb-file-line")].map(
        (line) => line.textContent,
      ),
    ).toEqual(["# Plan\n", "\n", "Ship it\n"]);
    await click(button(view, "Back to files"));
    expect(document.activeElement?.getAttribute("data-file-path")).toBe(
      "notes/plan.md",
    );
  });

  it("shows an image from its object URL and revokes it on leaving", async () => {
    // jsdom has no object URLs; the page only needs revoke to exist.
    const revoke = vi.fn();
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revoke,
    });
    const view = await render(
      api(
        () => [entry("shot.png")],
        () => Promise.resolve({ kind: "image", url: "blob:shot" }),
      ),
      fakeClient().client,
    );
    await click(button(view, "shot.png"));
    expect(view.querySelector(".ohb-file-image img")?.getAttribute("src")).toBe(
      "blob:shot",
    );
    await click(button(view, "Back to files"));
    expect(revoke).toHaveBeenCalledWith("blob:shot");
  });

  it("says why a file cannot be shown, and retries other failures", async () => {
    let failure = codedError("UNSUPPORTED_FILE_TYPE", 415);
    const files = api(
      () => [entry("a.zip", { size: 3_400_000 })],
      () => Promise.reject(failure),
    );
    const view = await render(files, fakeClient().client);
    await click(button(view, "a.zip"));
    expect(view.textContent).toContain("No preview for this file type");
    expect(view.textContent).toContain("a.zip · 3.2 MB");

    await click(button(view, "Back to files"));
    failure = codedError("FILE_TOO_LARGE", 413);
    await click(button(view, "a.zip"));
    expect(view.textContent).toContain("Text previews stop at 1 MB");

    await click(button(view, "Back to files"));
    failure = new Error("disk unplugged");
    await click(button(view, "a.zip"));
    expect(view.textContent).toContain("Couldn't open this file");
    const reads = files.read.mock.calls.length;
    await click(button(view, "Try again"));
    expect(files.read.mock.calls.length).toBe(reads + 1);
  });

  it("re-reads the list after a run changes, and the preview when its file changed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let current = [entry("log.txt", { size: 10 })];
    let text = "first";
    const files = api(
      () => current,
      () => Promise.resolve({ kind: "text", text }),
    );
    const { client, emit } = fakeClient();
    const view = await render(files, client);
    await click(button(view, "log.txt"));
    expect(view.querySelector(".ohb-file-text")?.textContent).toBe("first\n");

    current = [entry("log.txt", { size: 20 })];
    text = "second";
    // A burst of run updates costs one list read.
    act(() => {
      emit({ type: "run.updated" } as UiEvent);
      emit({ type: "run.updated" } as UiEvent);
    });
    expect(files.list).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    await settle();
    expect(files.list).toHaveBeenCalledTimes(2);
    expect(view.querySelector(".ohb-file-text")?.textContent).toBe("second\n");
  });

  it("says so when the open file left the folder", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let current = [entry("gone.txt")];
    const { client, emit } = fakeClient();
    const view = await render(
      api(
        () => current,
        () => Promise.resolve({ kind: "text", text: "bye" }),
      ),
      client,
    );
    await click(button(view, "gone.txt"));
    current = [];
    act(() => {
      emit({ type: "run.updated" } as UiEvent);
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    await settle();
    expect(view.textContent).toContain("This file is no longer here");
  });

  it("keeps the last list when a refresh fails, with a retry", async () => {
    let fail = false;
    const files: SessionFilesApi & { list: ReturnType<typeof vi.fn> } = {
      list: vi.fn(() =>
        fail
          ? Promise.reject(new Error("Failed to fetch"))
          : Promise.resolve([entry("a.txt")]),
      ),
      read: () => Promise.reject(new Error("unused")),
    };
    const view = await render(files, fakeClient().client);
    fail = true;
    await click(button(view, "Refresh files"));
    expect(view.textContent).toContain("Can't reach your services");
    expect(view.querySelector("[data-file-path='a.txt']")).not.toBeNull();
    fail = false;
    await click(button(view, "Retry"));
    expect(view.textContent).not.toContain("Can't reach your services");
  });
  it("re-reads the list when a read finds the file gone, and focuses the list on return", async () => {
    let current = [entry("old.txt")];
    const files = api(
      () => current,
      () => Promise.reject(codedError("FILE_NOT_FOUND", 404)),
    );
    const view = await render(files, fakeClient().client);
    current = [];
    await click(button(view, "old.txt"));
    expect(view.textContent).toContain("This file is no longer here");
    expect(files.list).toHaveBeenCalledTimes(2);
    expect(files.read).toHaveBeenCalledTimes(1);
    await click(button(view, "Back to files"));
    expect(view.querySelector("[data-file-path]")).toBeNull();
    expect(document.activeElement?.classList.contains("ohb-files-page")).toBe(
      true,
    );
  });

  it("refreshes after reconnect, but not when the connection drops", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let current = [entry("before.txt")];
    const files = api(
      () => current,
      () => Promise.reject(new Error("unused")),
    );
    const { client, emit } = fakeClient();
    const view = await render(files, client);
    const resync = {
      type: "session.resync-required" as const,
      runtimeEpoch: "epoch",
      sessionId: "root",
      bindingGeneration: 1,
      connectionGeneration: 2,
    };
    await act(async () => {
      emit({ ...resync, disconnected: true });
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    expect(files.list).toHaveBeenCalledTimes(1);
    current = [entry("after.txt")];
    await act(async () => {
      emit({ ...resync, disconnected: false });
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    await settle();
    expect(view.querySelector("[data-file-path='after.txt']")).not.toBeNull();
    expect(view.querySelector("[data-file-path='before.txt']")).toBeNull();
  });

  it("releases a late image from the previous root without replacing the new preview", async () => {
    const revoke = vi.fn();
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revoke,
    });
    let finishList!: (files: readonly SessionFileEntry[]) => void;
    let finishImage!: (content: SessionFileContent) => void;
    const oldList = new Promise<readonly SessionFileEntry[]>((resolve) => {
      finishList = resolve;
    });
    const oldImage = new Promise<SessionFileContent>((resolve) => {
      finishImage = resolve;
    });
    const signals: AbortSignal[] = [];
    const files: SessionFilesApi = {
      list: (root, signal) => {
        if (root === "old") {
          if (signal) signals.push(signal);
          return oldList;
        }
        return Promise.resolve([entry("current.txt")]);
      },
      read: (root, _path, signal) => {
        if (root === "old") {
          if (signal) signals.push(signal);
          return oldImage;
        }
        return Promise.resolve({ kind: "text", text: "Current root" });
      },
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push(() => {
      act(() => {
        root.unmount();
      });
      container.remove();
    });
    const { client } = fakeClient();
    const show = async (id: string, path: string): Promise<void> => {
      await act(async () => {
        // SidePanelPage keys FilesPage by rootSessionId when the chat changes.
        root.render(
          <FilesPage
            key={id}
            api={files}
            client={client}
            rootSessionId={id}
            selectedPath={path}
            onSelect={() => undefined}
          />,
        );
        await Promise.resolve();
      });
      await settle();
    };
    await show("old", "previous.png");
    await show("new", "current.txt");
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await act(async () => {
      // A transport can finish despite abort; the disposed reader owns cleanup.
      finishList([entry("previous.png")]);
      finishImage({ kind: "image", url: "blob:previous-root" });
      await Promise.resolve();
    });
    await settle();
    expect(revoke).toHaveBeenCalledWith("blob:previous-root");
    expect(container.querySelector(".ohb-file-text")?.textContent).toBe(
      "Current root\n",
    );
    expect(container.textContent).not.toContain("previous.png");
    expect(container.querySelector("img")).toBeNull();
  });
});
