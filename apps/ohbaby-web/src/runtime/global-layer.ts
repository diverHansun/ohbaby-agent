import type { UiGlobalSession, UiSessionSearchPage } from "ohbaby-sdk";
import { GlobalSessionsClient } from "../api/daemon/global-sessions.js";
import {
  createDaemonHttpClient,
  type DaemonHttpClient,
} from "../api/daemon/http.js";
import type {
  DirectoryPickerListResponse,
  DirectoryPickerRootsResponse,
  OhbabyBootstrapConfig,
} from "../api/daemon/wire.js";
import {
  createGlobalCatalogStore,
  type GlobalCatalogStore,
} from "../store/global-catalog.js";

/** One page of the global list; the server caps pages at 500. */
const PAGE_SIZE = 100;
/** Show more stops after this many pages; the next click continues. */
const MAX_PAGES_PER_LOAD = 10;

/**
 * Directory-independent state: projects, the global session list and the
 * folder picker. Requests carry no directory header. Reads go through one
 * serial queue, so a refresh and Show more never interleave pages.
 */
export class GlobalLayer {
  readonly catalog: GlobalCatalogStore = createGlobalCatalogStore();
  private readonly http: DaemonHttpClient;
  private readonly sessions: GlobalSessionsClient;
  private queue: Promise<void> = Promise.resolve();
  private refreshQueued: Promise<void> | null = null;
  /** Counts local row changes, so a refresh read before one does not undo it. */
  private writes = 0;
  /** Optimistic changes the server has not confirmed yet. */
  private writesInFlight = 0;
  private readonly scoped = new Map<string, Promise<DaemonHttpClient>>();
  /** False when the daemon serves a single workspace without scope routes. */
  controlPlaneAvailable = true;

  constructor(
    private readonly config: OhbabyBootstrapConfig,
    private readonly fetchImpl: typeof fetch | undefined,
  ) {
    this.http = createDaemonHttpClient(
      { ...config, directory: undefined },
      fetchImpl,
    );
    this.sessions = new GlobalSessionsClient(this.http);
  }

  /** Reads the project list; throws so startup can detect a missing control plane. */
  async refreshProjects(): Promise<void> {
    const writes = this.writes;
    try {
      const response = await this.http.listWorkspaceScopes();
      if (writes !== this.writes) return;
      this.catalog.setProjects(
        response.scopes,
        response.defaultDirectory?.directory ?? null,
      );
    } catch (error) {
      this.catalog.failProjects();
      throw error;
    }
  }

  /**
   * Re-reads projects and at least the loaded range of sessions from the first
   * page, then replaces the range so rows archived, hidden or moved elsewhere
   * disappear. Triggers during a refresh coalesce into one more refresh.
   */
  refresh(): Promise<void> {
    if (!this.controlPlaneAvailable) return Promise.resolve();
    if (this.refreshQueued) return this.refreshQueued;
    const pending = this.enqueue(async () => {
      this.refreshQueued = null;
      await Promise.allSettled([this.refreshProjects(), this.reloadSessions()]);
    });
    this.refreshQueued = pending;
    return pending;
  }

  /** Startup: projects were just read, so only the session list is loaded. */
  refreshSessions(): Promise<void> {
    if (!this.controlPlaneAvailable) return Promise.resolve();
    return this.enqueue(() => this.reloadSessions());
  }

  /**
   * Loads further pages until `enough` holds for the loaded range or no page
   * is left. Show more uses it to fill one group across several pages.
   */
  loadMore(
    enough: (sessions: readonly UiGlobalSession[]) => boolean,
  ): Promise<void> {
    return this.enqueue(async () => {
      let cursor = this.catalog.getSnapshot().nextCursor;
      if (cursor === undefined || enough(this.catalog.getSnapshot().sessions))
        return;
      this.catalog.setLoadingMore(true);
      try {
        for (
          let pages = 0;
          cursor !== undefined && pages < MAX_PAGES_PER_LOAD;
          pages++
        ) {
          const writes = this.writes;
          const page = await this.sessions.listSessions({
            cursor,
            limit: PAGE_SIZE,
          });
          // A page read before a row change must not resurrect hidden or
          // archived rows. Keep the cursor so a failed refresh can be retried.
          if (writes !== this.writes || this.writesInFlight > 0) {
            void this.refresh();
            return;
          }
          this.catalog.appendSessions(page.sessions, page.nextCursor);
          cursor = page.nextCursor;
          if (enough(this.catalog.getSnapshot().sessions)) break;
        }
      } catch {
        // The loaded range stays; the next Show more starts from the same cursor.
      } finally {
        this.catalog.setLoadingMore(false);
      }
    });
  }

