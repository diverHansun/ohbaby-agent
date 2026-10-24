import {
  globalSessionRequestDirectory,
  parseSlashCommandInput,
  resolveSlashCommand,
  type SubmitPromptOptions,
  type UiBackendClient,
  type UiCommandCompletion,
  type UiGlobalSession,
  type UiPromptReceipt,
  type UiSessionExport,
  type UiSlashCommandInvocation,
  type UiWebCommandCatalog,
} from "ohbaby-sdk";
import type {
  DirectoryPickerListResponse,
  DirectoryPickerRootsResponse,
  OhbabyBootstrapConfig,
  WorkspaceSnapshot,
} from "../api/daemon/wire.js";
import { createDraftStore, type DraftStore } from "../store/draft.js";
import type { GlobalCatalogStore } from "../store/global-catalog.js";
import { createOhbabyWebStore, type OhbabyWebStore } from "../store/store.js";
import { sessionMovedTarget, waitForSessionReady } from "./session-moved.js";
import { GlobalLayer } from "./global-layer.js";
import { InstanceLayer } from "./instance-layer.js";

/** A prompt is resent at most twice after `SESSION_MOVED` (three tries in all). */
const MAX_MOVED_RESENDS = 2;

export interface OhbabyWebRuntime {
  readonly serverUrl?: string;
  /** The connected instance client; null while no directory is usable. */
  readonly client: UiBackendClient | null;
  readonly ready: Promise<void>;
  /** Instance state of the open session or draft; reset on every switch. */
  readonly store: OhbabyWebStore;
  /** Projects and the global session list; survives switches. */
  readonly catalog: GlobalCatalogStore;
  readonly draft: DraftStore;
  retryPermissions(): void;
  retrySession(): void;
  loadEarlierHistory(): Promise<void>;
  retryUnknownPrompts(): Promise<void>;
  forgetUnknownPrompt(clientRequestId: string): void;
  /** Submits to the connected instance, following `SESSION_MOVED` to the new directory. */
  submitPrompt(
    text: string,
    options?: SubmitPromptOptions,
  ): Promise<UiPromptReceipt>;
  abortSession(sessionId: string, runId?: string): Promise<void>;
  /** `directory` defaults to the session's request directory. */
  archiveSession(sessionId: string, directory?: string): Promise<void>;
  exportSession(
    sessionId: string,
    format: "html" | "jsonl",
    directory?: string,
  ): Promise<UiSessionExport>;
  /** Creates or reuses an empty session in the connected instance. */
  createSession(): Promise<void>;
  /** A new-chat draft; `null` is No project and runs in the default workspace. */
  openDraft(projectDirectory?: string | null): Promise<void>;
  /** Opens a session at `directory`, or at its request directory when known. */
  openSession(sessionId: string, directory?: string): Promise<void>;
  /** Selects a session in the connected instance, e.g. after a first prompt. */
  selectSession(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
  executeSlashCommand(input: {
    readonly allowOverlay?: boolean;
    readonly clientRequestId?: string;
    readonly sessionId?: string;
    readonly text: string;
  }): Promise<UiCommandCompletion>;
  /** Projects plus the connected instance directory. */
  getWorkspaceSnapshot(): WorkspaceSnapshot;
  subscribeWorkspaces(listener: () => void): () => void;
  getDirectoryPickerRoots(): Promise<DirectoryPickerRootsResponse>;
  listDirectoryPicker(directory: string): Promise<DirectoryPickerListResponse>;
  listWebCommands(): Promise<UiWebCommandCatalog>;
  /** Registers a folder as a project and returns its directory; it does not switch. */
  openFolder(directory: string): Promise<string>;
  hideWorkspace(directory: string): Promise<void>;
  refreshCatalog(): Promise<void>;
  loadMoreSessions(
    enough: (sessions: readonly UiGlobalSession[]) => boolean,
  ): Promise<void>;
}

function createClientInvocationId(): string {
  return globalThis.crypto.randomUUID();
}

/** Façade over the global layer (projects, sessions) and the instance layer (connection). */
class BrowserOhbabyWebRuntime implements OhbabyWebRuntime {
  readonly store = createOhbabyWebStore();
  readonly draft = createDraftStore();
  readonly ready: Promise<void>;
  private readonly global: GlobalLayer;
  private readonly instance: InstanceLayer;
  private workspaceSnapshot: WorkspaceSnapshot = {
    scopes: [],
    selectedDirectory: null,
  };
  private readonly cleanups: (() => void)[] = [];
  /** A bound session missing from the list is refreshed for once, not on every index change. */
  private refreshedForSession: string | null = null;

