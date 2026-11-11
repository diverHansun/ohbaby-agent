import { isDeepStrictEqual } from "node:util";
import { projectModelActivity } from "ohbaby-sdk";
import type {
  UiEvent,
  UiMessage,
  UiSession,
  UiSessionHistory,
  UiSessionRecoveryEvent,
  UiSessionView,
  UiPromptSubmission,
  UiRun,
} from "ohbaby-sdk";
import type {
  MessageManager,
  MessageCommittedChange,
  MessageWithParts,
} from "../../core/message/index.js";
import {
  DisplayReasoningOwner,
  type DisplayReasoningChange,
  type DisplayReasoningRecord,
} from "../../core/lifecycle/display-reasoning.js";
import {
  compareMessagePartOrder,
  messageToUiMessage,
} from "./persistent-store.js";
import { SessionViewOwner } from "./session-view.js";
import { messageCursor } from "../../core/message/pagination.js";

export type SourceSessionChange =
  | { readonly kind: "messages"; readonly change: MessageCommittedChange }
  | { readonly kind: "reasoning"; readonly change: DisplayReasoningChange }
  | { readonly kind: "run"; readonly run: UiRun };

/** Bridges durable message facts and the independent display source into one application view. */
export class SourceSessionProjection {
  private readonly scopeListeners = new Set<
    (change: SourceSessionChange) => void
  >();
  readonly owner: SessionViewOwner;
  readonly reasoning: DisplayReasoningOwner;
  private readonly messages = new Map<string, Map<string, MessageWithParts>>();
  private readonly currentRuns = new Map<string, string>();
  private readonly seededSavedIds = new Map<string, readonly string[]>();
  private readonly acceptedReasoning = new Map<
    string,
    DisplayReasoningRecord
  >();
  constructor(
    private readonly options: {
      readonly runtimeEpoch: string;
      readonly messageManager: MessageManager;
      readonly metadata: (
        sessionId: string,
      ) => Promise<Omit<UiSession, "messages">>;
      /** Active main runs, or the most recent main run when none is active. */
      readonly currentRuns: (sessionId: string) => Promise<readonly UiRun[]>;
      /** Main runs with these IDs; an empty list asks for nothing. */
      readonly runsByIds: (
        sessionId: string,
        runIds: readonly string[],
      ) => Promise<readonly UiRun[]>;
      readonly prompts: (
        sessionId: string,
        messages: readonly UiMessage[],
        runs: readonly UiRun[],
      ) => Promise<readonly UiPromptSubmission[]>;
      readonly publish: (event: UiSessionRecoveryEvent) => void;
      readonly subviews?: (
        sessionId: string,
      ) => Partial<
        Pick<UiSessionView, "todo" | "goal" | "context" | "executionRecovery">
      >;
      readonly onNotificationFailure?: (
        sessionId: string,
        error: unknown,
      ) => void;
    },
  ) {
    this.reasoning = new DisplayReasoningOwner({
      save: (part): ReturnType<MessageManager["saveReasoningPart"]> =>
        options.messageManager.saveReasoningPart(part),
      commit: (change): Promise<void> =>
        this.owner.run(change.part.sessionId, () => {
          this.commitReasoning(change);
          return Promise.resolve();
        }),
      onCommitError: (sessionId, error): void => {
        this.owner.markUnavailable(sessionId, error);
      },
    });
    this.owner = new SessionViewOwner({
      runtimeEpoch: options.runtimeEpoch,
      seed: (id): Promise<Omit<UiSessionView, "version">> => this.seed(id),
      publish: options.publish,
      onNotificationFailure: options.onNotificationFailure,
      onInitialized: (sessionId): void => {
        this.reasoning.acceptPersisted(
          this.seededSavedIds.get(sessionId) ?? [],
        );
        this.seededSavedIds.delete(sessionId);
        this.releaseAcceptedSaves(sessionId);
      },
    });
    options.messageManager.setCommitCoordinator({
      run: (id, operation) => this.owner.run(id, operation),
      onCommitted: (change) => this.commitMessages(change),
      onProjectionError: (id, error) => {
        this.owner.markUnavailable(id, error);
      },
    });
  }

