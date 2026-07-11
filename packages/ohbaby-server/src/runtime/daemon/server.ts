import type { UiBackendClient } from "ohbaby-sdk";
import { createSessionIdGenerator } from "ohbaby-agent";
import { Hono, type Context } from "hono";
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
import { InstanceStore } from "../instance-store.js";
import {
  resolveWorkspaceScope,
  WorkspaceScopeError,
} from "../workspace-scope.js";
import { isAuthorizedDaemonRequest } from "../../auth/token.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4096;

function isLoopbackHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    host.startsWith("127.")
  );
}

export interface DaemonHttpServerOptions {
  readonly backend: WorkspaceBackend;
  readonly authToken?: string;
  readonly clientDisconnectRetentionMs?: number;
  readonly createSessionId?: () => string;
  readonly createWorkspaceBackend?: (
    scopeKey: string,
  ) => Promise<WorkspaceBackend> | WorkspaceBackend;
  readonly eventBufferCapacity?: number;
  readonly host?: string;
  readonly listKnownWorkspaceScopes?: () =>
    | Promise<readonly string[]>
    | readonly string[];
  readonly now?: () => number;
  readonly onClientConnected?: (clientId: string) => void;
  readonly onClientDisconnected?: (clientId: string) => void;
  readonly onShutdown?: () => Promise<void> | void;
  readonly packageVersion?: string;
  readonly port?: number;
  readonly permissionRouter?: PermissionRouter;
  readonly promptQueue?: DaemonPromptQueue;
  readonly scopeRoot?: string;
  readonly webAssetsDir?: string;
}

export type WorkspaceBackend = UiBackendClient & {
  dispose?(): Promise<void> | void;
};

export interface DaemonHttpServerHandle {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface ActiveDaemonConnection {
  readonly clientId: string;
  readonly connectedAt: number;
  readonly scopeKey: string;
}

type NormalizedDaemonHttpServerOptions = Omit<
  DaemonHttpServerOptions,
  "createSessionId" | "host" | "now" | "port"
> & {
  readonly createSessionId: () => string;
  readonly host: string;
  readonly now: () => number;
  readonly port: number;
};

interface WorkspaceAppInstance {
  readonly appHandle: DaemonServerAppHandle;
  dispose(): Promise<void>;
}

class DaemonHttpServer implements DaemonHttpServerHandle {
  private readonly app = new Hono();
  private readonly appHandle: DaemonServerAppHandle;
  private readonly instanceStore:
    | InstanceStore<WorkspaceAppInstance>
    | undefined;
  private readonly connections = new Map<
    string,
    ActiveDaemonConnection & { readonly count: number }
  >();
  private nodeServer: NodeListenHandle | undefined;

  constructor(private readonly options: NormalizedDaemonHttpServerOptions) {
    this.appHandle = this.createApp(options.backend, options.scopeRoot);
    this.instanceStore =
      options.scopeRoot === undefined ||
      options.createWorkspaceBackend === undefined
        ? undefined
        : new InstanceStore({
            create: (scopeKey: string): Promise<WorkspaceAppInstance> =>
              this.createWorkspaceInstance(scopeKey),
          });
    this.mountRoutes();
  }

  private createApp(
    backend: UiBackendClient,
    scopeKey: string | undefined,
  ): DaemonServerAppHandle {
    return createDaemonServerApp({
      authToken: this.options.authToken,
      backend,
      clientDisconnectRetentionMs: this.options.clientDisconnectRetentionMs,
      createSessionId: this.options.createSessionId,
      eventBufferCapacity: this.options.eventBufferCapacity,
      onClientConnected: (clientId): void => {
        this.clientConnected(scopeKey, clientId);
      },
      onClientDisconnected: (clientId): void => {
        this.clientDisconnected(scopeKey, clientId);
      },
      onShutdown: this.options.onShutdown,
      packageVersion: this.options.packageVersion,
      ...(scopeKey === this.options.scopeRoot
        ? {
            permissionRouter: this.options.permissionRouter,
            promptQueue: this.options.promptQueue,
          }
        : {}),
      ...(this.options.webAssetsDir === undefined
        ? {}
        : {
            webAssets: {
              allowTokenInjection: isLoopbackHost(this.options.host),
              directory: this.options.webAssetsDir,
              ...(scopeKey === undefined
                ? {}
                : { workspaceDirectory: scopeKey }),
            },
          }),
    });
  }

  private async createWorkspaceInstance(
    scopeKey: string,
  ): Promise<WorkspaceAppInstance> {
    const isInitialScope = scopeKey === this.options.scopeRoot;
    const backend = isInitialScope
      ? this.options.backend
      : await this.options.createWorkspaceBackend?.(scopeKey);
    if (!backend) {
      throw new Error(`No backend factory is available for ${scopeKey}`);
    }
    const appHandle = isInitialScope
      ? this.appHandle
      : this.createApp(backend, scopeKey);
    try {
      await appHandle.start();
    } catch (error) {
      await appHandle.dispose().catch(() => undefined);
      if (!isInitialScope) {
        await backend.dispose?.();
      }
      throw error;
    }
    return {
      appHandle,
      async dispose(): Promise<void> {
        await appHandle.dispose();
        if (!isInitialScope) {
          await backend.dispose?.();
        }
      },
    };
  }

