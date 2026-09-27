import type { DatabaseConnection } from "../database/index.js";

export type WorkspaceVisibility = "visible" | "hidden";

export interface WorkspaceRegistryEntry {
  readonly scopeKey: string;
  readonly visibility: WorkspaceVisibility;
  readonly position: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastOpenedAt: number;
}

export interface WorkspaceRegistryStore {
  list(): readonly WorkspaceRegistryEntry[];
  ensureDiscovered(
    scopeKeys: readonly string[],
  ): Promise<readonly WorkspaceRegistryEntry[]>;
  open(scopeKey: string): Promise<WorkspaceRegistryEntry>;
  hide(scopeKey: string): Promise<boolean>;
}

export interface WorkspaceRegistryStoreOptions {
  readonly db?: DatabaseConnection;
  readonly now?: () => number;
}
