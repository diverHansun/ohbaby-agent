// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import {
  TERMINAL_CLOSE_CODES,
  TERMINAL_ERROR_CODES,
  type TerminalInfo,
} from "ohbaby-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalApi } from "../../../api/daemon/terminals.js";
import { ConfirmDialog } from "../../shared/ConfirmDialog.js";
import { SidePanel } from "../SidePanel.js";
import { useSidePanel } from "../use-side-panel.js";
import { TerminalPage } from "./TerminalPage.js";
import type { CreateTerminalSurface, TerminalSurface } from "./TerminalView.js";
import { useTerminalTabs } from "./use-terminal-tabs.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no layout, so nothing is ever observed.
globalThis.ResizeObserver = class {
  observe(): void {
    /* no layout */
  }
  unobserve(): void {
    /* no layout */
  }
  disconnect(): void {
    /* no layout */
  }
};

function info(id: string, overrides: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    id,
    directory: `/work/${id}`,
    title: id,
    shell: "zsh",
    createdAt: Number(id.replace(/\D/gu, "")) || 0,
    state: "running",
    ...overrides,
  };
}

function requestError(
  status: number,
  code?: string,
  extra: Record<string, unknown> = {},
): Error {
  return Object.assign(new Error(code ?? "failed"), { status, code, ...extra });
}

class FakeSocket {
  readyState = 1;
  readonly sent: unknown[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  closedWith: number | undefined;
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number): void {
    this.readyState = 3;
    this.closedWith = code;
  }
  receive(message: object): void {
    act(() => {
      this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
    });
  }
  serverClose(code: number): void {
    this.readyState = 3;
    act(() => {
      this.onclose?.({ code } as CloseEvent);
    });
  }
}

/** Records writes; `hold` keeps write callbacks pending to model a slow xterm. */
function fakeSurface(options: { hold?: boolean } = {}): {
  readonly create: CreateTerminalSurface;
  readonly writes: string[];
  readonly flush: () => void;
  readonly typed: (data: string) => void;
} {
  const writes: string[] = [];
  const pending: (() => void)[] = [];
  let listener: ((data: string) => void) | undefined;
  let size = { cols: 80, rows: 24 };
  const surface: TerminalSurface = {
    get cols() {
      return size.cols;
    },
    get rows() {
      return size.rows;
    },
    reset: () => {
      writes.push("<reset>");
    },
    resize: (cols, rows) => {
      size = { cols, rows };
    },
    write: (data, done) => {
      writes.push(data);
      if (options.hold) pending.push(done);
      else done();
    },
    propose: () => ({ cols: 100, rows: 30 }),
    onData: (next) => {
      listener = next;
      return { dispose: () => undefined };
    },
    focus: () => undefined,
    dispose: () => undefined,
  };
  return {
    create: () => Promise.resolve(surface),
    writes,
    flush: (): void => {
      act(() => {
        for (const done of pending.splice(0)) done();
      });
    },
    typed: (data): void => {
      act(() => {
        listener?.(data);
      });
    },
  };
}

function fakeApi(terminals: TerminalInfo[] = []): TerminalApi & {
  readonly sockets: FakeSocket[];
  list: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    list: vi.fn(() => Promise.resolve([...terminals])),
    create: vi.fn(() => Promise.resolve(info("t9"))),
    close: vi.fn(() => Promise.resolve()),
    connect: (): WebSocket => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  };
}

function focusableSurface(): CreateTerminalSurface {
  const fake = fakeSurface();
  return async (host) => {
    const input = document.createElement("textarea");
    input.setAttribute("aria-label", "Terminal input");
    host.append(input);
    const surface = await fake.create(host);
    surface.focus = (): void => {
      input.focus();
    };
    return surface;
  };
}

const mounted: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of mounted.splice(0)) cleanup();
  vi.useRealTimers();
});

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function mount(node: ReactElement): {
  readonly element: HTMLElement;
  readonly render: (next: ReactElement) => void;
} {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const render = (next: ReactElement): void => {
    act(() => {
      root.render(next);
    });
  };
  render(node);
  mounted.push(() => {
    act(() => {
      root.unmount();
    });
    element.remove();
  });
  return { element, render };
}