  constructor(
    private readonly config: OhbabyBootstrapConfig,
    fetchImpl: typeof fetch | undefined,
  ) {
    this.global = new GlobalLayer(config, fetchImpl);
    this.instance = new InstanceLayer(config, fetchImpl, this.store);
    this.watchCatalogTriggers();
    this.ready = this.initialize();
  }

  get catalog(): GlobalCatalogStore {
    return this.global.catalog;
  }

  get serverUrl(): string {
    return this.config.baseUrl;
  }

  get client(): UiBackendClient | null {
    return this.instance.client ?? null;
  }

  retryPermissions(): void {
    this.instance.client?.retryPermissions();
  }
  retrySession(): void {
    this.instance.client?.retrySession();
  }
  async loadEarlierHistory(): Promise<void> {
    await this.instance.client?.loadEarlierHistory();
  }
  async retryUnknownPrompts(): Promise<void> {
    await this.instance.client?.retryUnknownPrompts();
  }
  forgetUnknownPrompt(clientRequestId: string): void {
    this.instance.client?.forgetUnknownPrompt(clientRequestId);
  }

  async submitPrompt(
    text: string,
    options?: SubmitPromptOptions,
  ): Promise<UiPromptReceipt> {
    for (let resends = 0; ; resends++) {
      const client = this.instance.requireClient();
      try {
        return await client.submitPromptAccepted(text, options);
      } catch (error) {
        const target = sessionMovedTarget(error);
        const sessionId = options?.sessionId;
        // Only an explicit rejection is resent: the server never admitted it.
        if (!target || !sessionId || resends >= MAX_MOVED_RESENDS) throw error;
        await this.instance.openSession(sessionId, target);
        await waitForSessionReady(this.store, sessionId);
      }
    }
  }

  async createSession(): Promise<void> {
    this.instance.beginUserSelection();
    await this.instance.requireClient().createSessionForRuntime();
  }

  async openDraft(projectDirectory: string | null = null): Promise<void> {
    this.draft.setProject(projectDirectory);
    const directory = this.draftDirectory();
    if (directory === null)
      throw new Error("The default workspace is not available yet");
    await this.instance.openDraft(directory);
  }

  async openSession(sessionId: string, directory?: string): Promise<void> {
    const target =
      directory ?? this.requestDirectory(sessionId) ?? this.instance.directory;
    if (target === null) throw new Error("No workspace is selected");
    await this.instance.openSession(sessionId, target);
  }

  async selectSession(sessionId: string): Promise<void> {
    const directory = this.instance.directory;
    if (directory === null) throw new Error("No workspace is selected");
    await this.instance.openSession(sessionId, directory);
  }

  async dispose(): Promise<void> {
    for (const cleanup of this.cleanups) cleanup();
    await this.instance.dispose();
  }

  async archiveSession(sessionId: string, directory?: string): Promise<void> {
    const target = directory ?? this.sessionDirectory(sessionId);
    const row = this.catalog
      .getSnapshot()
      .sessions.find((session) => session.id === sessionId);
    const wasOpen = this.boundSessionId() === sessionId;
    // The only optimistic sidebar change (04 §2.3): the row leaves at once
    // and returns if the server refuses.
    this.catalog.removeSession(sessionId);
    try {
      if (target === this.instance.directory && this.instance.client)
        await this.instance.client.archiveSession({ sessionId });
      else
        await (await this.global.scopedHttp(target)).archiveSession(sessionId);
    } catch (error) {
      if (row) this.catalog.upsertSession(row);
      throw error;
    }
    void this.global.refresh();
    if (wasOpen && this.boundSessionId() === sessionId)
      await this.openDraft(null).catch(() => undefined);
  }

  async exportSession(
    sessionId: string,
    format: "html" | "jsonl",
    directory?: string,
  ): Promise<UiSessionExport> {
    const target = directory ?? this.sessionDirectory(sessionId);
    if (target === this.instance.directory && this.instance.client)
      return this.instance.client.exportSession({ sessionId, format });
    const http = await this.global.scopedHttp(target);
    return (await http.exportSession({ sessionId, format })).export;
  }

  async abortSession(sessionId: string, runId?: string): Promise<void> {
    await this.instance
      .requireClient()
      .abortSessionForRuntime(sessionId, runId);
  }

