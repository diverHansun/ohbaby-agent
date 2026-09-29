import { isDeepStrictEqual } from "node:util";
import type {
  UiMessage,
  UiSubagentExecution,
  UiRun,
  UiSessionView,
  UiSubagentConversationEvent,
  UiSubagentConversationQuery,
  UiSubagentConversationUnwatchQuery,
  UiSubagentConversationView,
} from "ohbaby-sdk";
import type { MessageManager } from "../../core/message/index.js";
import type {
  SubagentExecutionRecord,
  SubagentExecutionStore,
} from "../../agents/subagents/execution-store.js";
import { SessionViewOwner } from "../ui-state/session-view.js";
import {
  SourceSessionProjection,
  type SourceSessionChange,
} from "../ui-state/source-session-projection.js";
import { projectSubagentExecution } from "./subagent-views.js";
import {
  createSubagentConversationHistory,
  parentMessage,
} from "./subagent-conversation-history.js";

interface ScopeView {
  readonly parentSessionId: string;
  readonly rootSessionId: string;
  readonly subagentId: string;
  readonly sessionId: string;
  readonly scopeId?: string;
  readonly owner: SessionViewOwner;
  readonly executions: Map<string, SubagentExecutionRecord>;
  readonly watches: Set<string>;
  pendingExecutions?: SubagentExecutionRecord[];
  accessedAt: number;
}

/** A read-only scope lane fed by the existing commit source, never a second writer. */
export class SubagentConversationProjection {
  private readonly scopes = new Map<string, ScopeView>();
  private readonly history;
  private readonly unsubscribeSource: () => void;
  private readonly unsubscribeExecutions: () => void;
  private disposed = false;

  constructor(
    private readonly options: {
      readonly runtimeEpoch: string;
      readonly source: SourceSessionProjection;
      readonly executions: SubagentExecutionStore;
      readonly instances?: {
        get(input: { parentSessionId: string; subagentId: string }): Promise<{
          readonly parentSessionId: string;
          readonly name?: string;
          readonly description?: string;
        } | null>;
      };
      readonly messages: MessageManager;
      readonly validateRoot: (id: string) => Promise<void>;
      readonly runs: (
        sessionId: string,
        scopeId?: string,
      ) => Promise<readonly UiRun[]>;
      readonly publish: (event: UiSubagentConversationEvent) => void;
    },
  ) {
    this.history = createSubagentConversationHistory({
      executions: options.executions,
      messages: options.messages,
      project: (record) => options.source.projectComplete(record),
    });
    this.unsubscribeSource = options.source.subscribeScopeChanges((change) => {
      const sessionId =
        change.kind === "messages"
          ? change.change.sessionId
          : change.kind === "reasoning"
            ? change.change.part.sessionId
            : change.run.sessionId;
      for (const scope of this.scopes.values()) {
        if (scope.sessionId === sessionId)
          this.enqueue(scope, () => this.applySource(scope, change));
      }
    });
    this.unsubscribeExecutions = options.executions.subscribe((record) => {
      const scope = this.scopes.get(this.key(record));
      if (!scope) return;
      // Binding a newly created child changes the physical lane. Next read re-seeds it.
      if (record.childSessionId && record.childSessionId !== scope.sessionId) {
        scope.owner.markUnavailable(
          scope.sessionId,
          new Error("Child session is ready"),
        );
        return;
      }
      this.enqueue(scope, async () => {
        const old = scope.executions.get(record.executionId);
        if (
          old &&
          isDeepStrictEqual(
            conversationExecution(old),
            conversationExecution(record),
          )
        )
          return;
        scope.executions.set(record.executionId, record);
        const message = parentMessage(record);
        const existing = scope.owner
          .read(scope.sessionId)
          .session.messages.find((m) => m.id === message?.id);
        const runs = record.childSessionId
          ? await options.runs(scope.sessionId, scope.scopeId)
          : [];
        scope.pendingExecutions = [record];
        scope.owner.commit(scope.sessionId, {
          messages: message && !existing ? [message] : [],
          runs,
        });
        this.trim(scope);
      });
    });
  }

  private key(value: { rootSessionId: string; subagentId: string }): string {
    return JSON.stringify([value.rootSessionId, value.subagentId]);
  }

  private enqueue(scope: ScopeView, operation: () => Promise<void>): void {
    void this.options.source.owner
      .runControl(scope.sessionId, async () => {
        if (this.disposed || this.scopes.get(this.key(scope)) !== scope) return;
        try {
          await scope.owner.ready(scope.sessionId);
          await operation();
        } catch (error) {
          scope.owner.markUnavailable(scope.sessionId, error);
        }
      })
      .catch(() => undefined);
  }

