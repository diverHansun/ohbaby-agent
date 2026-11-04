import { homedir } from "node:os";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { Hono, type Context } from "hono";
import WebSocket, { WebSocketServer } from "ws";
import {
  isLoopbackHost,
  REQUEST_DIRECTORY_HEADER,
  REQUEST_DIRECTORY_ENCODING_HEADER,
  REQUEST_DIRECTORY_ENCODING_PERCENT_UTF8,
  TERMINAL_PROTOCOL,
  TERMINAL_TOKEN_PREFIX,
  TERMINAL_MAX_INPUT_BYTES,
  TERMINAL_MAX_BUFFER_BYTES,
  TERMINAL_CLOSE_CODES,
  TERMINAL_ERROR_CODES,
  type TerminalServerMessage,
} from "ohbaby-sdk";
import { isAuthorizedDaemonRequest } from "../../../auth/token.js";
import {
  isAllowedDaemonHost,
  isAllowedTerminalOrigin,
} from "../../../auth/host-check.js";
import {
  resolveWorkspaceScope,
  WorkspaceScopeError,
} from "../../../runtime/workspace-scope.js";
import { TerminalError } from "../../../terminal/errors.js";
import type { TerminalManager } from "../../../terminal/terminal-manager.js";
import type { NodeWebSocketTransport } from "../../../transport/node-listen.js";

interface TerminalRouteOptions {
  readonly manager: TerminalManager;
  readonly host: string;
  readonly authToken?: string;
}

function validSize(cols: unknown, rows: unknown): boolean {
  return (
    typeof cols === "number" &&
    Number.isInteger(cols) &&
    cols >= 2 &&
    cols <= 500 &&
    typeof rows === "number" &&
    Number.isInteger(rows) &&
    rows >= 1 &&
    rows <= 200
  );
}

function failure(context: Context, error: unknown): Response {
  if (error instanceof TerminalError) {
    return context.json(
      {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.process === undefined ? {} : { process: error.process }),
        },
      },
      error.status,
    );
  }
  if (error instanceof WorkspaceScopeError) {
    return context.json(
      { ok: false, error: { code: error.code, message: error.message } },
      400,
    );
  }
  throw error;
}

export function registerTerminalRoutes(
  app: Hono,
  options: TerminalRouteOptions,
): void {
  const guard = (context: Context): Response | undefined => {
    if (!isLoopbackHost(options.host))
      return context.json(
        {
          ok: false,
          error: {
            code: TERMINAL_ERROR_CODES.LOOPBACK_ONLY,
            message: "Terminals are available only on loopback hosts",
          },
        },
        403,
      );
    if (
      !isAuthorizedDaemonRequest(
        context.req.header("authorization"),
        options.authToken,
      )
    ) {
      return context.json(
        { ok: false, error: { message: "Unauthorized" } },
        401,
      );
    }
    return undefined;
  };
  app.get(
    "/v1/terminals",
    (context) =>
      guard(context) ??
      context.json({ ok: true, terminals: options.manager.list() }),
  );
  app.post("/v1/terminals", async (context) => {
    const denied = guard(context);
    if (denied) return denied;
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json(
        {
          ok: false,
          error: {
            code: TERMINAL_ERROR_CODES.INVALID_REQUEST,
            message: "Expected a JSON body",
          },
        },
        400,
      );
    }
    if (
      !body ||
      typeof body !== "object" ||
      !("cols" in body) ||
      !("rows" in body) ||
      !validSize(body.cols, body.rows)
    ) {
      return context.json(
        {
          ok: false,
          error: {
            code: TERMINAL_ERROR_CODES.INVALID_REQUEST,
            message: "Expected integer cols (2–500) and rows (1–200)",
          },
        },
        400,
      );
    }
    try {
      let requested = context.req.header(REQUEST_DIRECTORY_HEADER);
      if (
        requested !== undefined &&
        context.req.header(REQUEST_DIRECTORY_ENCODING_HEADER) ===
          REQUEST_DIRECTORY_ENCODING_PERCENT_UTF8
      ) {
        try {
          requested = decodeURIComponent(requested);
        } catch {
          return context.json(
            {
              ok: false,
              error: {
                code: "INVALID_DIRECTORY",
                message: "x-ohbaby-directory percent encoding is invalid",
              },
            },
            400,
          );
        }
      }
      const directory =
        requested === undefined
          ? homedir()
          : await resolveWorkspaceScope(requested);
      const terminal = await options.manager.create({
        directory,
        cols: body.cols as number,
        rows: body.rows as number,
      });
      return context.json({ ok: true, terminal }, 201);
    } catch (error) {
      return failure(context, error);
    }
  });
  app.delete("/v1/terminals/:id", async (context) => {
    const denied = guard(context);
    if (denied) return denied;
    try {
      await options.manager.close(
        context.req.param("id"),
        context.req.query("force") === "1",
      );
      return context.json({ ok: true });
    } catch (error) {
      return failure(context, error);
    }
  });
}

