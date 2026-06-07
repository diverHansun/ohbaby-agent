import { createBus, type BusInstance } from "../../bus/index.js";
import { createSessionIdGenerator } from "./id-generator.js";
import { SessionEvent } from "./events.js";
import { createInMemorySessionStore } from "./store.js";
import {
  InvalidSessionStatsDeltaError,
  SessionNotFoundError,
} from "./errors.js";
import type {
  CreateSessionOptions,
  EnsureRootSessionInput,
  ListSessionOptions,
  MessageCleaner,
  ProjectInfo,
  ProjectResolver,
  RemoveSessionOptions,
  Session,
  SessionManager,
  SessionManagerOptions,
  SessionStatsDelta,
  UpdateSessionPatch,
} from "./types.js";

const DEFAULT_RECENT_LIMIT = 20;
const DEFAULT_AGENT_NAME = "default";

const GLOBAL_PROJECT_RESOLVER: ProjectResolver = {
  fromDirectory(directory: string): ProjectInfo {
    return {
      id: "global",
      rootPath: directory,
    };
  },
};

function defaultTitle(now: number): string {
  return `New session - ${new Date(now).toISOString()}`;
}

function toChildIds(session: Session, childId: string): readonly string[] {
  if (session.childrenIds.includes(childId)) {
    return session.childrenIds;
  }
  return [...session.childrenIds, childId];
}

function withoutChildId(
  session: Session,
  childId: string,
): readonly string[] | undefined {
  const childrenIds = session.childrenIds.filter((id) => id !== childId);
  if (childrenIds.length === session.childrenIds.length) {
    return undefined;
  }

  return childrenIds;
}

async function getExistingSession(
  sessionId: string,
  options: SessionManagerOptions,
): Promise<Session> {
  const session = await options.store.get(sessionId);
  if (!session) {
    throw new SessionNotFoundError(sessionId);
  }

  return session;
}

function createSessionRecord(input: {
  readonly id: string;
  readonly project: ProjectInfo;
  readonly options: CreateSessionOptions;
  readonly now: number;
  readonly parentId?: string;
}): Session {
  return {
    id: input.id,
    projectId: input.project.id,
    projectRoot: input.project.rootPath,
    title: input.options.title ?? defaultTitle(input.now),
    agentName: input.options.agentName ?? DEFAULT_AGENT_NAME,
    createdAt: input.now,
    updatedAt: input.now,
    status: "active",
    stats: { messageCount: 0 },
    parentId: input.parentId,
    childrenIds: [],
    isSubagent: input.parentId !== undefined,
  };
}