  private async latest(
    input: UiSubagentConversationQuery,
  ): Promise<SubagentExecutionRecord> {
    const records = await this.options.executions.list({
      rootSessionId: input.rootSessionId,
      subagentId: input.subagentId,
      limit: 1,
    });
    const record = records.at(0);
    if (
      !record ||
      record.rootSessionId !== input.rootSessionId ||
      record.subagentId !== input.subagentId
    )
      throw new Error("Unknown subagent for this root");
    return record;
  }

  private async scope(input: UiSubagentConversationQuery): Promise<ScopeView> {
    const latest = await this.latest(input);
    const sessionId = latest.childSessionId ?? latest.rootSessionId;
    const key = this.key(input);
    let scope = this.scopes.get(key);
    if (
      scope?.sessionId === sessionId &&
      scope.scopeId === latest.childScopeId
    ) {
      scope.accessedAt = Date.now();
      return scope;
    }
    const watches = scope?.watches ?? new Set<string>();
    scope?.owner.dispose();
    const executions = new Map<string, SubagentExecutionRecord>();
    const owner = new SessionViewOwner({
      runtimeEpoch: this.options.runtimeEpoch,
      seed: async (): Promise<Omit<UiSessionView, "version">> => {
        const page = await this.history.read({
          rootSessionId: input.rootSessionId,
          subagentId: input.subagentId,
          limit: 100,
        });
        executions.clear();
        for (const record of page.executions)
          executions.set(record.executionId, record);
        const metadata = await this.options.source.scopeMetadata(sessionId);
        return {
          session: { ...metadata, messages: page.messages },
          runs: latest.childSessionId
            ? await this.options.runs(sessionId, latest.childScopeId)
            : [],
          prompts: [],
          history: page.history,
          reasoningMissing: false,
          todo: { status: "unavailable", reason: "Read-only subagent" },
          goal: { status: "unavailable", reason: "Read-only subagent" },
          context: { status: "unavailable", reason: "Read-only subagent" },
        };
      },
      publish: (event): void => {
        const changedExecutions = scope?.pendingExecutions;
        if (scope) scope.pendingExecutions = undefined;
        if (event.type === "session.changed") {
          this.options.publish({
            type: "subagent.conversation.changed",
            rootSessionId: input.rootSessionId,
            subagentId: input.subagentId,
            change: event,
            ...(changedExecutions?.length
              ? { executions: changedExecutions.map(conversationExecution) }
              : {}),
          });
        } else {
          this.options.publish({
            type: "subagent.conversation.unavailable",
            rootSessionId: input.rootSessionId,
            subagentId: input.subagentId,
            unavailable: event,
          });
        }
      },
    });
    scope = {
      rootSessionId: input.rootSessionId,
      parentSessionId: latest.parentSessionId,
      subagentId: input.subagentId,
      sessionId,
      scopeId: latest.childScopeId,
      owner,
      executions,
      watches,
      accessedAt: Date.now(),
    };
    this.scopes.set(key, scope);
    this.prune();
    return scope;
  }

  async read(
    input: UiSubagentConversationQuery,
  ): Promise<UiSubagentConversationView> {
    if (this.disposed) throw new Error("Subagent reader disposed");
    input.signal?.throwIfAborted();
    if (input.runtimeEpoch && input.runtimeEpoch !== this.options.runtimeEpoch)
      throw new Error("Backend runtime changed");
    await this.options.validateRoot(input.rootSessionId);
    const scope = await this.scope(input);
    return this.options.source.owner.run(scope.sessionId, async () => {
      input.signal?.throwIfAborted();
      await scope.owner.initialize(scope.sessionId);
      try {
        scope.owner.read(scope.sessionId);
      } catch {
        await scope.owner.rebuild(scope.sessionId);
      }
      const page = await this.history.read(input);
      input.signal?.throwIfAborted();
      await this.options.validateRoot(input.rootSessionId);
      const anchor = input.anchorExecutionId
        ? await this.options.executions.getForRoot(
            input.anchorExecutionId,
            input.rootSessionId,
          )
        : undefined;
      const storedResult =
        anchor && !anchor.childRunId && anchor.subagentId === input.subagentId
          ? anchor.output
          : undefined;
      const instance = await this.options.instances?.get({
        parentSessionId: scope.parentSessionId,
        subagentId: input.subagentId,
      });
      const displayName =
        instance?.parentSessionId === scope.parentSessionId
          ? stableDisplayName(instance.name, instance.description)
          : "Subagent";
      const executions = new Map(scope.executions);
      for (const record of page.executions)
        executions.set(record.executionId, record);
      return {
        rootSessionId: input.rootSessionId,
        subagentId: input.subagentId,
        displayName,
        view: scope.owner.read(scope.sessionId),
        ...page,
        executions: [...executions.values()].map(conversationExecution),
        readOnly: true,
        ...(storedResult ? { storedResult } : {}),
      };
    });
  }

