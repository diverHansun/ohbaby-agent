import type { BusInstance } from "../../bus/index.js";

export type SessionStatus = "active" | "archived";

export interface SessionStats {
  readonly messageCount: number;
  readonly lastMessageAt?: number;
}

export interface Session {
  readonly id: string;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly title: string;
  readonly agentName: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly status: SessionStatus;
  readonly stats: SessionStats;
  readonly parentId?: string;
  readonly childrenIds: readonly string[];
  readonly isSubagent: boolean;
}

export interface ProjectInfo {
  readonly id: string;
  readonly rootPath: string;
}

export interface ProjectResolver {
  fromDirectory(directory: string): Promise<ProjectInfo> | ProjectInfo;
}

export interface MessageCleaner {
  removeMessages(sessionId: string): Promise<void>;
}

export interface CreateSessionOptions {
  readonly id?: string;
  readonly title?: string;
  readonly agentName?: string;
  readonly parentId?: string;
}

export interface ListSessionOptions {
  readonly status?: SessionStatus;
  readonly limit?: number;
}

export interface UpdateSessionPatch {
  readonly title?: string;
  readonly status?: SessionStatus;
  readonly agentName?: string;
}

export interface SessionStatsDelta {
  readonly messageCountDelta?: number;
  readonly lastMessageAt?: number;
}

export interface RemoveSessionOptions {
  readonly cascadeChildren?: boolean;
}

export interface EnsureRootSessionInput {
  readonly id: string;
  readonly agentName: string;
  readonly projectRoot: string;
  readonly title?: string;
}

export interface SessionManager {
  ensureRoot(input: EnsureRootSessionInput): Promise<Session>;
  create(
    projectDirectory: string,
    options?: CreateSessionOptions,
  ): Promise<Session>;
  findReusableEmptyPrimary(projectDirectory: string): Promise<Session | null>;
  get(sessionId: string): Promise<Session | null>;
  listByProject(
    projectId: string,
    options?: ListSessionOptions,
  ): Promise<Session[]>;
  listChildren(
    parentId: string,
    options?: ListSessionOptions,
  ): Promise<Session[]>;
  getRecent(limit?: number): Promise<Session[]>;
  update(sessionId: string, patch: UpdateSessionPatch): Promise<Session>;
  incrementStats(sessionId: string, delta: SessionStatsDelta): Promise<Session>;
  remove(sessionId: string, options?: RemoveSessionOptions): Promise<void>;
}

export interface SessionStore {
  insert(session: Session): Promise<void>;
  get(sessionId: string): Promise<Session | null>;
  listByProject(
    projectId: string,
    options?: ListSessionOptions,
  ): Promise<Session[]>;
  listChildren(
    parentId: string,
    options?: ListSessionOptions,
  ): Promise<Session[]>;
  getRecent(limit: number): Promise<Session[]>;
  update(sessionId: string, patch: Partial<Session>): Promise<Session>;
  remove(sessionId: string): Promise<void>;
  withTransaction<T>(
    operation: (store: SessionStore) => Promise<T>,
  ): Promise<T>;
}

export interface SessionManagerOptions {
  readonly bus: BusInstance;
  readonly store: SessionStore;
  readonly projectResolver: ProjectResolver;
  readonly messageCleaner: MessageCleaner;
  readonly createSessionId?: () => string;
  readonly now?: () => number;
}
