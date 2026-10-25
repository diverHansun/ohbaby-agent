const PROJECT_KEY = "ohbaby:draft-project:new";

export interface DraftSnapshot {
  /** Project chosen for the new-chat draft; null means No project. */
  readonly workspaceDirectory: string | null;
}

export interface DraftStore {
  getSnapshot(): DraftSnapshot;
  subscribe(listener: () => void): () => void;
  setProject(directory: string | null): void;
}

/**
 * The new-chat draft's project choice. The text lives with the composer
 * draft under the fixed `new` scope; both use sessionStorage, so a reload
 * keeps them and another tab does not share them.
 */
export function createDraftStore(): DraftStore {
  let snapshot: DraftSnapshot = { workspaceDirectory: readProject() };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: (): DraftSnapshot => snapshot,
    subscribe: (listener): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setProject: (workspaceDirectory): void => {
      if (workspaceDirectory === snapshot.workspaceDirectory) return;
      snapshot = { workspaceDirectory };
      writeProject(workspaceDirectory);
      for (const listener of listeners) listener();
    },
  };
}

function readProject(): string | null {
  try {
    const value: unknown = JSON.parse(
      globalThis.sessionStorage.getItem(PROJECT_KEY) ?? "null",
    );
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeProject(directory: string | null): void {
  try {
    if (directory === null) globalThis.sessionStorage.removeItem(PROJECT_KEY);
    else
      globalThis.sessionStorage.setItem(PROJECT_KEY, JSON.stringify(directory));
  } catch {
    // The choice still applies for this page; it only resets on reload.
  }
}