  private mountRoutes(): void {
    if (!this.instanceStore) {
      this.app.all("*", (context) => this.appHandle.app.fetch(context.req.raw));
      return;
    }

    this.app.get("/v1/scopes", (context) => this.listScopes(context));
    this.app.get("/v1/connections", (context) => this.listConnections(context));
    const dispatch = (context: Context): Promise<Response> =>
      this.dispatchWorkspaceRequest(context);
    this.app.all("/api/rpc", dispatch);
    this.app.all("/api/events", dispatch);
    this.app.all("/v1", dispatch);
    this.app.all("/v1/*", dispatch);
    this.app.all("*", (context) => this.appHandle.app.fetch(context.req.raw));
  }

  private clientConnected(
    scopeKey: string | undefined,
    clientId: string,
  ): void {
    if (scopeKey === undefined) {
      this.options.onClientConnected?.(clientId);
      return;
    }
    const key = `${scopeKey}\u0000${clientId}`;
    const current = this.connections.get(key);
    this.connections.set(key, {
      clientId,
      connectedAt: current?.connectedAt ?? this.options.now(),
      count: (current?.count ?? 0) + 1,
      scopeKey,
    });
    this.options.onClientConnected?.(key);
  }

  private clientDisconnected(
    scopeKey: string | undefined,
    clientId: string,
  ): void {
    if (scopeKey === undefined) {
      this.options.onClientDisconnected?.(clientId);
      return;
    }
    const key = `${scopeKey}\u0000${clientId}`;
    const current = this.connections.get(key);
    if (current && current.count > 1) {
      this.connections.set(key, { ...current, count: current.count - 1 });
    } else {
      this.connections.delete(key);
    }
    this.options.onClientDisconnected?.(key);
  }

  private isAuthorized(context: Context): boolean {
    return isAuthorizedDaemonRequest(
      context.req.header("authorization"),
      this.options.authToken,
    );
  }

  private async listScopes(context: Context): Promise<Response> {
    if (!this.isAuthorized(context)) {
      return context.json(
        { error: { message: "Unauthorized" }, ok: false },
        401,
      );
    }
    const loaded = new Set(this.instanceStore?.loadedScopeKeys() ?? []);
    const candidates = new Set<string>(loaded);
    for (const directory of (await this.options.listKnownWorkspaceScopes?.()) ??
      []) {
      try {
        candidates.add(await resolveWorkspaceScope(directory));
      } catch (error) {
        if (!(error instanceof WorkspaceScopeError)) {
          throw error;
        }
      }
    }
    const scopes = [...candidates]
      .map((directory) => ({ directory, loaded: loaded.has(directory) }))
      .sort(
        (left, right) =>
          Number(right.loaded) - Number(left.loaded) ||
          left.directory.localeCompare(right.directory),
      );
    return context.json({ ok: true, scopes });
  }

  private listConnections(context: Context): Response {
    if (!this.isAuthorized(context)) {
      return context.json(
        { error: { message: "Unauthorized" }, ok: false },
        401,
      );
    }
    const connections = [...this.connections.values()]
      .map(({ clientId, connectedAt, scopeKey }) => ({
        clientId,
        connectedAt,
        scopeKey,
      }))
      .sort(
        (left, right) =>
          left.scopeKey.localeCompare(right.scopeKey) ||
          left.clientId.localeCompare(right.clientId),
      );
    return context.json({ connections, ok: true });
  }

  private async dispatchWorkspaceRequest(context: Context): Promise<Response> {
    const directory = context.req.header("x-ohbaby-directory") ?? "";
    try {
      const instance = await this.instanceStore?.load(directory);
      if (!instance) {
        throw new Error("Workspace routing is not configured");
      }
      return await instance.appHandle.app.fetch(context.req.raw);
    } catch (error) {
      if (error instanceof WorkspaceScopeError) {
        return context.json(
          { error: { code: error.code, message: error.message }, ok: false },
          400,
        );
      }
      throw error;
    }
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
      app: this.app,
      host: this.options.host,
      port: this.options.port,
    });
    try {
      if (this.instanceStore && this.options.scopeRoot) {
        await this.instanceStore.loadScope(this.options.scopeRoot);
      } else {
        await this.appHandle.start();
      }
    } catch (error) {
      await nodeServer.stop();
      throw error;
    }
    this.nodeServer = nodeServer;
  }

  async stop(): Promise<void> {
    try {
      if (this.instanceStore) {
        await this.instanceStore.disposeAll();
      } else {
        await this.appHandle.dispose();
      }
    } finally {
      this.connections.clear();
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
    clientDisconnectRetentionMs: options.clientDisconnectRetentionMs,
    createSessionId: options.createSessionId ?? createSessionIdGenerator(),
    createWorkspaceBackend: options.createWorkspaceBackend,
    eventBufferCapacity: options.eventBufferCapacity,
    host: options.host ?? DEFAULT_HOST,
    listKnownWorkspaceScopes: options.listKnownWorkspaceScopes,
    now: options.now ?? Date.now,
    onClientConnected: options.onClientConnected,
    onClientDisconnected: options.onClientDisconnected,
    onShutdown: options.onShutdown,
    packageVersion: options.packageVersion,
    permissionRouter: options.permissionRouter ?? new PermissionRouter(),
    port: options.port ?? DEFAULT_PORT,
    promptQueue: options.promptQueue,
    scopeRoot: options.scopeRoot,
    webAssetsDir: options.webAssetsDir,
  });
}