function Panel(props: {
  readonly api: TerminalApi;
  readonly open?: boolean;
  readonly directory?: string | null;
  readonly onError?: (error: unknown) => void;
  readonly surface?: CreateTerminalSurface;
}): ReactElement {
  const panel = useSidePanel(undefined);
  const terminals = useTerminalTabs({
    api: props.api,
    panel,
    directory: () => props.directory ?? null,
    onError: props.onError ?? ((): void => undefined),
  });
  return (
    <>
      <button
        type="button"
        data-testid="open"
        onClick={() => {
          panel.setOpen(true);
        }}
      />
      <span data-testid="tabs">
        {panel.state.tabs
          .map((tab) => (tab.kind === "terminal" ? tab.state.terminal.id : ""))
          .join(",")}
      </span>
      {panel.state.open ? (
        <SidePanel
          controls={panel}
          onNewTerminal={terminals.createTerminal}
          onCloseTerminal={(tab, remove) => {
            terminals.closeTerminal(tab, false, remove);
          }}
          renderPage={(tab) =>
            tab.kind === "terminal" ? (
              <TerminalPage
                key={tab.id}
                api={props.api}
                state={tab.state}
                onExit={(code) => {
                  terminals.markExited(tab, code);
                }}
                onMissing={terminals.sync}
                createSurface={props.surface ?? fakeSurface().create}
              />
            ) : null
          }
        />
      ) : null}
      {terminals.confirmation ? (
        <ConfirmDialog
          title="Close terminal?"
          description={`${terminals.confirmation.process} is still running`}
          confirmLabel="Close"
          danger
          onConfirm={() => {
            const pending = terminals.confirmation;
            if (pending)
              terminals.closeTerminal(pending.tab, true, pending.remove);
          }}
          onCancel={terminals.dismissConfirmation}
        />
      ) : null}
    </>
  );
}

function byText(
  scope: ParentNode,
  selector: string,
  text: string,
): HTMLElement {
  const found = [...scope.querySelectorAll<HTMLElement>(selector)].find(
    (element) => element.textContent.includes(text),
  );
  if (!found) throw new Error(`missing ${selector} "${text}"`);
  return found;
}

function only(scope: ParentNode, selector: string): HTMLElement {
  const found = scope.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`missing ${selector}`);
  return found;
}

function click(element: HTMLElement): void {
  act(() => {
    element.click();
  });
}

function tabs(element: HTMLElement): string {
  return element.querySelector('[data-testid="tabs"]')?.textContent ?? "";
}

function closeButton(element: HTMLElement, title: string): HTMLElement {
  const button = element.querySelector<HTMLElement>(
    `button[title="Close ${title}"]`,
  );
  if (!button) throw new Error(`missing close for ${title}`);
  return button;
}

beforeEach(() => {
  localStorage.clear();
});