  removeSession(sessionId: string): void {
    this.owner.removeSession(sessionId);
    this.messages.delete(sessionId);
    this.currentRuns.delete(sessionId);
    this.seededSavedIds.delete(sessionId);
    this.reasoning.removeSession(sessionId);
    for (const [id, part] of this.acceptedReasoning)
      if (part.sessionId === sessionId) this.acceptedReasoning.delete(id);
  }

  commitScopeRun(run: UiRun): void {
    this.notifyScopes({ kind: "run", run });
  }

  subscribeScopeChanges(
    listener: (change: SourceSessionChange) => void,
  ): () => void {
    this.scopeListeners.add(listener);
    return () => {
      this.scopeListeners.delete(listener);
    };
  }

  private notifyScopes(change: SourceSessionChange): void {
    for (const listener of this.scopeListeners) {
      // Read projections cannot invalidate a successfully committed model message.
      try {
        listener(change);
      } catch {
        /* The child reader owns its recovery. */
      }
    }
  }

  scopeMetadata(sessionId: string): Promise<Omit<UiSession, "messages">> {
    return this.options.metadata(sessionId);
  }

  projectComplete(record: MessageWithParts): UiMessage | undefined {
    return this.project({
      ...record,
      parts: record.parts.map((part) => ({
        ...part,
        time: { ...part.time, compacted: undefined },
      })),
    });
  }

  private async seed(
    sessionId: string,
  ): Promise<Omit<UiSessionView, "version">> {
    const metadata = await this.options.metadata(sessionId);
    const page = await this.options.messageManager.listPageBySession(
      sessionId,
      { scope: { contextScopeId: undefined } },
    );
    const candidates = await this.options.currentRuns(sessionId);
    const latestRun = candidates.find(isActiveRun) ?? candidates.at(0);
    const records = new Map(
      page.messages.map((message) => [message.info.id, message]),
    );
    if (latestRun) {
      this.currentRuns.set(sessionId, latestRun.id);
      let before: string | undefined;
      do {
        const runPage = await this.options.messageManager.listPageByRun(
          sessionId,
          latestRun.id,
          { before, limit: 200, scope: { contextScopeId: undefined } },
        );
        for (const record of runPage.messages)
          records.set(record.info.id, record);
        before = runPage.hasMore ? runPage.nextCursor : undefined;
      } while (before);
    } else {
      this.currentRuns.delete(sessionId);
    }
    this.messages.set(sessionId, records);
    for (const [id, part] of this.acceptedReasoning)
      if (part.sessionId === sessionId) this.acceptedReasoning.delete(id);
    for (const part of this.reasoning.snapshot(sessionId).parts)
      this.acceptedReasoning.set(part.partId, part);
    const saved = this.reasoning.persistedParts(sessionId);
    this.seededSavedIds.set(
      sessionId,
      saved.map((part) => part.partId),
    );
    for (const part of saved) {
      this.acceptedReasoning.set(part.partId, part);
      const record = records.get(part.messageId);
      if (record)
        records.set(part.messageId, {
          ...record,
          parts: [
            ...record.parts.filter((value) => value.id !== part.partId),
            {
              id: part.partId,
              messageId: part.messageId,
              sessionId,
              orderIndex: record.parts.length,
              type: "reasoning",
              text: part.text,
              endReason: part.endReason,
              metadata: part.metadata,
            },
          ],
        });
    }
    const messages = [...records.values()]
      .map((record) => this.project(record))
      .filter((message): message is UiMessage => message !== undefined)
      .sort(compareMessages);
    const runIds = messageRunIds(messages);
    for (const run of candidates) if (isActiveRun(run)) runIds.add(run.id);
    const runs = visibleRuns(
      await this.options.runsByIds(sessionId, [...runIds]),
      messages,
    );
    return {
      session: { ...metadata, messages },
      runs,
      prompts: await this.options.prompts(sessionId, messages, runs),
      history: { before: page.nextCursor, hasMore: page.hasMore },
      reasoningMissing: this.reasoning.snapshot(sessionId).missingCount > 0,
      todo: { status: "unavailable", reason: "Todo has not been loaded" },
      goal: { status: "unavailable", reason: "Goal has not been loaded" },
      context: {
        status: "unavailable",
        reason: "Context statistics have not been loaded",
      },
      ...this.options.subviews?.(sessionId),
    };
  }

