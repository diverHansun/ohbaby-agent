import { type ReactElement, useEffect, useRef, useState } from "react";
import {
  TERMINAL_CLOSE_CODES,
  TERMINAL_MAX_BUFFER_BYTES,
  type TerminalServerMessage,
} from "ohbaby-sdk";
import {
  chunkTerminalInput,
  type TerminalApi,
} from "../../../api/daemon/terminals.js";
import { Banner } from "../../shared/Banner.js";
import { terminalFontFamily, terminalTheme } from "./terminal-theme.js";

/** The xterm surface the view drives; tests pass a fake. */
export interface TerminalSurface {
  readonly cols: number;
  readonly rows: number;
  reset(): void;
  resize(cols: number, rows: number): void;
  write(data: string, done: () => void): void;
  /** Rows and columns that fit the host now; undefined while it has no size. */
  propose(): { readonly cols: number; readonly rows: number } | undefined;
  onData(listener: (data: string) => void): { dispose(): void };
  focus(): void;
  dispose(): void;
}

export type CreateTerminalSurface = (
  host: HTMLElement,
) => Promise<TerminalSurface>;

/** Loads xterm only when a terminal tab is shown, keeping it out of the first paint. */
const createXtermSurface: CreateTerminalSurface = async (host) => {
  const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("@xterm/addon-web-links"),
    import("@xterm/xterm/css/xterm.css"),
  ]);
  const terminal = new Terminal({
    cursorBlink: true,
    fontFamily: terminalFontFamily(host),
    fontSize: 12.5,
    lineHeight: 1.2,
    scrollback: 1000,
    theme: terminalTheme(host),
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.loadAddon(new WebLinksAddon());
  terminal.open(host);
  return {
    get cols(): number {
      return terminal.cols;
    },
    get rows(): number {
      return terminal.rows;
    },
    reset: (): void => {
      terminal.reset();
    },
    resize: (cols, rows): void => {
      terminal.resize(cols, rows);
    },
    write: (data, done): void => {
      terminal.write(data, done);
    },
    propose: (): { cols: number; rows: number } | undefined =>
      fit.proposeDimensions(),
    onData: (listener): { dispose(): void } => terminal.onData(listener),
    focus: (): void => {
      terminal.focus();
    },
    dispose: (): void => {
      terminal.dispose();
    },
  };
};

type Status =
  | "connecting"
  | "live"
  | "reconnecting"
  | "failed"
  | "exited"
  | "missing";

type Queued =
  | {
      readonly type: "snapshot";
      readonly data: string;
      readonly cols: number;
      readonly rows: number;
    }
  | { readonly type: "output"; readonly data: string; readonly bytes: number }
  /** Applies the panel's size in turn, so earlier output keeps its own size. */
  | { readonly type: "fit"; readonly announce: boolean };

const encoder = new TextEncoder();
const RETRY_FIRST_MS = 1000;
const RETRY_MAX_MS = 10_000;
/** Only a connection that stays healthy this long resets the backoff (F5). */
const HEALTHY_MS = 10_000;

/**
 * One terminal's screen and socket. The server's screen is the source of
 * truth: every (re)connect starts from its snapshot, so leaving the tab simply
 * drops this view (D9, F3–F5).
 */
export function TerminalView(props: {
  readonly api: TerminalApi;
  readonly terminalId: string;
  /** The shell exited; its code is already written into the screen. */
  readonly onExit: (exitCode: number) => void;
  /** The server closed or no longer has this terminal; the page re-reads the list. */
  readonly onMissing: () => void;
  readonly createSurface?: CreateTerminalSurface;
}): ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const callbacks = useRef(props);
  callbacks.current = props;
  const { api, terminalId } = props;
  const createSurface = props.createSurface ?? createXtermSurface;

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let surface: TerminalSurface | undefined;
    let socket: WebSocket | undefined;
    let generation = 0;
    let stopped = false;
    let exited = false;
    let snapshotRestored = false;
    let retryMs = RETRY_FIRST_MS;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let healthyTimer: ReturnType<typeof setTimeout> | undefined;
    const queue: Queued[] = [];
    let queuedBytes = 0;
    let writing = false;
    let frame = 0;

    const send = (message: object): void => {
      if (socket?.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(message));
    };
    const fit = (announce: boolean): void => {
      if (!surface) return;
      const size = surface.propose();
      if (!size || size.cols < 2 || size.rows < 1) return;
      const changed = size.cols !== surface.cols || size.rows !== surface.rows;
      if (changed) surface.resize(size.cols, size.rows);
      if (changed || announce)
        send({ type: "resize", cols: size.cols, rows: size.rows });
    };
    const pump = (owner: number): void => {
      while (surface && !writing && owner === generation) {
        const item = queue.shift();
        if (!item) return;
        if (item.type === "fit") {
          fit(item.announce);
          continue;
        }
        writing = true;
        const current = surface;
        if (item.type === "snapshot") {
          // xterm's reset() keeps queued writes, so let the previous
          // connection's output drain before the screen starts over.
          current.write("", () => {
            if (owner !== generation) return;
            current.reset();
            current.resize(item.cols, item.rows);
            current.write(item.data, () => {
              if (owner !== generation) return;
              writing = false;
              snapshotRestored = true;
              // Only now does the panel's size apply (F3 step 7).
              queue.push({ type: "fit", announce: true });
              pump(owner);
            });
          });
          return;
        }
        // Merge consecutive output, never across a snapshot or a resize.
        let data = item.data;
        let bytes = item.bytes;
        while (queue[0]?.type === "output") {
          const next = queue.shift() as Extract<Queued, { type: "output" }>;
          data += next.data;
          bytes += next.bytes;
        }
        current.write(data, () => {
          if (owner !== generation) return;
          queuedBytes -= bytes;
          writing = false;
          pump(owner);
        });
      }
    };
    const requestFit = (announce: boolean): void => {
      // The snapshot completion always fits and announces the latest host size.
      // Sending it earlier can make new-size output race the old-size snapshot.
      if (!snapshotRestored) return;
      const last = queue.at(-1);
      if (last?.type === "fit")
        queue[queue.length - 1] = {
          type: "fit",
          announce: announce || last.announce,
        };
      else queue.push({ type: "fit", announce });
      pump(generation);
    };
    const retry = (): void => {
      if (stopped) return;
      setStatus("reconnecting");
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    };
    // A page that falls behind drops its backlog and starts over from a snapshot.
    const overflow = (): void => {
      generation += 1;
      clearTimeout(healthyTimer);
      socket?.close();
      retry();
    };
    function connect(): void {
      if (stopped) return;
      generation += 1;
      const owner = generation;
      snapshotRestored = false;
      queue.length = 0;
      queuedBytes = 0;
      writing = false;
      try {
        socket = callbacks.current.api.connect(terminalId);
      } catch {
        retry();
        return;
      }
      socket.onmessage = (event: MessageEvent): void => {
        if (owner !== generation || typeof event.data !== "string") return;
        let message: TerminalServerMessage;
        try {
          message = JSON.parse(event.data) as TerminalServerMessage;
        } catch {
          return;
        }
        if (message.type === "snapshot") {
          queue.push(message);
          setStatus("live");
          clearTimeout(healthyTimer);
          healthyTimer = setTimeout(() => {
            retryMs = RETRY_FIRST_MS;
          }, HEALTHY_MS);
        } else if (message.type === "output") {
          const bytes = encoder.encode(message.data).length;
          queuedBytes += bytes;
          if (queuedBytes > TERMINAL_MAX_BUFFER_BYTES) {
            overflow();
            return;
          }
          queue.push({ type: "output", data: message.data, bytes });
        } else {
          exited = true;
          const text = `\r\n\x1b[2mProcess exited with code ${String(message.exitCode)}\x1b[0m\r\n`;
          queue.push({ type: "output", data: text, bytes: 0 });
          callbacks.current.onExit(message.exitCode);
        }
        pump(owner);
      };
      socket.onclose = (event: CloseEvent): void => {
        if (owner !== generation || stopped) return;
        clearTimeout(healthyTimer);
        if (exited) {
          setStatus("exited");
        } else if (event.code === TERMINAL_CLOSE_CODES.UNAUTHORIZED) {
          setStatus("failed");
        } else if (
          event.code === TERMINAL_CLOSE_CODES.NORMAL ||
          event.code === TERMINAL_CLOSE_CODES.NOT_FOUND
        ) {
          // Says so even if the list read that follows fails.
          setStatus("missing");
          callbacks.current.onMissing();
        } else retry();
      };
    }

    const resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        requestFit(false);
      });
    });
    // Another window may have resized the shared terminal meanwhile (F4).
    const onFocus = (): void => {
      requestFit(true);
    };
    let input: { dispose(): void } | undefined;
    void createSurface(element).then(
      (created) => {
        if (stopped) {
          created.dispose();
          return;
        }
        surface = created;
        input = created.onData((data) => {
          if (socket?.readyState !== WebSocket.OPEN) return;
          for (const chunk of chunkTerminalInput(data))
            send({ type: "input", data: chunk });
        });
        resizeObserver.observe(element);
        window.addEventListener("focus", onFocus);
        // Restoring a tab must not take focus from the chat (or another input).
        // Explicit panel actions already leave focus in the panel or on body.
        const activeElement = document.activeElement;
        if (
          !activeElement ||
          activeElement === document.body ||
          element.closest(".ohb-side-panel")?.contains(activeElement)
        )
          created.focus();
        connect();
      },
      () => {
        setStatus("failed");
      },
    );
    return (): void => {
      stopped = true;
      generation += 1;
      clearTimeout(retryTimer);
      clearTimeout(healthyTimer);
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      window.removeEventListener("focus", onFocus);
      input?.dispose();
      socket?.close(1000);
      surface?.dispose();
    };
  }, [api, terminalId, createSurface]);

  return (
    <div className="ohb-terminal">
      {status === "reconnecting" ? (
        <Banner tone="attention" message="Reconnecting…" />
      ) : status === "failed" ? (
        <Banner
          tone="error"
          message="The terminal could not connect. Reload the page to try again."
        />
      ) : status === "missing" ? (
        <Banner tone="info" message="This terminal has ended." />
      ) : null}
      <div ref={host} className="ohb-terminal-screen" />
    </div>
  );
}
