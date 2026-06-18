import type { Server } from "node:http";
import type { Hono } from "hono";
import { serve } from "@hono/node-server";

export interface NodeListenOptions {
  readonly app: Hono;
  readonly host: string;
  readonly port: number;
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
      });
    },
    url: `http://${options.host}:${String(currentPort)}`,
  };
}