  private project(record: MessageWithParts): UiMessage | undefined {
    this.releaseAcceptedSaves(record.info.sessionId);
    const pending = new Set(
      this.reasoning.pendingPartIds(record.info.sessionId),
    );
    const projected =
      messageToUiMessage({
        ...record,
        parts: record.parts.filter(
          (part) =>
            !pending.has(part.id) ||
            this.acceptedReasoning.get(part.id)?.saveState === "saved",
        ),
      }) ??
      (record.info.role === "assistant"
        ? {
            id: record.info.id,
            runId: record.info.runId,
            createdAt: new Date(record.info.time.created).toISOString(),
            role: "assistant" as const,
            status: record.info.error
              ? ("error" as const)
              : record.info.time.completed
                ? ("completed" as const)
                : ("streaming" as const),
            parts: [],
          }
        : undefined);
    return projected
      ? this.overlayReasoning(projected, record.info.sessionId)
      : undefined;
  }

  private overlayReasoning(message: UiMessage, sessionId: string): UiMessage {
    const source = [...this.acceptedReasoning.values()].filter(
      (part) => part.sessionId === sessionId && part.messageId === message.id,
    );
    if (!source.length) return message;
    const pendingIds = new Set(source.map((part) => part.partId));
    return {
      ...message,
      parts: [
        ...message.parts.filter((part) => !part.id || !pendingIds.has(part.id)),
        ...source.map(reasoningPart),
      ].sort(compareMessagePartOrder),
    };
  }

  /** Called inside the existing session owner after an atomic runtime-input commit. */
  acceptRuntimeInput(message: MessageWithParts): Promise<void> {
    return this.commitMessages({
      sessionId: message.info.sessionId,
      createdMessageIds: [message.info.id],
      messages: [message.info],
      parts: message.parts,
      removedMessageIds: [],
    });
  }