  /** Call after changing rows locally; an in-flight refresh then reads again. */
  noteWrite(): void {
    this.writes += 1;
  }

  /**
   * Marks an optimistic change awaiting the server. Refreshes that finish
   * meanwhile keep the local rows; call the returned function when the
   * server answered, then refresh.
   */
  beginWrite(): () => void {
    this.writesInFlight += 1;
    this.writes += 1;
    return () => {
      this.writesInFlight -= 1;
      this.writes += 1;
    };
  }

  /** Registers a folder as a project and returns its canonical directory. */
  async openScope(directory: string): Promise<string> {
    return (await this.http.openWorkspace(directory)).scope.directory;
  }

  async hideScope(directory: string): Promise<void> {
    await this.http.hideWorkspace(directory);
    this.noteWrite();
    this.catalog.removeProject(directory);
  }

  async moveSession(
    sessionId: string,
    workspaceDirectory: string | null,
  ): Promise<void> {
    const settle = this.beginWrite();
    try {
      const session = await this.sessions.moveSession(
        sessionId,
        workspaceDirectory,
      );
      this.catalog.upsertSession(session);
    } finally {
      settle();
      void this.refresh();
    }
  }

  searchSessions(input: {
    query: string;
    cursor?: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<UiSessionSearchPage> {
    return this.sessions.searchSessions(input);
  }

  getDirectoryPickerRoots(): Promise<DirectoryPickerRootsResponse> {
    return this.http.getDirectoryPickerRoots();
  }

  listDirectoryPicker(directory: string): Promise<DirectoryPickerListResponse> {
    return this.http.listDirectoryPicker(directory);
  }

  /**
   * A client registered once per other directory, for archive and export of
   * sessions outside the connected instance. It opens no SSE, so the current
   * conversation keeps its stream and approvals.
   */
  scopedHttp(directory: string): Promise<DaemonHttpClient> {
    let pending = this.scoped.get(directory);
    if (!pending) {
      const http = createDaemonHttpClient(
        {
          ...this.config,
          clientId: globalThis.crypto.randomUUID(),
          directory,
        },
        this.fetchImpl,
      );
      pending = http
        .registerClient({
          startupIntent: { startupSessionMode: { type: "fresh" } },
        })
        .then(() => http);
      // One registration per directory; a failed one is retried next time.
      pending.catch(() => {
        this.scoped.delete(directory);
      });
      this.scoped.set(directory, pending);
    }
    return pending;
  }

  private async reloadSessions(): Promise<void> {
    const before = this.catalog.getSnapshot();
    const writes = this.writes;
    const target = Math.max(before.sessions.length, PAGE_SIZE);
    const loaded: UiGlobalSession[] = [];
    let cursor: string | undefined;
    try {
      do {
        const page = await this.sessions.listSessions({
          ...(cursor === undefined ? {} : { cursor }),
          limit: PAGE_SIZE,
        });
        loaded.push(...page.sessions);
        cursor = page.nextCursor;
      } while (cursor !== undefined && loaded.length < target);
      // The read may predate a local change: keep the rows. An unconfirmed
      // change refreshes when it settles; a settled one reads again now.
      if (this.writesInFlight > 0) return;
      if (writes !== this.writes) {
        void this.refresh();
        return;
      }
      this.catalog.replaceSessions(loaded, cursor);
    } catch (error) {
      this.catalog.failSessions(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const pending = this.queue.then(task);
    this.queue = pending.catch(() => undefined);
    return pending;
  }
}
