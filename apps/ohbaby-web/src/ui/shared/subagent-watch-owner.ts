/** Where a subagent conversation is being read. */
export type SubagentWatchOwner = "sheet" | "panel";

export interface SubagentWatchCoordinator {
  readonly owner: () => SubagentWatchOwner | undefined;
  /** The reader the user just opened takes the watch; the others close. */
  readonly claim: (owner: SubagentWatchOwner) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * The server keeps one subagent conversation watch per client
 * (`client-view.ts`), so a second reader silently stops the first one's live
 * updates. Every reader claims the watch before selecting and closes itself
 * when another one claims it, so no detail is ever left showing stale data.
 */
export function createSubagentWatchCoordinator(): SubagentWatchCoordinator {
  let current: SubagentWatchOwner | undefined;
  const listeners = new Set<() => void>();
  return {
    owner: () => current,
    claim(owner): void {
      if (current === owner) return;
      current = owner;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
