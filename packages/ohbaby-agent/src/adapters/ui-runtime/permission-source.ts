import { realpathSync } from "node:fs";
import path from "node:path";
import type { SubagentInstanceRecord } from "../../agents/subagents/types.js";
import type { BusInstance } from "../../bus/index.js";
import type { PermissionPort } from "../../core/tool-scheduler/index.js";
import type {
  PermissionManager,
  PermissionSource,
  SchedulerPermissionResponse,
} from "../../permission/types.js";
import { SessionEvent } from "../../services/session/events.js";
import type { Session } from "../../services/session/types.js";

export interface PermissionSourcePortOptions {
  readonly manager: Pick<
    PermissionManager,
    "ask" | "state" | "revokeBySession"
  >;
  readonly bus: BusInstance;
  readonly projectRoot: string;
  readonly getSession: (sessionId: string) => Promise<Session | null>;
  readonly getSubagentRecord?: (
    session: Session,
    contextScopeId?: string,
  ) => Promise<Pick<
    SubagentInstanceRecord,
    "sessionId" | "parentSessionId" | "name" | "description"
  > | null>;
}

export interface PermissionSourcePort extends PermissionPort {
  dispose(): void;
}

type Relation = Pick<
  Session,
  "parentId" | "projectId" | "projectRoot" | "isSubagent"
>;

interface SourceResolution {
  readonly startedGeneration: number;
  readonly nodes: Map<string, Relation>;
  resolving: boolean;
}

