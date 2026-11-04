import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { Hono } from "hono";
import { serve } from "@hono/node-server";

export interface NodeListenOptions {
  readonly app: Hono;
  readonly host: string;
  readonly port: number;
  readonly webSocket?: NodeWebSocketTransport;
}

export interface NodeWebSocketTransport {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  stop(): Promise<void>;
}

export interface NodeListenHandle {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  stop(): Promise<void>;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

export function isAddressInUseError(error: unknown): boolean {
  return isNodeError(error) && error.code === "EADDRINUSE";
}

export async function listenToNodeServer(
  options: NodeListenOptions,
): Promise<NodeListenHandle> {
  let currentPort = options.port;
  let server: Server | undefined;

  await new Promise<void>((resolve, reject) => {
    server = serve(
      {
        fetch: options.app.fetch,
        hostname: options.host,
        port: options.port,
      },
      (info) => {
        currentPort = info.port;
        resolve();
      },
    ) as Server;
    if (options.webSocket) {
      server.on("upgrade", (request, socket, head) => {
        options.webSocket?.handleUpgrade(request, socket, head);
      });
    }
    server.once("error", reject);
  });

  const startedServer = server;
  if (!startedServer) {
    throw new Error("node server failed to initialize");
  }

  return {
    host: options.host,
    port: currentPort,
    async stop(): Promise<void> {
      await options.webSocket?.stop();
      await new Promise<void>((resolve, reject) => {
        startedServer.close((error?: Error) => {
          if (
            error &&
            !(isNodeError(error) && error.code === "ERR_SERVER_NOT_RUNNING")
          ) {
            reject(error);
            return;
          }
          resolve();
        });
        // App disposal has already settled long-lived waiters and SSE streams.
        // Do not let an HTTP keep-alive socket keep daemon shutdown pending.
        startedServer.closeAllConnections();
      });
    },
    url: `http://${options.host.includes(":") && !options.host.startsWith("[") ? `[${options.host}]` : options.host}:${String(currentPort)}`,
  };
}
