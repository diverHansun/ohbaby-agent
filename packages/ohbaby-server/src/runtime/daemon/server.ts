import { dirname } from "node:path";
import { registerGlobalSettingsRoutes } from "../../protocols/web/routes/global-settings.js";
import type {
  InstanceSettingsReader,
  InstanceSettingsControl,
  SettingsDomain,
} from "ohbaby-agent";
import {
  isLoopbackHost,
  REQUEST_DIRECTORY_ENCODING_HEADER,
  REQUEST_DIRECTORY_ENCODING_PERCENT_UTF8,
  REQUEST_DIRECTORY_HEADER,
  type UiBackendClient,
} from "ohbaby-sdk";
import {
  createSessionIdGenerator,
  createShutdownOptions,
  collectCleanup,
  ensureDefaultDirectory,
  isDefaultDirectory,
  type SessionWorkspaceMovePlan,
  type CleanupResult,
  type CleanupTaskResult,
  type ShutdownOptions,
  type Logger,
  type UiPromptQueueExecutionPort,
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
import {
  moveSessionWorkspace,
  type GlobalSessionCatalog,
} from "../../coordination/session-workspace-move.js";
import {
  globalSessionErrorStatus,
  parseGlobalSessionLimit,
  parseSessionWorkspaceUpdate,
  toUiGlobalSession,
  toUiGlobalSessionPage,
  toUiSessionSearchPage,
} from "../../protocols/global-sessions.js";

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
  readonly logger?: Logger;
  readonly now?: () => number;
  readonly sessionCatalog?: GlobalSessionCatalog;
  readonly workspaceRegistry?: WorkspaceRegistryStore;
  readonly onClientConnected?: (clientId: string) => void;
  readonly onClientDisconnected?: (clientId: string) => void;
  readonly onShutdown?: () => Promise<void> | void;
  readonly packageVersion?: string;
  readonly diagnosticsFile?: string;
  readonly port?: number;
  readonly permissionRouter?: PermissionRouter;
  readonly scopeRoot?: string;
  readonly webAssetsDir?: string;
}

export type WorkspaceBackend = UiBackendClient &
  UiPromptQueueExecutionPort &
  Partial<InstanceSettingsReader & InstanceSettingsControl> & {
    /** Persistent workspaces take over a moved session's queued prompts. */
    adoptSessionWorkspaceMove?(plan: SessionWorkspaceMovePlan): Promise<void>;
    closeAdmission?(): void;
    dispose?(
      options?: ShutdownOptions,
    ): Promise<CleanupTaskResult> | CleanupTaskResult;
  };

export interface DaemonHttpServerHandle {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  start(): Promise<void>;
  closeAdmission?(): void;
  stop(options?: ShutdownOptions): Promise<CleanupTaskResult>;
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
  readonly backend: WorkspaceBackend;
  closeAdmission(): void;
  dispose(options?: ShutdownOptions): Promise<void>;
}

