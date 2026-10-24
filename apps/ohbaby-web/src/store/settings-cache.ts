import type {
  UiSettingsGlobalMcpServer,
  UiSettingsMcpServer,
  UiSettingsModels,
  UiSettingsSearch,
  UiSettingsSkill,
} from "ohbaby-sdk";
import type { SettingsAbout } from "../api/daemon/settings-client.js";

/** What each settings resource holds (06 §3.7). */
export interface SettingsData {
  readonly models: UiSettingsModels;
  readonly search: UiSettingsSearch;
  readonly mcpServers: readonly UiSettingsGlobalMcpServer[];
  readonly about: SettingsAbout;
  /** Instance reads, cached per settings directory. */
  readonly mcpStatus: readonly UiSettingsMcpServer[];
  readonly skills: readonly UiSettingsSkill[];
}

export type SettingsKind = keyof SettingsData;

/** Kinds read from an instance; their cache key includes the directory. */
export const INSTANCE_KINDS: ReadonlySet<SettingsKind> = new Set([
  "mcpStatus",
  "skills",
]);

export interface SettingsResource<T> {
  /** `idle` before the first read; a failed reread keeps `data`. */
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly data: T | undefined;
  readonly error: string | null;
  /** When `data` was last confirmed by the server; 0 before. */
  readonly loadedAt: number;
}

export const IDLE_RESOURCE: SettingsResource<never> = {
  status: "idle",
  data: undefined,
  error: null,
  loadedAt: 0,
};

export function settingsKey(kind: SettingsKind, directory?: string): string {
  return INSTANCE_KINDS.has(kind) ? `${kind}\u0000${directory ?? ""}` : kind;
}

export interface SettingsCacheSnapshot {
  readonly resources: ReadonlyMap<string, SettingsResource<unknown>>;
}

export interface SettingsCache {
  getSnapshot(): SettingsCacheSnapshot;
  subscribe(listener: () => void): () => void;
  update(key: string, next: Partial<SettingsResource<unknown>>): void;
}

export function createSettingsCache(): SettingsCache {
  let snapshot: SettingsCacheSnapshot = { resources: new Map() };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update(key, next): void {
      const resources = new Map(snapshot.resources);
      resources.set(key, { ...(resources.get(key) ?? IDLE_RESOURCE), ...next });
      snapshot = { resources };
      for (const listener of listeners) listener();
    },
  };
}

export function selectSettings<K extends SettingsKind>(
  snapshot: SettingsCacheSnapshot,
  kind: K,
  directory?: string,
): SettingsResource<SettingsData[K]> {
  return (snapshot.resources.get(settingsKey(kind, directory)) ??
    IDLE_RESOURCE) as SettingsResource<SettingsData[K]>;
}
