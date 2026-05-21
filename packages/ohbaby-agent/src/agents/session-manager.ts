import type { SessionManager } from "../services/session/index.js";
import type { SubagentSession, SubagentSessionManager } from "./types.js";

export interface RuntimeSubagentSessionManager extends SubagentSessionManager {
  ensureRoot(input: {
    readonly agentName: string;
    readonly id: string;
    readonly projectRoot: string;
    readonly title?: string;
  }): Promise<void>;
}

export class InMemorySubagentSessionManager
  implements RuntimeSubagentSessionManager
{
  private readonly sessions = new Map<string, SubagentSession>();
  private nextId = 1;

  ensureRoot(input: {
    readonly agentName: string;
    readonly id: string;
    readonly projectRoot: string;
    readonly title?: string;
  }): Promise<void> {
    const existing = this.sessions.get(input.id);
    this.sessions.set(input.id, {
      id: input.id,
      agentName: input.agentName,
      childrenIds: existing?.childrenIds ?? [],
      isSubagent: false,
      projectRoot: input.projectRoot,
    });
    return Promise.resolve();
  }

  create(
    projectDirectory: string,
    options: {
      readonly id?: string;
      readonly title?: string;
      readonly agentName?: string;
      readonly parentId?: string;
    } = {},
  ): Promise<SubagentSession> {
    const id = options.id ?? `subagent_session_${String(this.nextId)}`;
    this.nextId += 1;
    const parent = options.parentId
      ? this.sessions.get(options.parentId)
      : undefined;
    const session: SubagentSession = {
      id,
      agentName: options.agentName ?? "build",
      childrenIds: [],
      isSubagent: options.parentId !== undefined,
      parentId: options.parentId,
      projectRoot: parent?.projectRoot ?? projectDirectory,
    };

    this.sessions.set(id, session);
    if (parent && !parent.childrenIds.includes(id)) {
      this.sessions.set(parent.id, {
        ...parent,
        childrenIds: [...parent.childrenIds, id],
      });
    }

    return Promise.resolve(session);
  }

  get(sessionId: string): Promise<SubagentSession | null> {
    return Promise.resolve(this.sessions.get(sessionId) ?? null);
  }
}

export class PersistentSubagentSessionManager
  implements RuntimeSubagentSessionManager
{
  constructor(
    private readonly backing: Pick<SessionManager, "create" | "get">,
  ) {}

  async ensureRoot(input: {
    readonly agentName: string;
    readonly id: string;
    readonly projectRoot: string;
    readonly title?: string;
  }): Promise<void> {
    if (await this.backing.get(input.id)) {
      return;
    }
    await this.backing.create(input.projectRoot, {
      agentName: input.agentName,
      id: input.id,
      title: input.title,
    });
  }

  create(
    projectDirectory: string,
    options: {
      readonly id?: string;
      readonly title?: string;
      readonly agentName?: string;
      readonly parentId?: string;
    } = {},
  ): Promise<SubagentSession> {
    return this.backing.create(projectDirectory, options);
  }

  get(sessionId: string): Promise<SubagentSession | null> {
    return this.backing.get(sessionId);
  }
}

export function createRuntimeSubagentSessionManager(
  backing?: Pick<SessionManager, "create" | "get">,
): RuntimeSubagentSessionManager {
  return backing
    ? new PersistentSubagentSessionManager(backing)
    : new InMemorySubagentSessionManager();
}