  private async commitMessages(change: MessageCommittedChange): Promise<void> {
    const records = this.messages.get(change.sessionId);
    if (!records)
      throw new Error("Message mutation occurred before session seed");
    const touched = new Set<string>();
    let historyInvalidated = false;
    for (const id of change.removedMessageIds ?? []) {
      records.delete(id);
      historyInvalidated = true;
    }
    for (const info of change.messages ?? []) {
      if (info.contextScopeId !== undefined) continue;
      const existing = records.get(info.id);
      if (!existing && !change.createdMessageIds?.includes(info.id)) {
        historyInvalidated = true;
        continue;
      }
      records.set(info.id, { info, parts: existing?.parts ?? [] });
      touched.add(info.id);
    }
    for (const part of change.parts ?? []) {
      if (part.contextScopeId !== undefined || part.type === "model-state")
        continue;
      const record = records.get(part.messageId);
      if (!record) {
        historyInvalidated = true;
        continue;
      }
      const parts = new Map(record.parts.map((value) => [value.id, value]));
      parts.set(part.id, part);
      records.set(part.messageId, {
        ...record,
        parts: [...parts.values()].sort((a, b) => a.orderIndex - b.orderIndex),
      });
      touched.add(part.messageId);
    }
    const messages = [...touched]
      .map((id) => {
        const record = records.get(id);
        if (!record)
          throw new Error("Committed message is missing from projection");
        return this.project(record);
      })
      .filter((message): message is UiMessage => message !== undefined);
    const missingRunIds = messageRunIds(messages);
    for (const run of this.owner.read(change.sessionId).runs)
      missingRunIds.delete(run.id);
    // A late runtime input can be the first visible message of an already-ended run.
    const fetched = missingRunIds.size
      ? await this.options.runsByIds(change.sessionId, [...missingRunIds])
      : [];
    // `run.updated` is applied synchronously and may land during the lookup,
    // so read the view only now and keep its runs over the fetched copies.
    const current = this.owner.read(change.sessionId);
    const known = new Set(current.runs.map((run) => run.id));
    const runs = [
      ...current.runs,
      ...fetched.filter((run) => !known.has(run.id)),
    ];
    const projectedMessages = new Map(
      current.session.messages.map((message) => [message.id, message]),
    );
    for (const message of messages) projectedMessages.set(message.id, message);
    for (const id of change.removedMessageIds ?? [])
      projectedMessages.delete(id);
    const projectedRuns = visibleRuns(runs, [...projectedMessages.values()]);
    this.owner.commit(change.sessionId, {
      ...(!isDeepStrictEqual(current.runs, projectedRuns)
        ? { runs: projectedRuns }
        : {}),
      messages,
      removedMessageIds: change.removedMessageIds,
      historyInvalidated,
    });
    this.trim(change.sessionId);
    this.notifyScopes({ kind: "messages", change });
  }

  private commitReasoning(change: DisplayReasoningChange): void {
    const { part } = change;
    const records = this.messages.get(part.sessionId);
    const record = records?.get(part.messageId);
    const view = this.owner.read(part.sessionId);
    const current = view.session.messages.find(
      (message) => message.id === part.messageId,
    );
    let messages: UiMessage[] | undefined;
    if (current) {
      const parts = current.parts.filter((value) => value.id !== part.partId);
      if (change.kind !== "missing") parts.push(reasoningPart(part));
      messages = [{ ...current, parts: parts.sort(compareMessagePartOrder) }];
    }
    if (records && record && change.kind === "saved") {
      const parts = record.parts.filter((value) => value.id !== part.partId);
      parts.push({
        id: part.partId,
        messageId: part.messageId,
        sessionId: part.sessionId,
        orderIndex: parts.length,
        type: "reasoning",
        text: part.text,
        endReason: part.endReason,
        metadata: part.metadata,
      });
      records.set(part.messageId, { ...record, parts });
    }
    const updatedMessage = messages?.[0];
    const runs = updatedMessage
      ? visibleRuns(
          view.runs,
          view.session.messages.map((message) =>
            message.id === part.messageId ? updatedMessage : message,
          ),
        )
      : view.runs;
    this.owner.commit(part.sessionId, {
      ...(!isDeepStrictEqual(view.runs, runs) ? { runs } : {}),
      messages,
      reasoningMissing: change.missingCount > 0,
      historyInvalidated: change.kind === "missing" || change.kind === "saved",
    });
    if (change.kind === "missing") this.acceptedReasoning.delete(part.partId);
    else this.acceptedReasoning.set(part.partId, part);
    this.releaseAcceptedSaves(part.sessionId);
    this.notifyScopes({ kind: "reasoning", change });
  }

  private releaseAcceptedSaves(sessionId: string): void {
    const pending = new Set(this.reasoning.pendingPartIds(sessionId));
    for (const [id, part] of this.acceptedReasoning)
      if (
        part.sessionId === sessionId &&
        part.saveState === "saved" &&
        !pending.has(id)
      )
        this.acceptedReasoning.delete(id);
  }

