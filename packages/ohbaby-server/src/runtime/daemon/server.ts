import {
  isLoopbackHost,
  WORKSPACE_DIRECTORY_ENCODING_HEADER,
  WORKSPACE_DIRECTORY_ENCODING_PERCENT_UTF8,
  WORKSPACE_DIRECTORY_HEADER,
  type UiBackendClient,
} from "ohbaby-sdk";
import {
  createSessionIdGenerator,
  type WorkspaceRegistryStore,
} from "ohbaby-agent";
import { Hono, type Context } from "hono";
import {
  createDaemonServerApp,
  type DaemonServerAppHandle,
} from "../../app/create-app.js";
import { PermissionRouter } from "../../coordination/permission-router.js";
import {
  listenToNodeServer,
  type NodeListenHandle,
} from "../../transport/node-listen.js";
import { InstanceStore } from "../instance-store.js";
import {
  createDirectoryBrowser,
  DirectoryBrowserError,
  type DirectoryBrowser,
} from "../directory-browser.js";
import {
  resolveWorkspaceScope,
  WorkspaceScopeError,
} from "../workspace-scope.js";
import { isAuthorizedDaemonRequest } from "../../auth/token.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4096;

export interface DaemonHttpServerOptions {
  readonly backend: WorkspaceBackend;
  readonly authToken?: string;
  readonly clientDisconnectRetentionMs?: number;
  readonly createSessionId?: () => string;
  readonly createWorkspaceBackend?: (
    scopeKey: string,
  ) => Promise<WorkspaceBackend> | WorkspaceBackend;
  readonly directoryBrowser?: DirectoryBrowser;
  readonly eventBufferCapacity?: number;
  readonly host?: string;
  readonly listKnownWorkspaceScopes?: () =>
    | Promise<readonly string[]>
    | readonly string[];
  readonly now?: () => number;
  readonly workspaceRegistry?: WorkspaceRegistryStore;
  readonly onClientConnected?: (clientId: string) => void;
  readonly onClientDisconnected?: (clientId: string) => void;
  readonly onShutdown?: () => Promise<void> | void;
  readonly packageVersion?: string;
  readonly port?: number;
  readonly permissionRouter?: PermissionRouter;
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
  loadWorkspaceScopes?(scopeKeys: readonly string[]): Promise<void>;
}

export interface ActiveDaemonConnection {
  readonly clientId: string;
  readonly connectedAt: number;
  readonly scopeKey: string;
}

type NormalizedDaemonHttpServerOptions = Omit<
  DaemonHttpServerOptions,
  "createSessionId" | "directoryBrowser" | "host" | "now" | "port"