export function createSessionManager(
  options: SessionManagerOptions,
): SessionManager {
  const now = options.now ?? Date.now;
  const createSessionId = options.createSessionId ?? createSessionIdGenerator();

  async function create(
    projectDirectory: string,
    createOptions: CreateSessionOptions = {},
  ): Promise<Session> {
    const createdAt = now();
    let parent: Session | undefined;
    let project: ProjectInfo;

    if (createOptions.parentId) {
      parent = await getExistingSession(createOptions.parentId, options);
      project = {
        id: parent.projectId,
        rootPath: parent.projectRoot,
      };
    } else {
      project = await options.projectResolver.fromDirectory(projectDirectory);
    }

    const session = createSessionRecord({
      id: createOptions.id ?? createSessionId(),
      project,
      options: createOptions,
      now: createdAt,
      parentId: parent?.id,
    });

    let updatedParent: Session | undefined;
    await options.store.withTransaction(async (store) => {
      await store.insert(session);
      if (parent) {
        updatedParent = await store.update(parent.id, {
          childrenIds: toChildIds(parent, session.id),
          updatedAt: now(),
        });
      }
    });
    options.bus.publish(SessionEvent.Created, { session });
    if (updatedParent) {
      options.bus.publish(SessionEvent.Updated, {
        session: updatedParent,
      });
    }

    return session;
  }

  return {
    create,

    async findReusableEmptyPrimary(
      projectDirectory: string,
    ): Promise<Session | null> {
      const project =
        await options.projectResolver.fromDirectory(projectDirectory);
      const sessions = await options.store.listByProject(project.id, {
        status: "active",
      });

      return (
        sessions.find(
          (session) => !session.isSubagent && session.stats.messageCount === 0,
        ) ?? null
      );
    },

    async ensureRoot(input: EnsureRootSessionInput): Promise<Session> {
      const existing = await options.store.get(input.id);
      if (existing) {
        return existing;
      }

      return create(input.projectRoot, {
        agentName: input.agentName,
        id: input.id,
        title: input.title,
      });
    },

    get(sessionId: string): Promise<Session | null> {
      return options.store.get(sessionId);
    },

    listByProject(
      projectId: string,
      listOptions?: ListSessionOptions,
    ): Promise<Session[]> {
      return options.store.listByProject(projectId, listOptions);
    },

    listChildren(
      parentId: string,
      listOptions?: ListSessionOptions,
    ): Promise<Session[]> {
      return options.store.listChildren(parentId, listOptions);
    },

    getRecent(limit = DEFAULT_RECENT_LIMIT): Promise<Session[]> {
      return options.store.getRecent(limit);
    },

    async update(
      sessionId: string,
      patch: UpdateSessionPatch,
    ): Promise<Session> {
      await getExistingSession(sessionId, options);
      const session = await options.store.update(sessionId, {
        ...patch,
        updatedAt: now(),
      });
      options.bus.publish(SessionEvent.Updated, { session });
      return session;
    },

    async incrementStats(
      sessionId: string,
      delta: SessionStatsDelta,
    ): Promise<Session> {
      const session = await getExistingSession(sessionId, options);
      const messageCountDelta = delta.messageCountDelta ?? 1;
      const messageCount = session.stats.messageCount + messageCountDelta;
      if (messageCount < 0) {
        throw new InvalidSessionStatsDeltaError();
      }
      const updatedAt = now();

      const updated = await options.store.update(sessionId, {
        stats: {
          messageCount,
          lastMessageAt: delta.lastMessageAt ?? updatedAt,
        },
        updatedAt,
      });
      options.bus.publish(SessionEvent.Updated, { session: updated });
      return updated;
    },

    async remove(
      sessionId: string,
      removeOptions: RemoveSessionOptions = {},
    ): Promise<void> {
      const session = await options.store.get(sessionId);
      if (!session) {
        return;
      }
      const sessionIds =
        removeOptions.cascadeChildren === true
          ? [session.id, ...session.childrenIds]
          : [session.id];
      const updatedParents: Session[] = [];

      await options.store.withTransaction(async (store) => {
        for (const id of sessionIds) {
          await options.messageCleaner.removeMessages(id);
        }
        const removedIds = new Set(sessionIds);
        for (const id of sessionIds) {
          const removedSession =
            id === session.id ? session : await store.get(id);
          if (
            !removedSession?.parentId ||
            removedIds.has(removedSession.parentId)
          ) {
            continue;
          }
          const parent = await store.get(removedSession.parentId);
          if (!parent) {
            continue;
          }
          const childrenIds = withoutChildId(parent, removedSession.id);
          if (childrenIds) {
            updatedParents.push(
              await store.update(parent.id, {
                childrenIds,
                updatedAt: now(),
              }),
            );
          }
        }
        for (const id of sessionIds) {
          await store.remove(id);
        }
      });
      for (const updatedParent of updatedParents) {
        options.bus.publish(SessionEvent.Updated, {
          session: updatedParent,
        });
      }
      for (const id of sessionIds) {
        options.bus.publish(SessionEvent.Removed, { sessionId: id });
      }
    },
  };
}

export function createInMemorySessionManager(options: {
  readonly bus?: BusInstance;
  readonly projectResolver?: ProjectResolver;
  readonly messageCleaner: MessageCleaner;
  readonly now?: () => number;
  readonly createSessionId?: () => string;
}): SessionManager {
  return createSessionManager({
    bus: options.bus ?? createBus(),
    store: createInMemorySessionStore(),
    projectResolver: options.projectResolver ?? GLOBAL_PROJECT_RESOLVER,
    messageCleaner: options.messageCleaner,
    now: options.now,
    createSessionId: options.createSessionId,
  });
}
