const WORKSPACE_KEY = "ohbaby:draft-workspace:new";

export interface DraftSnapshot {
  /** Workspace chosen for the new-chat draft; null means No workspace. */
  readonly workspaceDirectory: string | null;
}

export interface DraftStore {
  getSnapshot(): DraftSnapshot;
  subscribe(listener: () => void): () => void;
  setWorkspace(directory: string | null): void;
}

/**
 * The new-chat draft's workspace choice. The text lives with the composer
 * draft under the fixed `new` scope; both use sessionStorage, so a reload
 * keeps them and another tab does not share them.
 */
export function createDraftStore(): DraftStore {
  let snapshot: DraftSnapshot = { workspaceDirectory: readWorkspace() };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: (): DraftSnapshot => snapshot,
    subscribe: (listener): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setWorkspace: (workspaceDirectory): void => {
      if (workspaceDirectory === snapshot.workspaceDirectory) return;
      snapshot = { workspaceDirectory };
      writeWorkspace(workspaceDirectory);
      for (const listener of listeners) listener();
    },
  };
}

function readWorkspace(): string | null {
  try {
    const value: unknown = JSON.parse(
      globalThis.sessionStorage.getItem(WORKSPACE_KEY) ?? "null",
    );
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeWorkspace(directory: string | null): void {
  try {
    if (directory === null) globalThis.sessionStorage.removeItem(WORKSPACE_KEY);
    else
      globalThis.sessionStorage.setItem(
        WORKSPACE_KEY,
        JSON.stringify(directory),
      );
  } catch {
    // The choice still applies for this page; it only resets on reload.
  }
}