  async executeSlashCommand(input: {
    readonly allowOverlay?: boolean;
    readonly clientRequestId?: string;
    readonly sessionId?: string;
    readonly text: string;
  }): Promise<UiCommandCompletion> {
    const client = this.instance.requireClient();
    const binding = this.store.getSnapshot().permissionSync.binding;
    const sessionId = input.sessionId ?? binding?.rootSessionId ?? undefined;
    const catalog = await client.listWebCommandsForRuntime();
    if (
      this.instance.client !== client ||
      this.store.getSnapshot().permissionSync.binding?.bindingGeneration !==
        binding?.bindingGeneration ||
      this.store.getSnapshot().permissionSync.binding?.permissionEpoch !==
        binding?.permissionEpoch
    )
      throw new Error("Selected session changed before command submission");
    const resolved = resolveSlashCommand(
      catalog,
      parseSlashCommandInput(input.text),
      { surface: "tui" },
    );
    if (!resolved.ok) {
      throw new Error(resolved.error.message);
    }
    const webCommand = catalog.commands.find(
      (command) => command.id === resolved.command.id,
    );
    if (
      webCommand?.executionKind === "overlay" &&
      input.allowOverlay !== true
    ) {
      throw new Error(`Command "${input.text}" must be opened from the UI`);
    }
    if (resolved.command.id === "new" || resolved.command.id === "resume") {
      this.instance.beginUserSelection();
    }
    const invocation = {
      argumentMode: resolved.command.argumentMode,
      argv: resolved.argv,
      body: resolved.body,
      clientInvocationId: createClientInvocationId(),
      ...(input.clientRequestId === undefined
        ? {}
        : { clientRequestId: input.clientRequestId }),
      commandId: resolved.command.id,
      path: resolved.path,
      raw: resolved.raw,
      rawArgs: resolved.rawArgs,
      ...(sessionId === undefined ? {} : { sessionId }),
      surface: "tui",
    } satisfies UiSlashCommandInvocation;
    this.store.beginCommand(invocation, input.allowOverlay === true);
    return client.executeCommand(invocation);
  }

  getWorkspaceSnapshot(): WorkspaceSnapshot {
    const scopes = this.catalog.getSnapshot().projects;
    const selectedDirectory = this.instance.directory;
    if (
      scopes !== this.workspaceSnapshot.scopes ||
      selectedDirectory !== this.workspaceSnapshot.selectedDirectory
    )
      this.workspaceSnapshot = { scopes, selectedDirectory };
    return this.workspaceSnapshot;
  }

  subscribeWorkspaces(listener: () => void): () => void {
    const stopCatalog = this.catalog.subscribe(listener);
    const stopInstance = this.instance.subscribe(listener);
    return () => {
      stopCatalog();
      stopInstance();
    };
  }

  refreshCatalog(): Promise<void> {
    return this.global.refresh();
  }

  loadMoreSessions(
    enough: (sessions: readonly UiGlobalSession[]) => boolean,
  ): Promise<void> {
    return this.global.loadMore(enough);
  }

  async openFolder(directory: string): Promise<string> {
    const opened = await this.global.openScope(directory);
    await this.global.refresh();
    return opened;
  }

  getDirectoryPickerRoots(): Promise<DirectoryPickerRootsResponse> {
    return this.global.getDirectoryPickerRoots();
  }

  listDirectoryPicker(directory: string): Promise<DirectoryPickerListResponse> {
    return this.global.listDirectoryPicker(directory);
  }

  listWebCommands(): Promise<UiWebCommandCatalog> {
    return this.instance.requireClient().listWebCommandsForRuntime();
  }

  /** The open session stays open; a draft aimed at the project falls back to No project. */
  async hideWorkspace(directory: string): Promise<void> {
    await this.global.hideScope(directory);
    await this.global.refresh();
    if (this.draft.getSnapshot().projectDirectory !== directory) return;
    if (this.boundSessionId() === null && this.instance.directory === directory)
      await this.openDraft(null);
    else this.draft.setProject(null);
  }

  private async initialize(): Promise<void> {
    const trimmed = this.config.directory?.trim();
    const hinted = trimmed === "" ? undefined : trimmed;
    const intent = this.config.startupIntent;
    const fresh =
      intent?.resumeSessionId !== undefined ||
      intent?.startupSessionMode?.type === "fresh";
    try {
      await this.global.refreshProjects();
    } catch (error) {
      if (!hinted) throw error;
      // A single-workspace daemon: no project or global session routes.
      this.global.controlPlaneAvailable = false;
      this.catalog.setProjects(
        [
          {
            available: true,
            directory: hinted,
            lastOpenedAt: 0,
            loaded: true,
            position: 0,
          },
        ],
        hinted,
      );
      await this.startIn(hinted, intent?.resumeSessionId, fresh);
      return;
    }
    await this.global.refreshSessions();
    const { defaultWorkspace, projects } = this.catalog.getSnapshot();
    const draftProject = this.draft.getSnapshot().projectDirectory;
    if (
      draftProject !== null &&
      !projects.some((project) => project.directory === draftProject)
    )
      this.draft.setProject(null);
    if (intent?.resumeSessionId !== undefined) {
      const sessionId = intent.resumeSessionId;
      const directory =
        this.requestDirectory(sessionId) ?? hinted ?? defaultWorkspace;
      if (directory) await this.instance.restore(directory, sessionId);
      return;
    }
    if (hinted) {
      let directory = hinted;
      if (
        directory !== defaultWorkspace &&
        !projects.some(
          (project) => project.directory === directory && project.available,
        )
      ) {
        directory = await this.global.openScope(directory);
        await this.global.refresh();
      }
      this.draft.setProject(directory === defaultWorkspace ? null : directory);
      await this.startIn(directory, undefined, fresh);
      return;
    }
    const last = this.instance.lastSession;
    if (last && !fresh) {
      await this.instance.restore(
        this.requestDirectory(last.sessionId) ?? last.directory,
        last.sessionId,
      );
      return;
    }
    const directory = this.draftDirectory();
    if (directory) await this.instance.openDraft(directory);
  }