class DaemonHttpServer implements DaemonHttpServerHandle {
  private assertOpen(): void {
    if (this.closing) throw new Error("Daemon server is closing");
  }
  private readonly app = new Hono();
  private readonly appHandle: DaemonServerAppHandle;
  private readonly instanceStore:
    | InstanceStore<WorkspaceAppInstance>
    | undefined;
  private readonly connections = new Map<
    string,
    ActiveDaemonConnection & { readonly count: number }
  >();
  private closing = false;
  private stopPromise?: Promise<CleanupResult>;
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
    backend: WorkspaceBackend,
    scopeKey: string | undefined,
  ): DaemonServerAppHandle {
    return createDaemonServerApp({
      authToken: this.options.authToken,
      backend,
      clientDisconnectRetentionMs: this.options.clientDisconnectRetentionMs,
      createSessionId: this.options.createSessionId,
      eventBufferCapacity: this.options.eventBufferCapacity,
      logger: this.options.logger,
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

  private async notifySettingsChanged(
    domains: readonly SettingsDomain[],
  ): Promise<void> {
    const store = this.instanceStore;
    if (!store) return;
    // Failed creation/delivery must not turn a completed disk save into a failure.
    await Promise.allSettled(
      store.loadedScopeKeys().map(async (key) => {
        const instance = await store.get(key);
        await instance?.backend.notifySettingsChanged?.(domains);
      }),
    );
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
      if (!this.closing) await appHandle.start();
    } catch (error) {
      await appHandle.dispose().catch(() => undefined);
      if (!isInitialScope) {
        await backend.dispose?.();
      }
      throw error;
    }
    return {
      appHandle,
      backend,
      closeAdmission(): void {
        backend.closeAdmission?.();
      },
      async dispose(options = createShutdownOptions()): Promise<void> {
        backend.closeAdmission?.();
        const result = await collectCleanup(options, {
          app: () => appHandle.dispose(),
          ...(isInitialScope
            ? {}
            : {
                backend: (): Promise<CleanupTaskResult> | CleanupTaskResult =>
                  backend.dispose?.(options),
              }),
        });
        if (result.status === "unconfirmed")
          throw new Error(result.errors.join("; "));
      },
    };
  }

  private mountRoutes(): void {
    this.app.use("*", async (context, next) => {
      if (this.closing)
        return context.json(
          { ok: false, error: { message: "Daemon server is closing" } },
          503,
        );
      await next();
      return;
    });
    if (!this.instanceStore) {
      this.app.all("*", (context) => this.appHandle.app.fetch(context.req.raw));
      return;
    }

    registerGlobalSettingsRoutes(this.app, {
      isAuthorized: (header) =>
        isAuthorizedDaemonRequest(header, this.options.authToken),
      loadedDirectories: () => this.instanceStore?.loadedScopeKeys() ?? [],
      notify: (domains) => this.notifySettingsChanged(domains),
      packageVersion: this.options.packageVersion,
      diagnosticsFile: this.options.diagnosticsFile,
      logDirectory: this.options.diagnosticsFile
        ? dirname(this.options.diagnosticsFile)
        : undefined,
    });

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
    this.app.get("/v1/sessions/search", (context) =>
      this.searchGlobalSessions(context),
    );
    this.app.get("/v1/sessions", (context) => this.listGlobalSessions(context));
    this.app.post("/v1/sessions/:sessionId/workspace", (context) =>
      this.moveSessionWorkspace(context),
    );
    // A retired global endpoint must not fall through to scoped dispatch,
    // which would otherwise require a request-directory header and return 400.
    this.app.post("/v1/sessions/:sessionId/project", (context) =>
      context.notFound(),
    );
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
    // The default directory runs sessions without a workspace; it is never
    // listed or registered as one.
    const defaultDirectory = {
      directory: await ensureDefaultDirectory(),
    };
    const loaded = new Set(
      (this.instanceStore?.loadedScopeKeys() ?? []).filter(
        (directory) => !isDefaultDirectory(directory),
      ),
    );
    const available = new Set<string>(loaded);
    for (const directory of (await this.options.listKnownWorkspaceScopes?.()) ??
      []) {
      try {
        const scope = await resolveWorkspaceScope(directory);
        if (!isDefaultDirectory(scope)) available.add(scope);
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
      return context.json({ defaultDirectory, ok: true, scopes });
    }

    for (const entry of registry.list()) {
      if (
        entry.visibility !== "visible" ||
        available.has(entry.scopeKey) ||
        isDefaultDirectory(entry.scopeKey)
      ) {
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
    await registry.ensureDiscovered([...available]);
    const scopes = registry
      .list()
      .filter(
        (entry) =>
          entry.visibility === "visible" && !isDefaultDirectory(entry.scopeKey),
      )
      .map((entry) => ({
        available: available.has(entry.scopeKey),
        directory: entry.scopeKey,
        lastOpenedAt: entry.lastOpenedAt,
        loaded: loaded.has(entry.scopeKey),
        position: entry.position,
      }));
    return context.json({ defaultDirectory, ok: true, scopes });
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
      if (isDefaultDirectory(directory)) {
        return context.json(
          {
            error: {
              code: "DEFAULT_DIRECTORY_NOT_WORKSPACE",
              message: "The default directory cannot be opened as a workspace",
            },
            ok: false,
          },
          400,
        );
      }
      const entry = await this.options.workspaceRegistry?.open(directory);
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
    if ((await registry?.hide(input.directory)) !== true) {
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

  private unauthorized(context: Context): Response | undefined {
    return this.isAuthorized(context)
      ? undefined
      : context.json({ error: { message: "Unauthorized" }, ok: false }, 401);
  }

  /** Global session routes report typed failures; anything else is a server error. */
  private globalSessionFailure(context: Context, error: unknown): Response {
    const status = globalSessionErrorStatus(error);
    if (status === 500) throw error;
    const failure = error as {
      readonly code: string;
      readonly message: string;
    };
    return context.json(
      { error: { code: failure.code, message: failure.message }, ok: false },
      status,
    );
  }

  private globalSessionCatalog(
    context: Context,
  ): GlobalSessionCatalog | Response {
    return (
      this.unauthorized(context) ??
      this.options.sessionCatalog ??
      context.json(
        {
          error: {
            code: "SESSION_CATALOG_UNAVAILABLE",
            message: "Global session catalog is not configured",
          },
          ok: false,
        },
        501,
      )
    );
  }

  private listGlobalSessions(context: Context): Response {
    const catalog = this.globalSessionCatalog(context);
    if (catalog instanceof Response) return catalog;
    try {
      const page = catalog.list({
        limit: parseGlobalSessionLimit(context.req.query("limit")),
        cursor: context.req.query("cursor"),
      });
      return context.json({ ok: true, ...toUiGlobalSessionPage(page) });
    } catch (error) {
      return this.globalSessionFailure(context, error);
    }
  }

  private searchGlobalSessions(context: Context): Response {
    const catalog = this.globalSessionCatalog(context);
    if (catalog instanceof Response) return catalog;
    try {
      const page = catalog.search({
        query: context.req.query("q") ?? "",
        limit: parseGlobalSessionLimit(context.req.query("limit")),
        cursor: context.req.query("cursor"),
      });
      return context.json({ ok: true, ...toUiSessionSearchPage(page) });
    } catch (error) {
      return this.globalSessionFailure(context, error);
    }
  }

  private async moveSessionWorkspace(context: Context): Promise<Response> {
    const catalog = this.globalSessionCatalog(context);
    if (catalog instanceof Response) return catalog;
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
    try {
      const session = await moveSessionWorkspace(
        {
          catalog,
          resolveScope: resolveWorkspaceScope,
          isDefaultDirectory: isDefaultDirectory,
          discoverWorkspace: (directory) =>
            this.options.workspaceRegistry?.ensureDiscovered([directory]) ??
            Promise.resolve(),
          loadQueueOwner: async (directory) =>
            (await this.instanceStore?.load(directory))?.backend,
        },
        context.req.param("sessionId") ?? "",
        parseSessionWorkspaceUpdate(body),
      );
      return context.json({ ok: true, session: toUiGlobalSession(session) });
    } catch (error) {
      return this.globalSessionFailure(context, error);
    }
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
    const directory = context.req.header(REQUEST_DIRECTORY_HEADER) ?? "";
    if (
      context.req.header(REQUEST_DIRECTORY_ENCODING_HEADER) !==
      REQUEST_DIRECTORY_ENCODING_PERCENT_UTF8
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
    this.assertOpen();
    if (this.nodeServer) {
      return;
    }

    const nodeServer = await listenToNodeServer({
      app: this.app,
      host: this.options.host,
      port: this.options.port,
    });
    try {
      this.assertOpen();
      if (this.instanceStore && this.options.scopeRoot) {
        await this.instanceStore.loadScope(this.options.scopeRoot);
      } else {
        await this.appHandle.start();
      }
      this.assertOpen();
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

  closeAdmission(): void {
    if (this.closing) return;
    this.closing = true;
    this.options.backend.closeAdmission?.();
    this.instanceStore?.closeAdmission();
  }

  stop(options = createShutdownOptions()): Promise<CleanupResult> {
    if (this.stopPromise) return this.stopPromise;
    this.closeAdmission();
    const nodeServer = this.nodeServer;
    this.nodeServer = undefined;
    this.connections.clear();
    this.stopPromise = collectCleanup(options, {
      workspaces: () =>
        this.instanceStore
          ? this.instanceStore.disposeAll(options)
          : this.appHandle.dispose(),
      transport: () => nodeServer?.stop(),
    });
    return this.stopPromise;
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
    logger: options.logger,
    sessionCatalog: options.sessionCatalog,
    workspaceRegistry: options.workspaceRegistry,
    now: options.now ?? Date.now,
    onClientConnected: options.onClientConnected,
    onClientDisconnected: options.onClientDisconnected,
    onShutdown: options.onShutdown,
    packageVersion: options.packageVersion,
    diagnosticsFile: options.diagnosticsFile,
    permissionRouter: options.permissionRouter ?? new PermissionRouter(),
    port: options.port ?? DEFAULT_PORT,
    scopeRoot: options.scopeRoot,
    webAssetsDir: options.webAssetsDir,
  });
}