export class PermissionSourceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Invalid permission source: ${message}`, options);
    this.name = "PermissionSourceError";
  }
}

function canonicalRoot(value: string): string {
  const absolute = path.resolve(value);
  let result: string;
  try {
    result = realpathSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    result = absolute;
  }
  return process.platform === "win32" ? result.toLowerCase() : result;
}

function relation(session: Session): Relation {
  return {
    parentId: session.parentId,
    projectId: session.projectId,
    projectRoot: canonicalRoot(session.projectRoot),
    isSubagent: session.isSubagent,
  };
}

function sameRelation(left: Relation, right: Relation): boolean {
  return (
    left.parentId === right.parentId &&
    left.projectId === right.projectId &&
    left.projectRoot === right.projectRoot &&
    left.isSubagent === right.isSubagent
  );
}

/** Resolves trusted application identity before the manager may register pending. */
export function createPermissionSourcePort(
  options: PermissionSourcePortOptions,
): PermissionSourcePort {
  const workspace = canonicalRoot(options.projectRoot);
  const resolutions = new Set<SourceResolution>();
  // These generations cover deletion before an async traversal discovers a node.
  // Keep only events needed by current reads; this is not a second session tree.
  const invalidations = new Map<string, number>();
  const updates = new Map<string, { generation: number; relation: Relation }>();
  const disposal = new AbortController();
  let generation = 0;

  function pruneEvents(): void {
    const reading = [...resolutions].filter((item) => item.resolving);
    const oldest = Math.min(...reading.map((item) => item.startedGeneration));
    for (const [id, version] of invalidations)
      if (version <= oldest) invalidations.delete(id);
    for (const [id, update] of updates)
      if (update.generation <= oldest) updates.delete(id);
  }

  function invalidate(sessionId: string): void {
    invalidations.set(sessionId, ++generation);
    options.manager.revokeBySession(sessionId, "source_invalidated");
    pruneEvents();
  }

  const unsubscribeRemoved = options.bus.subscribe(
    SessionEvent.Removed,
    ({ sessionId }) => {
      invalidate(sessionId);
    },
  );
  const unsubscribeUpdated = options.bus.subscribe(
    SessionEvent.Updated,
    ({ session }) => {
      let next: Relation;
      try {
        next = relation(session);
      } catch {
        invalidate(session.id);
        return;
      }
      updates.set(session.id, { generation: ++generation, relation: next });
      for (const current of resolutions) {
        const previous = current.nodes.get(session.id);
        if (previous && !sameRelation(previous, next)) {
          invalidate(session.id);
          break;
        }
      }
      pruneEvents();
    },
  );

  function assertCurrent(current: SourceResolution): void {
    for (const [id, known] of current.nodes) {
      const update = updates.get(id);
      if (
        (invalidations.get(id) ?? 0) > current.startedGeneration ||
        (update &&
          update.generation > current.startedGeneration &&
          !sameRelation(known, update.relation))
      ) {
        throw new PermissionSourceError(
          `session ${id} changed during source resolution`,
        );
      }
    }
  }

  async function resolveSource(
    sessionId: string,
    current: SourceResolution,
    signal: AbortSignal,
    contextScopeId?: string,
  ): Promise<PermissionSource | undefined> {
    let nextId = sessionId;
    const isCancelled = (): boolean => signal.aborted;
    let projectId: string | undefined;
    let sourceLabel: string | undefined;
    const ancestors: string[] = [];
    for (;;) {
      if (isCancelled()) return undefined;
      if (current.nodes.has(nextId)) {
        invalidate(nextId);
        throw new PermissionSourceError(`cycle at session ${nextId}`);
      }
      if ((invalidations.get(nextId) ?? 0) > current.startedGeneration) {
        throw new PermissionSourceError(`session ${nextId} was invalidated`);
      }
      const node = await options.getSession(nextId);
      if (isCancelled()) return undefined;
      if (node?.id !== nextId) {
        invalidate(nextId);
        throw new PermissionSourceError(`session ${nextId} was not found`);
      }
      const identity = relation(node);
      current.nodes.set(node.id, identity);
      assertCurrent(current);
      if (
        identity.projectRoot !== workspace ||
        (projectId !== undefined && node.projectId !== projectId)
      ) {
        invalidate(node.id);
        throw new PermissionSourceError(
          `session ${node.id} belongs to another workspace`,
        );
      }
      projectId ??= node.projectId;
      if (node.isSubagent && !node.parentId) {
        invalidate(node.id);
        throw new PermissionSourceError(
          `subagent session ${node.id} has no parent`,
        );
      }
      const record = await options.getSubagentRecord?.(
        node,
        node.id === sessionId ? contextScopeId : undefined,
      );
      if (isCancelled()) return undefined;
      assertCurrent(current);
      if (
        record &&
        (record.sessionId !== node.id ||
          record.parentSessionId !== node.parentId)
      ) {
        invalidate(node.id);
        throw new PermissionSourceError(
          `subagent relationship disagrees for session ${node.id}`,
        );
      }
      if (node.id === sessionId)
        sourceLabel = [
          record?.name?.trim(),
          record?.description?.trim(),
          node.title.trim(),
        ].find((value) => value !== undefined && value.length > 0);
      else ancestors.push(node.id);
      if (!node.parentId) {
        return Object.freeze({
          rootSessionId: node.id,
          ancestorSessionIds: Object.freeze(ancestors),
          ...(sourceLabel ? { sourceLabel } : {}),
        });
      }
      nextId = node.parentId;
    }
  }

  return {
    state: options.manager.state,
    async ask(input): Promise<SchedulerPermissionResponse> {
      if (disposal.signal.aborted || input.signal.aborted) return "cancel";
      const current: SourceResolution = {
        startedGeneration: generation,
        nodes: new Map(),
        resolving: true,
      };
      resolutions.add(current);
      const signal = AbortSignal.any([input.signal, disposal.signal]);
      let onAbort: () => void = () => undefined;
      const cancelled = new Promise<undefined>((resolve) => {
        onAbort = (): void => {
          resolve(undefined);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        let source: PermissionSource | undefined;
        try {
          source = await Promise.race([
            resolveSource(
              input.sessionId,
              current,
              signal,
              input.contextScopeId,
            ),
            cancelled,
          ]);
        } catch (error) {
          if (error instanceof PermissionSourceError) throw error;
          throw new PermissionSourceError(
            `could not resolve session ${input.sessionId}`,
            { cause: error },
          );
        }
        if (!source || signal.aborted) return "cancel";
        // No await between final validation and registration in the manager.
        assertCurrent(current);
        current.resolving = false;
        pruneEvents();
        return await options.manager.ask({
          ...input,
          category:
            input.category === "subagent-control" ? "subagent" : input.category,
          source,
        });
      } finally {
        signal.removeEventListener("abort", onAbort);
        resolutions.delete(current);
        pruneEvents();
      }
    },
    dispose(): void {
      unsubscribeRemoved();
      unsubscribeUpdated();
      disposal.abort();
    },
  };
}