  commitEvent(event: UiEvent): void | Promise<void> {
    const sessionId =
      event.type === "todo.updated" || event.type === "goal.updated"
        ? event.sessionId
        : event.type === "context.window.updated"
          ? event.usage.sessionId
          : event.type === "session.updated"
            ? event.session.id
            : undefined;
    if (sessionId !== undefined) {
      if (!this.owner.hasViewOrPendingSeed(sessionId)) return;
      // These producers run outside the durable commit hooks. Queue their
      // projection after an in-flight seed, without awaiting from onChange.
      return this.owner
        .runControl(sessionId, () => {
          this.commitAuxiliaryEvent(event);
          return Promise.resolve();
        })
        .catch((error: unknown) => {
          this.owner.markUnavailable(sessionId, error);
        });
    }
    if (event.type === "run.updated") {
      const id = event.run.sessionId;
      const current = this.owner.read(id);
      if (event.run.status.kind === "running")
        this.currentRuns.set(id, event.run.id);
      const runs = [
        {
          ...current.runs.find((run) => run.id === event.run.id),
          ...event.run,
        },
        ...current.runs.filter((run) => run.id !== event.run.id),
      ];
      this.owner.commit(id, {
        runs: visibleRuns(runs, current.session.messages),
      });
      this.trim(id);
      this.notifyScopes({ kind: "run", run: event.run });
    } else if (
      event.type === "prompt.submitted" ||
      event.type === "prompt.updated"
    ) {
      const id = event.prompt.sessionId;
      const current = this.owner.read(id);
      const messageIds = new Set(
        current.session.messages.map((message) => message.id),
      );
      const runIds = new Set(current.runs.map((run) => run.id));
      const prompts = [
        ...current.prompts.filter(
          (prompt) => prompt.promptId !== event.prompt.promptId,
        ),
        event.prompt,
      ].filter(
        (prompt) =>
          prompt.rewoundAt !== undefined ||
          prompt.status === "queued" ||
          prompt.status === "retained" ||
          prompt.status === "starting" ||
          prompt.status === "running" ||
          messageIds.has(prompt.userMessageId) ||
          (prompt.runId !== undefined && runIds.has(prompt.runId)),
      );
      this.owner.commit(id, { prompts });
    }
  }

  private commitAuxiliaryEvent(event: UiEvent): void {
    if (event.type === "todo.updated") {
      this.owner.commit(event.sessionId, {
        todo: {
          status: "ready",
          value: {
            sessionId: event.sessionId,
            todos: event.todos,
            visible: event.visible,
          },
        },
      });
    } else if (event.type === "goal.updated") {
      this.owner.commit(event.sessionId, {
        goal: { status: "ready", value: event.goal },
      });
    } else if (event.type === "context.window.updated") {
      this.owner.commit(event.usage.sessionId, {
        context: { status: "ready", value: event.usage },
      });
    } else if (event.type === "session.updated") {
      const { messages: _messages, ...metadata } = event.session;
      this.owner.commit(event.session.id, { session: metadata });
    }
  }

  private trim(sessionId: string): void {
    const records = this.messages.get(sessionId);
    if (!records) throw new Error("Session messages are not initialized");
    const sorted = [...records.values()].sort(
      (a, b) =>
        a.info.time.created - b.info.time.created ||
        compareIds(a.info.id, b.info.id),
    );
    const recent = new Set(sorted.slice(-50).map((record) => record.info.id));
    const temporary = new Set(
      this.reasoning.snapshot(sessionId).parts.map((part) => part.messageId),
    );
    const remove: string[] = [];
    for (const record of sorted) {
      if (
        !recent.has(record.info.id) &&
        !temporary.has(record.info.id) &&
        (this.currentRuns.get(sessionId) === undefined ||
          record.info.runId !== this.currentRuns.get(sessionId))
      ) {
        records.delete(record.info.id);
        remove.push(record.info.id);
      }
    }
    if (remove.length) {
      // Protected current-run messages can be separated by queued user messages.
      // The pagination boundary must cover the contiguous recent window, even
      // when that overlaps protected messages already included in the view.
      const first = sorted.slice(-50).at(0);
      const current = this.owner.read(sessionId);
      this.owner.commit(sessionId, {
        runs: visibleRuns(
          current.runs,
          current.session.messages.filter((message) => records.has(message.id)),
        ),
        evictedMessageIds: remove,
        history: {
          before: first
            ? messageCursor(sessionId, first.info, {
                scope: { contextScopeId: undefined },
              })
            : undefined,
          hasMore: true,
        },
        historyInvalidated: true,
      });
    }
  }