function bearerAuthorization(request: IncomingMessage): string | undefined {
  const offered =
    request.headers["sec-websocket-protocol"]
      ?.split(",")
      .map((value) => value.trim()) ?? [];
  const tokens = offered.filter((value) =>
    value.startsWith(TERMINAL_TOKEN_PREFIX),
  );
  if (tokens.length !== 1) return undefined;
  const encoded = tokens[0]?.slice(TERMINAL_TOKEN_PREFIX.length) ?? "";
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) return undefined;
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.toString("base64url") !== encoded) return undefined;
  return `Bearer ${decoded.toString("utf8")}`;
}

function rejectUpgrade(socket: Duplex, status: 403 | 404): void {
  socket.end(
    `HTTP/1.1 ${String(status)} ${status === 403 ? "Forbidden" : "Not Found"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

/** Snapshots are bounded by the screen; realtime output has a separate backlog cap. */
export class TerminalWebSocketViewer {
  private timeout?: NodeJS.Timeout;
  private snapshotTimeout?: NodeJS.Timeout;
  private snapshotSending = false;
  private queued: string[] = [];
  private queuedBytes = 0;
  constructor(private readonly socket: WebSocket) {
    socket.once("close", () => {
      clearTimeout(this.timeout);
      this.clearSnapshot();
    });
    socket.on("error", () => {
      this.boundClose();
    });
  }
  get open(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }
  get bufferedAmount(): number {
    if (!this.open) return 0;
    return (
      this.queuedBytes + (this.snapshotSending ? 0 : this.socket.bufferedAmount)
    );
  }
  send(message: TerminalServerMessage): void {
    if (!this.open) return;
    const encoded = JSON.stringify(message);
    if (message.type === "snapshot") {
      this.snapshotSending = true;
      this.snapshotTimeout = setTimeout(() => {
        this.close(TERMINAL_CLOSE_CODES.OVERFLOW);
      }, 10000);
      this.snapshotTimeout.unref();
      this.socket.send(encoded, (error) => {
        clearTimeout(this.snapshotTimeout);
        if (error) {
          this.clearSnapshot();
          this.socket.terminate();
          return;
        }
        if (!this.snapshotSending || !this.open) return;
        this.snapshotSending = false;
        const pending = this.queued;
        this.queued = [];
        for (const item of pending) {
          this.queuedBytes -= Buffer.byteLength(item);
          this.sendEncoded(item);
          if (this.socket.readyState !== WebSocket.OPEN) break;
        }
      });
      return;
    }
    this.sendEncoded(encoded);
  }
  private sendEncoded(encoded: string): void {
    if (!this.open) return;
    if (
      this.bufferedAmount + Buffer.byteLength(encoded) >
      TERMINAL_MAX_BUFFER_BYTES
    ) {
      this.close(TERMINAL_CLOSE_CODES.OVERFLOW);
      return;
    }
    if (this.snapshotSending) {
      this.queued.push(encoded);
      this.queuedBytes += Buffer.byteLength(encoded);
      return;
    }
    this.socket.send(encoded, (error) => {
      if (error) this.socket.terminate();
    });
  }
  close(code: number): void {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    // Preserve output and the final exit frame before a normal close, including
    // when the snapshot is still in ws. Overflow closes discard that backlog.
    if (
      code === TERMINAL_CLOSE_CODES.NORMAL &&
      this.snapshotSending &&
      this.open
    ) {
      for (const encoded of this.queued) {
        this.socket.send(encoded, (error) => {
          if (error) this.socket.terminate();
        });
      }
    }
    this.clearSnapshot();
    this.socket.close(code);
    this.boundClose();
  }
  private clearSnapshot(): void {
    clearTimeout(this.snapshotTimeout);
    this.snapshotSending = false;
    this.queued = [];
    this.queuedBytes = 0;
  }
  private boundClose(): void {
    // A peer that never reads the close frame must not retain a viewer indefinitely.
    this.timeout ??= setTimeout(() => {
      this.socket.terminate();
    }, 1000);
    this.timeout.unref();
  }
}

export function createTerminalWebSocketTransport(
  options: TerminalRouteOptions,
): NodeWebSocketTransport {
  const server = new WebSocketServer({
    noServer: true,
    maxPayload: TERMINAL_MAX_INPUT_BYTES,
    handleProtocols: (protocols): string | false =>
      protocols.has(TERMINAL_PROTOCOL) ? TERMINAL_PROTOCOL : false,
  });
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  return {
    handleUpgrade(request, socket, head): void {
      if (
        !isAllowedDaemonHost(request.headers.host, options.host) ||
        !isLoopbackHost(options.host) ||
        !isAllowedTerminalOrigin(request.headers.origin, options.host)
      ) {
        rejectUpgrade(socket, 403);
        return;
      }
      const match = /^\/v1\/terminals\/([^/?]+)\/attach(?:\?.*)?$/u.exec(
        request.url ?? "",
      );
      if (stopping || !match) {
        rejectUpgrade(socket, 404);
        return;
      }
      server.handleUpgrade(request, socket, head, (webSocket) => {
        const viewer = new TerminalWebSocketViewer(webSocket);
        if (
          !isAuthorizedDaemonRequest(
            bearerAuthorization(request),
            options.authToken,
          )
        ) {
          viewer.close(TERMINAL_CLOSE_CODES.UNAUTHORIZED);
          return;
        }
        const session = options.manager.get(match[1]);
        if (session?.info.state !== "running") {
          viewer.close(TERMINAL_CLOSE_CODES.NOT_FOUND);
          return;
        }
        webSocket.once("close", () => {
          session.detach(viewer);
        });
        webSocket.on("message", (data, binary) => {
          if (binary || !viewer.open || !Buffer.isBuffer(data)) return;
          let message: unknown;
          try {
            message = JSON.parse(data.toString());
          } catch {
            return;
          }
          if (!message || typeof message !== "object" || !("type" in message))
            return;
          if (
            message.type === "input" &&
            "data" in message &&
            typeof message.data === "string"
          ) {
            session.input(message.data);
          } else if (
            message.type === "resize" &&
            "cols" in message &&
            "rows" in message &&
            validSize(message.cols, message.rows)
          ) {
            void session
              .resize(message.cols as number, message.rows as number)
              .catch(() => {
                viewer.close(TERMINAL_CLOSE_CODES.NOT_FOUND);
              });
          }
        });
        void session.attach(viewer).catch(() => {
          viewer.close(TERMINAL_CLOSE_CODES.NOT_FOUND);
        });
      });
    },
    stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      stopping = true;
      for (const socket of server.clients) socket.terminate();
      stopPromise = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      return stopPromise;
    },
  };
}