describe("terminal tabs", () => {
  it("preserves the chat input focus when sync restores the first terminal into an open panel", async () => {
    const terminals: TerminalInfo[] = [];
    const api = fakeApi(terminals);
    const { element } = mount(
      <>
        <textarea aria-label="Chat draft" />
        <Panel api={api} surface={focusableSurface()} />
      </>,
    );
    await settle();
    click(only(element, '[data-testid="open"]'));
    const chat = only(element, '[aria-label="Chat draft"]');
    chat.focus();
    terminals.push(info("t1"));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(tabs(element)).toBe("t1");
    expect(api.sockets).toHaveLength(1);
    expect(document.activeElement).toBe(chat);
  });

  it("focuses the terminal after the user creates it from the panel", async () => {
    const { element } = mount(
      <Panel api={fakeApi()} surface={focusableSurface()} />,
    );
    await settle();
    click(only(element, '[data-testid="open"]'));
    const entry = byText(element, ".ohb-side-panel-entry button", "Terminal");
    entry.focus();
    click(entry);
    await settle();
    expect(document.activeElement).toBe(
      only(element, '[aria-label="Terminal input"]'),
    );
  });

  it("opens a tab only after the server created the terminal (S1b, S17)", async () => {
    const api = fakeApi();
    const errors: unknown[] = [];
    const { element } = mount(
      <Panel
        api={api}
        directory="/work"
        onError={(error) => errors.push(error)}
      />,
    );
    click(only(element, '[data-testid="open"]'));
    click(byText(element, ".ohb-side-panel-entry button", "Terminal"));
    // Nothing appears while the request is in flight.
    expect(element.querySelector('[role="tab"]')).toBeNull();
    await settle();
    expect(api.create).toHaveBeenCalledWith({
      directory: "/work",
      cols: 80,
      rows: 24,
    });
    const tab = element.querySelector('[role="tab"]');
    expect(tab?.textContent).toBe("t9");
    expect(tab?.getAttribute("aria-selected")).toBe("true");
    expect(tab?.getAttribute("title")).toBe("/work/t9 · zsh");

    api.create.mockImplementationOnce(() =>
      Promise.reject(requestError(409, TERMINAL_ERROR_CODES.LIMIT_REACHED)),
    );
    click(only(element, '[aria-label="Add page"]'));
    click(byText(document.body, '[role="menuitem"]', "Terminal"));
    await settle();
    expect(element.querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(String(errors[0])).toContain("16 terminals");
  });

  it("restores server terminals without opening the panel or moving the selection (S1c)", async () => {
    const terminals = [info("t1"), info("t2")];
    const api = fakeApi(terminals);
    const { element } = mount(<Panel api={api} />);
    await settle();
    expect(tabs(element)).toBe("t1,t2");
    expect(element.querySelector(".ohb-side-panel")).toBeNull();

    click(only(element, '[data-testid="open"]'));
    click(element.querySelectorAll<HTMLElement>('[role="tab"]')[1]);
    terminals.push(info("t3"));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(tabs(element)).toBe("t1,t2,t3");
    // The same list again adds nothing, and t2 stays selected.
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(tabs(element)).toBe("t1,t2,t3");
    expect(
      element.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    ).toBe("t2");
  });

  it("marks a vanished terminal ended but keeps a shown exit code (F1b, F7)", async () => {
    const terminals = [info("t1"), info("t2")];
    const api = fakeApi(terminals);
    const { element } = mount(<Panel api={api} />);
    await settle();
    click(only(element, '[data-testid="open"]'));
    await settle();
    // t1 is selected: its shell exits while shown.
    const first = api.sockets[0];
    first.receive({ type: "snapshot", data: "$ ", cols: 80, rows: 24 });
    first.receive({ type: "exit", exitCode: 3 });
    first.serverClose(TERMINAL_CLOSE_CODES.NORMAL);
    // Natural exit has been shown, but background-process cleanup is still running.
    terminals[0] = info("t1", { state: "closing" });
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(element.querySelector(".ohb-terminal-screen")).not.toBeNull();
    terminals.splice(0);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(element.querySelector(".ohb-banner")).toBeNull();
    expect(element.querySelector(".ohb-terminal-screen")).not.toBeNull();

    click(element.querySelectorAll<HTMLElement>('[role="tab"]')[1]);
    expect(element.querySelector(".ohb-banner")?.textContent).toBe(
      "This terminal has ended.",
    );
    // Back on t1, the exit is still what it says.
    click(element.querySelectorAll<HTMLElement>('[role="tab"]')[0]);
    expect(element.querySelector(".ohb-banner")?.textContent).toBe(
      "Process exited with code 3.",
    );
  });

  it("ignores a second click while a create is pending, and never doubles a tab a sync already added", async () => {
    const terminals: TerminalInfo[] = [];
    const api = fakeApi(terminals);
    let finish: (terminal: TerminalInfo) => void = () => undefined;
    api.create.mockImplementation(
      () =>
        new Promise<TerminalInfo>((resolve) => {
          finish = resolve;
        }),
    );
    const { element } = mount(<Panel api={api} />);
    await settle();
    click(only(element, '[data-testid="open"]'));
    click(byText(element, ".ohb-side-panel-entry button", "Terminal"));
    click(byText(element, ".ohb-side-panel-entry button", "Terminal"));
    expect(api.create).toHaveBeenCalledTimes(1);
    // The new terminal shows up in a focus sync before the create returns.
    terminals.push(info("t9"));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(tabs(element)).toBe("t9");
    finish(info("t9"));
    await settle();
    expect(tabs(element)).toBe("t9");
    expect(
      element.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    ).toBe("t9");
  });

  it("keeps the screen while its own close is pending, even if a sync reports closing", async () => {
    const terminals = [info("t1")];
    const api = fakeApi(terminals);
    api.close.mockImplementation(() => new Promise(() => undefined));
    const { element } = mount(<Panel api={api} />);
    await settle();
    click(only(element, '[data-testid="open"]'));
    await settle();
    click(closeButton(element, "t1"));
    expect(closeButton(element, "t1").hasAttribute("disabled")).toBe(true);
    terminals[0] = info("t1", { state: "closing" });
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(element.querySelector(".ohb-terminal-screen")).not.toBeNull();
  });

  it("closes an idle terminal and asks before ending a running program (S4, S5)", async () => {
    const api = fakeApi([info("t1"), info("t2")]);
    const { element } = mount(<Panel api={api} />);
    await settle();
    click(only(element, '[data-testid="open"]'));

    click(closeButton(element, "t1"));
    await settle();
    expect(api.close).toHaveBeenLastCalledWith("t1", false);
    expect(tabs(element)).toBe("t2");

    const busy = (): Promise<never> =>
      Promise.reject(
        requestError(409, TERMINAL_ERROR_CODES.BUSY, { process: "node" }),
      );
    api.close.mockImplementationOnce(busy).mockImplementationOnce(busy);
    click(closeButton(element, "t2"));
    await settle();
    const dialog = document.querySelector(
      '[role="alertdialog"], [role="dialog"]',
    );
    expect(dialog?.textContent).toContain("node is still running");
    click(byText(document.body, "button", "Cancel"));
    expect(tabs(element)).toBe("t2");

    click(closeButton(element, "t2"));
    await settle();
    click(byText(document.body, "button", "Close"));
    await settle();
    expect(api.close).toHaveBeenLastCalledWith("t2", true);
    expect(tabs(element)).toBe("");
  });

  it("keeps a tab whose cleanup failed and lets the same x retry (S5c)", async () => {
    const api = fakeApi([info("t1")]);
    const { element } = mount(<Panel api={api} />);
    await settle();
    click(only(element, '[data-testid="open"]'));
    api.close.mockImplementationOnce(() =>
      Promise.reject(
        Object.assign(requestError(500, TERMINAL_ERROR_CODES.CLOSE_FAILED), {
          message: "surviving pids: 42",
        }),
      ),
    );
    click(closeButton(element, "t1"));
    await settle();
    expect(tabs(element)).toBe("t1");
    expect(element.querySelector(".ohb-banner")?.textContent).toContain(
      "surviving pids: 42",
    );
    click(closeButton(element, "t1"));
    await settle();
    expect(tabs(element)).toBe("");
  });
});

describe("terminal view", () => {
  function view(): {
    readonly api: ReturnType<typeof fakeApi>;
    readonly surface: ReturnType<typeof fakeSurface>;
    readonly element: HTMLElement;
    readonly onMissing: ReturnType<typeof vi.fn>;
  } {
    const api = fakeApi();
    const surface = fakeSurface({ hold: true });
    const onMissing = vi.fn();
    const { element } = mount(
      <TerminalPage
        api={api}
        state={{ terminal: info("t1") }}
        onExit={() => undefined}
        onMissing={onMissing}
        createSurface={surface.create}
      />,
    );
    return { api, surface, element, onMissing };
  }

  it("restores the snapshot before later output and only then sends its size (S2b)", async () => {
    const { api, surface } = view();
    await settle();
    const socket = api.sockets[0];
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(socket.sent).toEqual([]);
    socket.receive({ type: "snapshot", data: "SNAP", cols: 70, rows: 20 });
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    socket.receive({ type: "output", data: "a" });
    socket.receive({ type: "output", data: "b" });
    // First the previous connection's writes drain, then the screen resets.
    expect(surface.writes).toEqual([""]);
    surface.flush();
    expect(surface.writes).toEqual(["", "<reset>", "SNAP"]);
    surface.flush();
    // Consecutive output is merged into one write after the snapshot, and it
    // keeps the snapshot's size: the panel's size follows it.
    expect(surface.writes).toEqual(["", "<reset>", "SNAP", "ab"]);
    expect(socket.sent).toEqual([]);
    surface.flush();
    expect(socket.sent).toEqual([{ type: "resize", cols: 100, rows: 30 }]);
  });

  it("splits long pastes into frames within the input limit (S15)", async () => {
    const { api, surface } = view();
    await settle();
    const socket = api.sockets[0];
    const paste = "x".repeat(200_000);
    surface.typed(paste);
    const sent = socket.sent as { type: string; data: string }[];
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.map((frame) => frame.data).join("")).toBe(paste);
  });

  it("drops a local backlog over 2 MB and reconnects with backoff (S12b)", async () => {
    vi.useFakeTimers();
    const { api, element } = view();
    await settle();
    const socket = api.sockets[0];
    socket.receive({ type: "snapshot", data: "", cols: 80, rows: 24 });
    // The snapshot write is held, so output piles up locally.
    for (let index = 0; index < 3; index += 1)
      socket.receive({ type: "output", data: "y".repeat(1024 * 1024) });
    expect(socket.readyState).toBe(3);
    expect(element.querySelector(".ohb-banner")?.textContent).toBe(
      "Reconnecting…",
    );
    expect(api.sockets).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(api.sockets).toHaveLength(2);
    // A second failure waits twice as long.
    api.sockets[1].serverClose(TERMINAL_CLOSE_CODES.OVERFLOW);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(api.sockets).toHaveLength(2);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(api.sockets).toHaveLength(3);
  });

  it("does not reconnect to a terminal the server ended (S16)", async () => {
    vi.useFakeTimers();
    const { api, onMissing } = view();
    await settle();
    api.sockets[0].serverClose(TERMINAL_CLOSE_CODES.NOT_FOUND);
    expect(onMissing).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(api.sockets).toHaveLength(1);
  });
});
