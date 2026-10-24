import type {
  UiSettingsChangedEvent,
  UiSettingsModelCreate,
  UiSettingsModelPatch,
  UiSettingsModels,
  UiSettingsSearch,
  UiSettingsSearchUpdate,
} from "ohbaby-sdk";
import type { SettingsApi } from "../api/daemon/settings-client.js";
import {
  createSettingsCache,
  INSTANCE_KINDS,
  selectSettings,
  settingsKey,
  type SettingsCache,
  type SettingsData,
  type SettingsKind,
} from "../store/settings-cache.js";

type SettingsDomain = UiSettingsChangedEvent["domains"][number];

/** Which cached kinds a `settings.changed` domain makes stale. */
const DOMAIN_KINDS: Readonly<Record<SettingsDomain, readonly SettingsKind[]>> =
  {
    model: ["models"],
    // A key written to `.env` can change whether a model or search key is set.
    env: ["models", "search"],
    search: ["search"],
    mcp: ["mcpServers", "mcpStatus"],
    skills: ["skills"],
    agents: [],
  };

const READERS: {
  readonly [K in SettingsKind]: (
    api: SettingsApi,
    directory: string,
    signal: AbortSignal,
  ) => Promise<SettingsData[K]>;
} = {
  models: (api, _directory, signal) => api.getModels(signal),
  search: (api, _directory, signal) => api.getSearch(signal),
  mcpServers: (api, _directory, signal) => api.getMcpServers(signal),
  about: (api, _directory, signal) => api.getAbout(signal),
  mcpStatus: (api, directory, signal) => api.getMcpStatus(directory, signal),
  skills: (api, directory, signal) => api.getSkills(directory, signal),
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Settings cache and its refresh rules (06 §3.7). Sections read what they
 * show when they become visible; writes wait for the server and their result
 * replaces the cache. A per-key ticket makes a read that started before a
 * write (or before a newer read) land nowhere. Visible sections register
 * with `watch`, and change events or the window regaining focus reread them.
 */
export class SettingsLayer {
  readonly cache: SettingsCache = createSettingsCache();
  private readonly tickets = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly watched = new Map<SettingsKind, number>();

  constructor(
    private readonly api: SettingsApi,
    /** Directory for instance reads: the open chat's, else the draft's. */
    private readonly directoryOf: () => string | null,
  ) {}

  /** Where MCP status and Skills are read; null until a directory is known. */
  get directory(): string | null {
    return this.directoryOf();
  }

  /**
   * Reads `kind`. `maxAge` skips the request when cached data is newer; an
   * in-flight read of the same key is shared unless `force` is set.
   */
  load(
    kind: SettingsKind,
    options: { readonly maxAge?: number; readonly force?: boolean } = {},
  ): Promise<void> {
    const directory = INSTANCE_KINDS.has(kind) ? this.directoryOf() : "";
    if (directory === null) return Promise.resolve();
    const key = settingsKey(kind, directory);
    const current = selectSettings(this.cache.getSnapshot(), kind, directory);
    if (
      options.maxAge !== undefined &&
      current.data !== undefined &&
      Date.now() - current.loadedAt < options.maxAge
    )
      return Promise.resolve();
    const pending = this.inflight.get(key);
    if (pending && options.force !== true) return pending;
    const ticket = this.nextTicket(key);
    this.cache.update(key, { status: "loading" });
    const controller = new AbortController();
    const read = READERS[kind](this.api, directory, controller.signal).then(
      (data) => {
        if (this.tickets.get(key) !== ticket) return;
        this.cache.update(key, {
          status: "ready",
          data,
          error: null,
          loadedAt: Date.now(),
        });
      },
      (error: unknown) => {
        if (this.tickets.get(key) !== ticket) return;
        this.cache.update(key, { status: "error", error: message(error) });
      },
    );
    const tracked = read.finally(() => {
      if (this.inflight.get(key) === tracked) this.inflight.delete(key);
    });
    this.inflight.set(key, tracked);
    return tracked;
  }

  /** A visible section: rereads it on change events and window focus. */
  watch(kind: SettingsKind): () => void {
    this.watched.set(kind, (this.watched.get(kind) ?? 0) + 1);
    return () => {
      const count = (this.watched.get(kind) ?? 1) - 1;
      if (count <= 0) this.watched.delete(kind);
      else this.watched.set(kind, count);
    };
  }

  /** `settings.changed` (or `model.invalidated`): reread visible kinds now. */
  invalidate(domains: readonly SettingsDomain[]): void {
    const kinds = new Set(domains.flatMap((domain) => DOMAIN_KINDS[domain]));
    for (const kind of kinds) {
      // Unwatched entries reread when next shown (and ModelMenu checks age).
      this.expire(kind);
      if (this.watched.has(kind)) void this.load(kind, { force: true });
    }
  }

  /** The window regained focus: files may have changed without an event. */
  reactivate(): void {
    for (const kind of this.watched.keys())
      void this.load(kind, { force: true });
  }

  createModel(input: UiSettingsModelCreate): Promise<UiSettingsModels> {
    return this.writeModels(this.api.createModel(input));
  }

  updateModel(
    id: string,
    patch: UiSettingsModelPatch,
  ): Promise<UiSettingsModels> {
    return this.writeModels(this.api.updateModel(id, patch));
  }

  selectModel(id: string): Promise<UiSettingsModels> {
    return this.writeModels(this.api.selectModel(id));
  }

  deleteModel(id: string): Promise<UiSettingsModels> {
    return this.writeModels(this.api.deleteModel(id));
  }

  deleteProvider(provider: string): Promise<UiSettingsModels> {
    return this.writeModels(this.api.deleteProvider(provider));
  }

  async updateSearch(patch: UiSettingsSearchUpdate): Promise<UiSettingsSearch> {
    return this.write("search", await this.api.updateSearch(patch));
  }

  private async writeModels(
    pending: Promise<UiSettingsModels>,
  ): Promise<UiSettingsModels> {
    return this.write("models", await pending);
  }

  /** A confirmed write wins over every read that started before it. */
  private write<K extends "models" | "search">(
    kind: K,
    data: SettingsData[K],
  ): SettingsData[K] {
    const key = settingsKey(kind);
    this.nextTicket(key);
    this.inflight.delete(key);
    this.cache.update(key, {
      status: "ready",
      data,
      error: null,
      loadedAt: Date.now(),
    });
    return data;
  }

  /** Marks every cached entry of `kind` (all directories) as needing a read. */
  private expire(kind: SettingsKind): void {
    for (const [key, resource] of this.cache.getSnapshot().resources)
      if (
        (key === kind || key.startsWith(`${kind}\u0000`)) &&
        resource.loadedAt !== 0
      )
        this.cache.update(key, { loadedAt: 0 });
  }

  private nextTicket(key: string): number {
    const ticket = (this.tickets.get(key) ?? 0) + 1;
    this.tickets.set(key, ticket);
    return ticket;
  }
}
