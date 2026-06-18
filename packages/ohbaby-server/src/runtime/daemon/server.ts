import type { UiBackendClient } from "ohbaby-sdk";
import { createSessionIdGenerator } from "ohbaby-agent";
import {
  createDaemonServerApp,
  type DaemonServerAppHandle,
} from "../../app/create-app.js";
import { PermissionRouter } from "../../coordination/permission-router.js";
import { DaemonPromptQueue } from "../../coordination/prompt-queue.js";
import {
  listenToNodeServer,
  type NodeListenHandle,
} from "../../transport/node-listen.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4096;

export interface DaemonHttpServerOptions {
  readonly backend: UiBackendClient;
  readonly authToken?: string;
  readonly createSessionId?: () => string;
  readonly eventBufferCapacity?: number;
  readonly host?: string;
  readonly onClientConnected?: (clientId: string) => void;
  readonly onClientDisconnected?: (clientId: string) => void;
  readonly onShutdown?: () => Promise<void> | void;
  readonly packageVersion?: string;
  readonly port?: number;
  readonly permissionRouter?: PermissionRouter;
  readonly promptQueue?: DaemonPromptQueue;
}

export interface DaemonHttpServerHandle {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

type NormalizedDaemonHttpServerOptions = Omit<
  DaemonHttpServerOptions,
  "createSessionId" | "host" | "port"
> & {
  readonly createSessionId: () => string;
  readonly host: string;
  readonly port: number;
};

class DaemonHttpServer implements DaemonHttpServerHandle {
  private readonly appHandle: DaemonServerAppHandle;
  private nodeServer: NodeListenHandle | undefined;

  constructor(private readonly options: NormalizedDaemonHttpServerOptions) {
    this.appHandle = createDaemonServerApp({
      authToken: options.authToken,
      backend: options.backend,
      createSessionId: options.createSessionId,
      eventBufferCapacity: options.eventBufferCapacity,
      onClientConnected: options.onClientConnected,
      onClientDisconnected: options.onClientDisconnected,
      onShutdown: options.onShutdown,
      packageVersion: options.packageVersion,
      permissionRouter: options.permissionRouter,
      promptQueue: options.promptQueue,
    });
  }

  get host(): string {
    return this.nodeServer?.host ?? this.options.host;
  }

  get port(): number {
    return this.nodeServer?.port ?? this.options.port;
  }

  get url(): string {
    return this.nodeServer?.url ?? `http://${this.host}:${String(this.port)}`;
  }

  async start(): Promise<void> {
    if (this.nodeServer) {
      return;
    }

    const nodeServer = await listenToNodeServer({
      app: this.appHandle.app,
      host: this.options.host,
      port: this.options.port,
    });
    try {
      await this.appHandle.start();
    } catch (error) {
      await nodeServer.stop();
      throw error;
    }
    this.nodeServer = nodeServer;
  }

  async stop(): Promise<void> {
    try {
      await this.appHandle.dispose();
    } finally {
      const nodeServer = this.nodeServer;
      this.nodeServer = undefined;
      await nodeServer?.stop();
    }
  }
}

export function createDaemonHttpServer(
  options: DaemonHttpServerOptions,
): DaemonHttpServerHandle {
  return new DaemonHttpServer({
    backend: options.backend,
    authToken: options.authToken,
    createSessionId: options.createSessionId ?? createSessionIdGenerator(),
    eventBufferCapacity: options.eventBufferCapacity,
    host: options.host ?? DEFAULT_HOST,
    onClientConnected: options.onClientConnected,
    onClientDisconnected: options.onClientDisconnected,
    onShutdown: options.onShutdown,
    packageVersion: options.packageVersion,
    permissionRouter: options.permissionRouter ?? new PermissionRouter(),
    port: options.port ?? DEFAULT_PORT,
    promptQueue: options.promptQueue,
  });
}
