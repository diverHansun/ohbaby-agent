import {
  createBrowserDaemonClient,
  type BrowserDaemonClient,
} from "../api/daemon/client.js";
import {
  readWebNavigationState,
  replaceNavigationHash,
  writeWebNavigationState,
  type WebNavigationState,
} from "../api/daemon/navigation-state.js";
import type { OhbabyBootstrapConfig } from "../api/daemon/wire.js";
import type { OhbabyWebStore } from "../store/store.js";

/**
 * The single directory-bound connection: one `BrowserDaemonClient` and its
 * SSE at a time, chosen by the open session's request directory or, for a
 * draft, by the draft's directory. Switching closes the old client before
 * the new one starts, and a selection generation keeps late restores from
 * overriding a newer user choice.
 */
export class InstanceLayer {
  private activeClient: BrowserDaemonClient | undefined;
  private directoryValue: string | null = null;
  private disposed = false;
  private connectedOnce = false;
  private restoring = false;
  /** A remembered session whose index read failed; retried when the index arrives. */
  private pendingRestore: string | null = null;
  private selectionGeneration = 0;
  private navigationState: WebNavigationState;
  private queue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly config: OhbabyBootstrapConfig,
    private readonly fetchImpl: typeof fetch | undefined,
    private readonly store: OhbabyWebStore,
  ) {
    this.navigationState = readWebNavigationState();
    let priorIndex = this.store.getSnapshot().sessionIndex;
    this.store.subscribe(() => {
      const index = this.store.getSnapshot().sessionIndex;
      if (index !== priorIndex) {
        priorIndex = index;
        void this.retryPendingRestore();
      }
      this.persistActiveSession();
    });
  }

  get client(): BrowserDaemonClient | undefined {
    return this.activeClient;
  }

  /** Directory of the connected instance; null before the first connection. */
  get directory(): string | null {
    return this.directoryValue;
  }

  get lastSession(): WebNavigationState["lastSession"] {
    return this.navigationState.lastSession;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  requireClient(): BrowserDaemonClient {
    if (!this.activeClient) {
      throw new Error("No workspace is selected");
    }
    return this.activeClient;
  }

  /** An explicit user selection wins over any pending restore. */
  beginUserSelection(): void {
    this.selectionGeneration += 1;
    this.pendingRestore = null;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.activeClient?.close();
    this.activeClient = undefined;
  }

  /**
   * A new-chat draft: a client at `directory` with no session bound. The
   * first prompt creates the session there. A fresh client is needed even in
   * the same directory, since the server keeps one selection per client.
   */
  openDraft(directory: string): Promise<void> {
    this.beginUserSelection();
    this.forgetLastSession();
    const generation = this.selectionGeneration;
    return this.enqueue(async () => {
      // A later choice already superseded this one.
      if (generation !== this.selectionGeneration) return;
      const binding = this.store.getSnapshot().permissionSync.binding;
      if (
        this.activeClient &&
        this.directoryValue === directory &&
        binding !== null &&
        binding.rootSessionId === null
      )
        return;
      await this.connect(directory);
    });
  }

  /**
   * Opens a session at its request directory. In the connected directory it
   * selects at once, even while a restore waits; elsewhere it reconnects.
   */
  openSession(sessionId: string, directory: string): Promise<void> {
    this.beginUserSelection();
    const generation = this.selectionGeneration;
    if (this.activeClient && this.directoryValue === directory)
      return this.activeClient.selectSessionForRuntime(sessionId);
    return this.enqueue(async () => {
      if (generation !== this.selectionGeneration) return;
      const client =
        this.activeClient && this.directoryValue === directory
          ? this.activeClient
          : await this.connect(directory);
      if (this.disposed || generation !== this.selectionGeneration) return;
      await client.selectSessionForRuntime(sessionId);
    });
  }

  /**
   * Startup: connect and reopen a remembered session if it still exists.
   * The server's own startup selection (a `resumeSessionId` hint) wins.
   */
  restore(directory: string, sessionId: string | undefined): Promise<void> {
    const generation = this.selectionGeneration;
    return this.enqueue(async () => {
      this.restoring = true;
      try {
        const client = await this.connect(directory);
        if (this.disposed) return;
        await this.restoreRememberedSession(client, sessionId, generation);
      } finally {
        this.restoring = false;
        // Index recovery can finish while the connection was still settling.
        await this.retryPendingRestore();
        this.persistActiveSession();
      }
    });
  }

  // A method, not the field, so narrowing does not survive an await.
  private isDisposed(): boolean {
    return this.disposed;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const pending = this.queue.then(() => (this.disposed ? undefined : task()));
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  private async connect(directory: string): Promise<BrowserDaemonClient> {
    const previousDirectory = this.directoryValue;
    await this.activeClient?.close();
    this.store.reset();
    const client = this.createClient(directory, this.config.clientId);
    this.activeClient = client;
    this.directoryValue = directory;
    this.notify();
    try {
      await client.connect();
      if (this.disposed) {
        await client.close();
        if (this.activeClient === client) this.activeClient = undefined;
        return client;
      }
      this.connectedOnce = true;
      return client;
    } catch (error) {
      await client.close();
      if (this.disposed) {
        // Disposal won the race; the caller sees `disposed` and stops.
        if (this.activeClient === client) this.activeClient = undefined;
        return client;
      }
      this.store.reset();
      this.activeClient =
        previousDirectory === null
          ? undefined
          : this.createClient(
              previousDirectory,
              globalThis.crypto.randomUUID(),
            );
      this.directoryValue = previousDirectory;
      this.notify();
      await this.activeClient?.connect().catch(() => undefined);
      throw error;
    }
  }

  private async restoreRememberedSession(
    client: BrowserDaemonClient,
    sessionId: string | undefined,
    generation: number,
  ): Promise<void> {
    if (!sessionId || (await client.getSelectedSessionId()) === sessionId) {
      return;
    }
    // Navigation needs only lightweight metadata, never the history/model
    // refresh that runs independently from the live permission subscription.
    const sessions = await client.getSessionIndex().catch((error: unknown) => {
      if (this.disposed || this.activeClient !== client) return [];
      // Failed metadata is not evidence that the remembered session vanished.
      // Keep that preference until a subsequent explicit user selection.
      if (this.selectionGeneration === generation)
        this.pendingRestore = sessionId;
      this.store.setError(errorMessage(error));
      return [];
    });
    if (
      this.disposed ||
      this.activeClient !== client ||
      this.selectionGeneration !== generation ||
      !sessions.some(
        (session) =>
          session.id === sessionId && !session.parentId && !session.isSubagent,
      )
    ) {
      return;
    }
    await client.selectSessionForRuntime(sessionId);
  }

  private async retryPendingRestore(): Promise<void> {
    const client = this.activeClient;
    const sessionId = this.pendingRestore;
    if (this.disposed || !client || this.restoring || !sessionId) return;
    if (
      !this.store
        .getSnapshot()
        .sessionIndex.some(
          (session) =>
            session.id === sessionId &&
            !session.parentId &&
            !session.isSubagent,
        )
    )
      return;
    const generation = this.selectionGeneration;
    this.restoring = true;
    try {
      await client.selectSessionForRuntime(sessionId);
      if (
        this.activeClient === client &&
        generation === this.selectionGeneration
      )
        this.pendingRestore = null;
    } catch (error) {
      if (
        !this.isDisposed() &&
        this.activeClient === client &&
        generation === this.selectionGeneration
      )
        this.store.setError(errorMessage(error));
    } finally {
      if (this.activeClient === client) {
        this.restoring = false;
        this.persistActiveSession();
      }
    }
  }

  /** Remembers the bound session for reloads and the shareable hash. */
  private persistActiveSession(): void {
    if (this.restoring || this.pendingRestore) return;
    const directory = this.directoryValue;
    const { permissionSync, view } = this.store.getSnapshot();
    // A delayed history response may still describe the previous selection.
    // The live transport binding owns the selected session when available.
    const sessionId = permissionSync.binding
      ? permissionSync.binding.rootSessionId
      : view.snapshot?.activeSessionId;
    if (!directory || !sessionId) return;
    const last = this.navigationState.lastSession;
    if (last?.sessionId === sessionId && last.directory === directory) return;
    this.navigationState = { lastSession: { sessionId, directory } };
    writeWebNavigationState(this.navigationState);
    replaceNavigationHash({ directory, sessionId });
  }

  private forgetLastSession(): void {
    this.navigationState = { lastSession: null };
    writeWebNavigationState(this.navigationState);
    replaceNavigationHash({ directory: null });
  }

  private createClient(
    directory: string,
    firstClientId: string,
  ): BrowserDaemonClient {
    // The bootstrap startup intent (a hashed session or fresh start) applies
    // only to the first connection, and only in the directory it was made for.
    const { startupIntent, ...rest } = this.config;
    const config: OhbabyBootstrapConfig = {
      ...rest,
      ...(!this.connectedOnce &&
      startupIntent !== undefined &&
      (this.config.directory === undefined ||
        this.config.directory === directory)
        ? { startupIntent }
        : {}),
      clientId: this.connectedOnce
        ? globalThis.crypto.randomUUID()
        : firstClientId,
      directory,
    };
    return createBrowserDaemonClient({
      config,
      ...(this.fetchImpl === undefined ? {} : { fetch: this.fetchImpl }),
      store: this.store,
    });
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