  /** Read the complete execution under the same revision lane as live commits. */
  executionHistory(
    sessionId: string,
    contextScopeId: string,
    runId: string,
    before?: string,
    limit?: number,
    includeRunSummaries?: import("../../core/message/types.js").RunSummaryWindow,
  ): Promise<UiSessionHistory> {
    return this.owner.run(sessionId, async () => {
      const page = await this.options.messageManager.listPageByRun(
        sessionId,
        runId,
        { before, limit, scope: { contextScopeId }, includeRunSummaries },
      );
      const messages = page.messages
        .map((record) =>
          this.project({
            ...record,
            parts: record.parts.map((part) => ({
              ...part,
              time: { ...part.time, compacted: undefined },
            })),
          }),
        )
        .filter((message): message is UiMessage => message !== undefined);
      const view = this.owner.read(sessionId);
      return {
        version: view.version,
        serverNow: Date.now(),
        messages,
        runs: [],
        prompts: [],
        before: page.nextCursor,
        hasMore: page.hasMore,
        reasoningMissing: view.reasoningMissing,
      };
    });
  }

  history(
    sessionId: string,
    before?: string,
    limit?: number,
  ): Promise<UiSessionHistory> {
    return this.owner.run(sessionId, async () => {
      const view = this.owner.read(sessionId);
      const page = await this.options.messageManager.listPageBySession(
        sessionId,
        { before, limit, scope: { contextScopeId: undefined } },
      );
      const messages = page.messages
        .map((record) => this.project(record))
        .filter((message): message is UiMessage => message !== undefined);
      const runs = [
        ...(await this.options.runsByIds(sessionId, [
          ...messageRunIds(messages),
        ])),
      ].sort(compareRunsNewestFirst);
      const prompts = await this.options.prompts(sessionId, messages, runs);
      return {
        version: view.version,
        serverNow: Date.now(),
        messages,
        prompts,
        runs,
        before: page.nextCursor,
        hasMore: page.hasMore,
        reasoningMissing: view.reasoningMissing,
      };
    });
  }
}
function isActiveRun(run: UiRun): boolean {
  return (
    run.status.kind === "running" ||
    run.status.kind === "waiting-for-permission"
  );
}
function messageRunIds(messages: readonly UiMessage[]): Set<string> {
  return new Set(
    messages.flatMap((message) => (message.runId ? [message.runId] : [])),
  );
}
function visibleRuns(
  runs: readonly UiRun[],
  messages: readonly UiMessage[],
): UiRun[] {
  const ids = messageRunIds(messages);
  return runs
    .filter((run) => isActiveRun(run) || ids.has(run.id))
    .sort(compareRunsNewestFirst)
    .map((run) => ({
      ...run,
      modelActivity: projectModelActivity(run, messages),
    }));
}
function reasoningPart(
  part: DisplayReasoningRecord,
): UiMessage["parts"][number] {
  return {
    id: part.partId,
    type: "reasoning",
    text: part.text,
    endReason: part.endReason,
    saveState: part.saveState,
    metadata: part.metadata,
  };
}
/** The order runs reach clients in: newest first, ties broken by ID. */
export function compareRunsNewestFirst(a: UiRun, b: UiRun): number {
  return b.startedAt.localeCompare(a.startedAt) || compareIds(b.id, a.id);
}
function compareMessages(a: UiMessage, b: UiMessage): number {
  return a.createdAt.localeCompare(b.createdAt) || compareIds(a.id, b.id);
}
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