  async retain(
    input: UiSubagentConversationQuery & { watchId: string },
  ): Promise<void> {
    await this.read(input);
    this.scopes.get(this.key(input))?.watches.add(input.watchId);
  }

  async release(input: UiSubagentConversationUnwatchQuery): Promise<void> {
    const scope = this.scopes.get(this.key(input));
    if (!scope || !scope.watches.delete(input.watchId) || scope.watches.size)
      return;
    this.scopes.delete(this.key(scope));
    scope.owner.dispose();
    await Promise.resolve();
  }

  private async applySource(
    scope: ScopeView,
    event: SourceSessionChange,
  ): Promise<void> {
    // Before the first child binding the parent session only supplies metadata.
    // It must never become the source of the child transcript or run status.
    if (
      ![...scope.executions.values()].some(
        (record) => record.childSessionId === scope.sessionId,
      )
    )
      return;
    const current = scope.owner.read(scope.sessionId);
    if (event.kind === "run") {
      if (
        ![...scope.executions.values()].some(
          (r) => r.childRunId === event.run.id,
        )
      )
        return;
      scope.owner.commit(scope.sessionId, {
        runs: [
          event.run,
          ...current.runs.filter((r) => r.id !== event.run.id),
        ].slice(0, 50),
      });
      return;
    }
    const ids = new Set<string>();
    let removed: readonly string[] = [];
    if (event.kind === "reasoning") {
      if (event.change.part.contextScopeId !== scope.scopeId) return;
      ids.add(event.change.part.messageId);
    } else {
      for (const message of event.change.messages ?? [])
        if (message.contextScopeId === scope.scopeId) ids.add(message.id);
      for (const part of event.change.parts ?? [])
        if (part.contextScopeId === scope.scopeId) ids.add(part.messageId);
      removed = (event.change.removedMessageIds ?? []).filter((id) =>
        current.session.messages.some((m) => m.id === id),
      );
    }
    if (!ids.size && !removed.length) return;
    const messages: UiMessage[] = [];
    for (let offset = 0; offset < ids.size; offset += 200) {
      const records = await this.options.messages.listByIds(
        scope.sessionId,
        [...ids].slice(offset, offset + 200),
      );
      for (const record of records) {
        if (record.info.contextScopeId !== scope.scopeId) continue;
        const projected = this.options.source.projectComplete(record);
        if (projected) {
          const parent = [...scope.executions.values()].find(
            (r) => r.childUserMessageId === projected.id,
          );
          messages.push(
            parent && projected.parts.length === 0
              ? (parentMessage(parent) ?? projected)
              : projected,
          );
        }
      }
    }
    scope.owner.commit(scope.sessionId, {
      messages,
      removedMessageIds: removed,
      ...(event.kind === "reasoning" && event.change.kind === "missing"
        ? { reasoningMissing: true }
        : {}),
    });
    this.trim(scope);
  }

  private trim(scope: ScopeView): void {
    const current = scope.owner.read(scope.sessionId);
    if (current.session.messages.length <= 200) return;
    const candidates = current.session.messages
      .slice(0, -150)
      .filter((m) => m.status !== "streaming");
    if (!candidates.length) return;
    scope.owner.commit(scope.sessionId, {
      evictedMessageIds: candidates.map((m) => m.id),
      historyInvalidated: true,
    });
    const kept = scope.owner.read(scope.sessionId).session.messages;
    for (const [id, record] of scope.executions) {
      if (record.status === "queued" || record.status === "running") continue;
      if (
        !kept.some(
          (m) =>
            m.id === record.childUserMessageId || m.runId === record.childRunId,
        )
      )
        scope.executions.delete(id);
    }
  }

  private prune(): void {
    const idle = [...this.scopes.values()]
      .filter((s) => !s.watches.size)
      .sort((a, b) => b.accessedAt - a.accessedAt);
    for (const scope of idle.slice(8)) {
      this.scopes.delete(this.key(scope));
      scope.owner.dispose();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeSource();
    this.unsubscribeExecutions();
    for (const scope of this.scopes.values()) scope.owner.dispose();
    this.scopes.clear();
  }
}

function conversationExecution(
  record: SubagentExecutionRecord,
): UiSubagentExecution {
  return { ...projectSubagentExecution(record), prompt: record.prompt };
}

function stableDisplayName(name?: string, description?: string): string {
  const value =
    [name, description]
      .map((value) => value?.trim())
      .find((value) => value !== undefined && value !== "") ?? "Subagent";
  const normalized = value.replace(/\s+/gu, " ");
  return normalized.length > 80
    ? `${normalized.slice(0, 77).trimEnd()}...`
    : normalized;
}
