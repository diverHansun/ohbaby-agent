import {
  parseSlashCommandInput,
  resolveSlashCommand,
  type UiBackendClient,
  type UiCommandCompletion,
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
import { createOhbabyWebStore, type OhbabyWebStore } from "../store/store.js";
import { GlobalLayer } from "./global-layer.js";
import { InstanceLayer } from "./instance-layer.js";

export interface OhbabyWebRuntime {
  readonly serverUrl?: string;
  readonly client: UiBackendClient | null;
  readonly ready: Promise<void>;
  readonly store: OhbabyWebStore;
  retryPermissions(): void;
  retrySession(): void;
  loadEarlierHistory(): Promise<void>;
  retryUnknownPrompts(): Promise<void>;
  forgetUnknownPrompt(clientRequestId: string): void;
  abortSession(sessionId: string, runId?: string): Promise<void>;
  archiveSession(sessionId: string): Promise<void>;
  exportSession(
    sessionId: string,
    format: "html" | "jsonl",
  ): Promise<UiSessionExport>;
  createSession(): Promise<void>;
  dispose(): Promise<void>;
  executeSlashCommand(input: {
    readonly allowOverlay?: boolean;
    readonly clientRequestId?: string;
    readonly sessionId?: string;
    readonly text: string;
  }): Promise<UiCommandCompletion>;
  getWorkspaceSnapshot(): WorkspaceSnapshot;
  getDirectoryPickerRoots(): Promise<DirectoryPickerRootsResponse>;
  hideWorkspace(directory: string): Promise<void>;
  listDirectoryPicker(directory: string): Promise<DirectoryPickerListResponse>;
  listWebCommands(): Promise<UiWebCommandCatalog>;
  openWorkspace(directory: string): Promise<void>;
  refreshWorkspaces(): Promise<void>;
  selectSession(sessionId: string): Promise<void>;
  subscribeWorkspaces(listener: () => void): () => void;
  switchWorkspace(directory: string): Promise<void>;
}

function createClientInvocationId(): string {
  return globalThis.crypto.randomUUID();
}

/** Façade over the global layer (projects) and the instance layer (connection). */
class BrowserOhbabyWebRuntime implements OhbabyWebRuntime {
  readonly store = createOhbabyWebStore();
  readonly ready: Promise<void>;
  private readonly global: GlobalLayer;
  private readonly instance: InstanceLayer;

  constructor(
    private readonly config: OhbabyBootstrapConfig,
    fetchImpl: typeof fetch | undefined,
  ) {
    this.global = new GlobalLayer(config, fetchImpl);
    this.instance = new InstanceLayer(
      config,
      fetchImpl,
      this.store,
      this.global,
    );
    this.ready = this.initialize();
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

  async createSession(): Promise<void> {
    this.instance.beginUserSelection();
    await this.instance.requireClient().createSessionForRuntime();
  }

  dispose(): Promise<void> {
    return this.instance.dispose();
  }

  async selectSession(sessionId: string): Promise<void> {
    this.instance.beginUserSelection();
    await this.instance.requireClient().selectSessionForRuntime(sessionId);
  }

  async archiveSession(sessionId: string): Promise<void> {
    await this.instance.requireClient().archiveSession({ sessionId });
  }

  exportSession(
    sessionId: string,
    format: "html" | "jsonl",
  ): Promise<UiSessionExport> {
    return this.instance.requireClient().exportSession({ sessionId, format });
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
    return this.global.getSnapshot();
  }

  subscribeWorkspaces(listener: () => void): () => void {
    return this.global.subscribe(listener);
  }

  refreshWorkspaces(): Promise<void> {
    return this.global.refreshScopes();
  }

  async openWorkspace(directory: string): Promise<void> {
    const opened = await this.global.openScope(directory);
    await this.global.refreshScopes();
    await this.instance.queueSwitch(opened, false);
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

  async hideWorkspace(directory: string): Promise<void> {
    await this.global.hideScope(directory);
    const wasSelected =
      this.global.getSnapshot().selectedDirectory === directory;
    await this.global.refreshScopes();
    if (!wasSelected) {
      return;
    }
    const next = this.global
      .getSnapshot()
      .scopes.find((scope) => scope.available);
    if (next) {
      await this.instance.queueSwitch(next.directory, false);
      return;
    }
    await this.instance.clearActive();
  }

  switchWorkspace(directory: string): Promise<void> {
    return this.instance.queueSwitch(directory, true);
  }

  private async initialize(): Promise<void> {
    const hintedDirectory = this.config.directory?.trim();
    try {
      await this.global.refreshScopes();
    } catch (error) {
      if (!hintedDirectory) {
        throw error;
      }
      this.global.controlPlaneAvailable = false;
      this.global.publish({
        scopes: [
          {
            available: true,
            directory: hintedDirectory,
            lastOpenedAt: 0,
            loaded: true,
            position: 0,
          },
        ],
        selectedDirectory: null,
      });
      await this.instance.queueSwitch(hintedDirectory, false);
      return;
    }
    const scopes = this.global.getSnapshot().scopes;
    let selectedDirectory: string | undefined;
    if (hintedDirectory) {
      const visibleHint = scopes.find(
        (scope) => scope.directory === hintedDirectory && scope.available,
      );
      if (visibleHint) {
        selectedDirectory = visibleHint.directory;
      } else {
        selectedDirectory = await this.global.openScope(hintedDirectory);
        await this.global.refreshScopes();
      }
    } else {
      const remembered = this.instance.rememberedDirectory;
      selectedDirectory = scopes.find(
        (scope) => scope.directory === remembered && scope.available,
      )?.directory;
      selectedDirectory ??= [...scopes]
        .filter((scope) => scope.available)
        .sort(
          (left, right) =>
            right.lastOpenedAt - left.lastOpenedAt ||
            left.position - right.position,
        )[0]?.directory;
    }
    if (selectedDirectory) {
      await this.instance.queueSwitch(selectedDirectory, false);
    }
  }
}

export function createOhbabyWebRuntime(
  config: OhbabyBootstrapConfig,
  options: { readonly fetch?: typeof fetch } = {},
): OhbabyWebRuntime {
  return new BrowserOhbabyWebRuntime(config, options.fetch);
}