  /** Startup in one directory: its remembered session unless told to start fresh. */
  private async startIn(
    directory: string,
    sessionId: string | undefined,
    fresh: boolean,
  ): Promise<void> {
    const last = this.instance.lastSession;
    const remembered =
      sessionId ??
      (!fresh && last?.directory === directory ? last.sessionId : undefined);
    if (remembered !== undefined || fresh)
      await this.instance.restore(directory, remembered);
    else await this.instance.openDraft(directory);
  }

  /** Directory a new-chat draft runs in: its project, else the default workspace. */
  private draftDirectory(): string | null {
    return (
      this.draft.getSnapshot().projectDirectory ??
      this.catalog.getSnapshot().defaultWorkspace
    );
  }

  private requestDirectory(sessionId: string): string | undefined {
    const row = this.catalog
      .getSnapshot()
      .sessions.find((session) => session.id === sessionId);
    return row ? globalSessionRequestDirectory(row) : undefined;
  }

  /** Where archive and export go: the request directory, else the open instance. */
  private sessionDirectory(sessionId: string): string {
    const directory =
      this.requestDirectory(sessionId) ?? this.instance.directory;
    if (directory === null) throw new Error("No workspace is selected");
    return directory;
  }

  private boundSessionId(): string | null {
    return (
      this.store.getSnapshot().permissionSync.binding?.rootSessionId ?? null
    );
  }

  /**
   * Keeps the global list current without polling: a newly created session,
   * titles from the live index, SSE reconnects and the window regaining focus.
   */
  private watchCatalogTriggers(): void {
    let index = this.store.getSnapshot().sessionIndex;
    let connection = this.store.getSnapshot().connectionState;
    let wasLive = false;
    this.cleanups.push(
      this.store.subscribe(() => {
        const snapshot = this.store.getSnapshot();
        if (snapshot.connectionState !== connection) {
          connection = snapshot.connectionState;
          if (connection === "live") {
            if (wasLive) void this.global.refresh();
            wasLive = true;
          }
        }
        if (snapshot.sessionIndex !== index) {
          index = snapshot.sessionIndex;
          this.syncFromInstanceIndex();
        }
      }),
    );
    if (typeof window === "undefined") return;
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void this.global.refresh();
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    this.cleanups.push(() => {
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    });
  }

  /**
   * Titles and times from the live index update rows in place, and a newly
   * bound session triggers one refresh. Without global routes the index is
   * the whole list.
   */
  private syncFromInstanceIndex(): void {
    const index = this.store.getSnapshot().sessionIndex;
    const directory = this.instance.directory;
    if (!this.global.controlPlaneAvailable) {
      if (directory !== null)
        this.catalog.replaceSessions(
          index
            .filter((entry) => !entry.parentId && !entry.isSubagent)
            .map((entry) => ({
              id: entry.id,
              title: entry.title,
              status: "active" as const,
              createdAt: entry.createdAt,
              updatedAt: entry.updatedAt,
              messageCount: 0,
              projectDirectory: directory,
              workingDirectory: directory,
            })),
          undefined,
        );
      return;
    }
    const rows = new Map(
      this.catalog.getSnapshot().sessions.map((row) => [row.id, row]),
    );
    for (const entry of index) {
      const row = rows.get(entry.id);
      if (
        row &&
        (row.title !== entry.title || row.updatedAt !== entry.updatedAt)
      )
        this.catalog.upsertSession({
          ...row,
          title: entry.title,
          updatedAt: entry.updatedAt,
        });
    }
    const bound = this.boundSessionId();
    if (
      bound !== null &&
      !rows.has(bound) &&
      bound !== this.refreshedForSession
    ) {
      this.refreshedForSession = bound;
      void this.global.refresh();
    }
  }
}

export function createOhbabyWebRuntime(
  config: OhbabyBootstrapConfig,
  options: { readonly fetch?: typeof fetch } = {},
): OhbabyWebRuntime {
  return new BrowserOhbabyWebRuntime(config, options.fetch);
}