> & {
  readonly createSessionId: () => string;
  readonly directoryBrowser: DirectoryBrowser;
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
    this.app.post("/v1/scopes/open", (context) => this.openScope(context));
    this.app.post("/v1/scopes/hide", (context) => this.hideScope(context));
    this.app.get("/v1/directory-picker/roots", (context) =>
      this.listDirectoryPickerRoots(context),
    );
    this.app.post("/v1/directory-picker/list", (context) =>
      this.listDirectoryPickerDirectory(context),
    );
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
    const available = new Set<string>(loaded);
    for (const directory of (await this.options.listKnownWorkspaceScopes?.()) ??
      []) {
      try {
        available.add(await resolveWorkspaceScope(directory));
      } catch (error) {
        if (!(error instanceof WorkspaceScopeError)) {
          throw error;
        }
      }
    }
    const registry = this.options.workspaceRegistry;
    if (!registry) {
      const scopes = [...available]
        .map((directory) => ({ directory, loaded: loaded.has(directory) }))
        .sort(
          (left, right) =>
            Number(right.loaded) - Number(left.loaded) ||
            left.directory.localeCompare(right.directory),
        );
      return context.json({ ok: true, scopes });
    }

    for (const entry of registry.list()) {
      if (entry.visibility !== "visible" || available.has(entry.scopeKey)) {
        continue;
      }
      try {
        const canonical = await resolveWorkspaceScope(entry.scopeKey);
        if (canonical === entry.scopeKey) {
          available.add(entry.scopeKey);
        }
      } catch (error) {
        if (!(error instanceof WorkspaceScopeError)) {
          throw error;
        }
      }
    }
    registry.ensureDiscovered([...available]);
    const scopes = registry
      .list()
      .filter((entry) => entry.visibility === "visible")
      .map((entry) => ({
        available: available.has(entry.scopeKey),
        directory: entry.scopeKey,
        lastOpenedAt: entry.lastOpenedAt,
        loaded: loaded.has(entry.scopeKey),
        position: entry.position,
      }));
    return context.json({ ok: true, scopes });
  }

  private async readDirectoryBody(
    context: Context,
  ): Promise<{ readonly directory: string } | Response> {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json(
        {
          error: { code: "INVALID_JSON", message: "Expected a JSON body" },
          ok: false,
        },
        400,
      );
    }
    if (
      typeof body !== "object" ||
      body === null ||
      !("directory" in body) ||
      typeof body.directory !== "string" ||
      body.directory.length === 0
    ) {
      return context.json(
        {
          error: {
            code: "INVALID_DIRECTORY",
            message: "directory must be a non-empty string",
          },
          ok: false,
        },
        400,
      );
    }
    return { directory: body.directory };
  }

  private async openScope(context: Context): Promise<Response> {
    if (!this.isAuthorized(context)) {
      return context.json(
        { error: { message: "Unauthorized" }, ok: false },
        401,
      );
    }
    const input = await this.readDirectoryBody(context);
    if (input instanceof Response) {
      return input;
    }
    return this.openScopeDirectory(context, input.directory);
  }

  private async openScopeDirectory(
    context: Context,
    requestedDirectory: string,
    options: { readonly cancelled?: false } = {},
  ): Promise<Response> {
    try {
      const directory = await resolveWorkspaceScope(requestedDirectory);
      const entry = this.options.workspaceRegistry?.open(directory);
      return context.json({
        ...options,
        ok: true,
        scope: {
          available: true,
          directory,
          lastOpenedAt: entry?.lastOpenedAt ?? this.options.now(),
          loaded: this.instanceStore?.get(directory) !== undefined,
          position: entry?.position ?? 0,
        },
      });
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

  private async listDirectoryPickerRoots(context: Context): Promise<Response> {
    const forbidden = this.directoryBrowserForbidden(context);
    if (forbidden) {
      return forbidden;
    }
    return context.json({
      ok: true,
      roots: await this.options.directoryBrowser.listRoots(),
    });
  }

  private async listDirectoryPickerDirectory(
    context: Context,
  ): Promise<Response> {
    const forbidden = this.directoryBrowserForbidden(context);
    if (forbidden) {
      return forbidden;
    }
    const input = await this.readDirectoryBody(context);
    if (input instanceof Response) {
      return input;
    }
    try {
      return context.json({
        ok: true,
        ...(await this.options.directoryBrowser.list(input.directory)),
      });
    } catch (error) {
      if (error instanceof DirectoryBrowserError) {
        return context.json(
          { error: { code: error.code, message: error.message }, ok: false },
          400,
        );
      }
      throw error;
    }
  }

  private directoryBrowserForbidden(context: Context): Response | undefined {
    if (!this.isAuthorized(context)) {
      return context.json(
        { error: { message: "Unauthorized" }, ok: false },
        401,
      );
    }
    if (!isLoopbackHost(this.options.host)) {
      return context.json(
        {
          error: {
            code: "DIRECTORY_BROWSER_LOOPBACK_ONLY",
            message: "Directory browsing is available only on loopback hosts",
          },
          ok: false,
        },
        403,
      );
    }
    return undefined;
  }

  private async hideScope(context: Context): Promise<Response> {
    if (!this.isAuthorized(context)) {
      return context.json(
        { error: { message: "Unauthorized" }, ok: false },
        401,
      );
    }
    const input = await this.readDirectoryBody(context);
    if (input instanceof Response) {
      return input;
    }
    const registry = this.options.workspaceRegistry;
    if (registry?.hide(input.directory) !== true) {
      return context.json(
        {
          error: {
            code: "WORKSPACE_NOT_REGISTERED",
            message: "Workspace is not registered",
          },
          ok: false,
        },
        404,
      );
    }
    return context.json({ directory: input.directory, ok: true });
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
    const directory = this.workspaceDirectoryFromRequest(context);
    if (directory instanceof Response) {
      return directory;
    }
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

  private workspaceDirectoryFromRequest(context: Context): string | Response {
    const directory = context.req.header(WORKSPACE_DIRECTORY_HEADER) ?? "";
    if (
      context.req.header(WORKSPACE_DIRECTORY_ENCODING_HEADER) !==
      WORKSPACE_DIRECTORY_ENCODING_PERCENT_UTF8
    ) {
      return directory;
    }
    try {
      return decodeURIComponent(directory);
    } catch {
      return context.json(
        {
          error: {
            code: "INVALID_DIRECTORY",
            message: "x-ohbaby-directory percent encoding is invalid",
          },
          ok: false,
        },
        400,
      );
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

  async loadWorkspaceScopes(scopeKeys: readonly string[]): Promise<void> {
    if (!this.instanceStore) {
      return;
    }
    for (const scopeKey of scopeKeys) {
      const canonical = await resolveWorkspaceScope(scopeKey);
      await this.instanceStore.loadScope(canonical);
    }
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
    directoryBrowser: options.directoryBrowser ?? createDirectoryBrowser(),
    eventBufferCapacity: options.eventBufferCapacity,
    host: options.host ?? DEFAULT_HOST,
    listKnownWorkspaceScopes: options.listKnownWorkspaceScopes,
    workspaceRegistry: options.workspaceRegistry,
    now: options.now ?? Date.now,
    onClientConnected: options.onClientConnected,
    onClientDisconnected: options.onClientDisconnected,
    onShutdown: options.onShutdown,
    packageVersion: options.packageVersion,
    permissionRouter: options.permissionRouter ?? new PermissionRouter(),
    port: options.port ?? DEFAULT_PORT,
    scopeRoot: options.scopeRoot,
    webAssetsDir: options.webAssetsDir,
  });
}
