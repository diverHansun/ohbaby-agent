import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  applySessionChange,
  type UiSessionChangedEvent,
  type UiMessage,
  type UiSessionRecoveryEvent,
  type UiSessionView,
} from "ohbaby-sdk";

type Change = Omit<
  UiSessionChangedEvent,
  "type" | "version" | "bindingGeneration"
>;
interface Partition {
  lastYieldAt: number;
  ready?: Promise<void>;
  tail: Promise<unknown>;
  view?: UiSessionView;
  error?: Error;
  initialized: boolean;
  generation: string;
  unavailableNotified?: string;
  rebuilding?: Promise<void>;
}
/** Application read owner. Only short database work enters run(); reads capture a committed reference. */
export class SessionViewOwner {
  private readonly partitions = new Map<string, Partition>();
  private disposed = false;
  constructor(
    private readonly options: {
      readonly runtimeEpoch: string;
      readonly seed: (
        sessionId: string,
      ) => Promise<Omit<UiSessionView, "version">>;
      readonly publish: (event: UiSessionRecoveryEvent) => void;
      readonly onNotificationFailure?: (
        sessionId: string,
        error: unknown,
      ) => void;
      readonly onInitialized?: (sessionId: string) => void;
    },
  ) {}

  private partition(sessionId: string): Partition {
    if (this.disposed) throw new Error("Session view owner disposed");
    let partition = this.partitions.get(sessionId);
    if (!partition) {
      partition = {
        lastYieldAt: performance.now(),
        tail: Promise.resolve(),
        initialized: false,
        generation: randomUUID(),
      };
      this.partitions.set(sessionId, partition);
    }
    return partition;
  }

  initialize(sessionId: string): Promise<void> {
    const partition = this.partition(sessionId);
    if (partition.ready) return partition.ready;
    const pending = Promise.resolve()
      .then(() => this.options.seed(sessionId))
      .then((seed) => {
        if (this.disposed) return;
        partition.generation = randomUUID();
        partition.view = immutable(
          structuredClone({
            ...seed,
            version: {
              runtimeEpoch: this.options.runtimeEpoch,
              sessionId,
              viewGeneration: partition.generation,
              sessionRevision: 0,
            },
          }),
        );
        partition.initialized = true;
        partition.error = undefined;
        this.options.onInitialized?.(sessionId);
      })
      .catch((error: unknown) => {
        this.markUnavailable(sessionId, error);
        if (partition.ready === pending) partition.ready = undefined;
        throw error;
      });
    partition.ready = pending;
    return pending;
  }

  /** Auxiliary notifications must not open an unread session. */
  hasViewOrPendingSeed(sessionId: string): boolean {
    const partition = this.partitions.get(sessionId);
    return partition?.initialized === true || partition?.ready !== undefined;
  }

  async ready(sessionId: string): Promise<void> {
    const partition = this.partitions.get(sessionId);
    if (!partition?.ready)
      throw Object.assign(new Error("Session view has not been initialized"), {
        code: "SESSION_NOT_INITIALIZED",
      });
    await partition.ready;
  }

  run<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const partition = this.partition(sessionId);
    const ready = partition.initialized
      ? undefined
      : this.initialize(sessionId);
    // A first seed can reject while an earlier queued operation is still settling.
    // Preserve its rejection for the startup barrier without an unhandled promise.
    void ready?.catch(() => undefined);
    return this.runControl(sessionId, async () => {
      if (ready) await ready;
      // A failed later view rebuild keeps chat unavailable, but cannot fail or
      // replay business work in a session that already completed its first seed.
      return operation();
    });
  }

  /** Control writes share the commit queue without requiring a model startup seed. */
  runControl<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const partition = this.partition(sessionId);
    const initialized = partition.ready?.catch(() => undefined);
    const pending = partition.tail.then(async () => {
      // Capture before queueing: reading a later rebuild promise here can
      // create a dependency cycle with that rebuild's queued work.
      await initialized;
      return operation();
    });
    // The caller receives its result/failure immediately. Only the next queued
    // operation waits for fairness; never yield inside a transaction or commit.
    partition.tail = pending
      .catch(() => undefined)
      .then(() => {
        if (performance.now() - partition.lastYieldAt < 8) return;
        return new Promise<void>((resolve) => {
          setImmediate(() => {
            partition.lastYieldAt = performance.now();
            resolve();
          });
        });
      });
    return pending;
  }

  read(sessionId: string): UiSessionView {
    const partition = this.partitions.get(sessionId);
    if (!partition?.view || partition.error) {
      throw Object.assign(
        new Error(partition?.error?.message ?? "Session view unavailable"),
        { code: "SESSION_VIEW_UNAVAILABLE" },
      );
    }
    return partition.view;
  }

  commit(sessionId: string, change: Change): void {
    const partition = this.partition(sessionId);
    if (partition.error) throw partition.error;
    try {
      const view = this.read(sessionId);
      const event: UiSessionChangedEvent = structuredClone({
        ...incrementalTextChange(view, change),
        type: "session.changed",
        serverNow: Date.now(),
        version: {
          ...view.version,
          sessionRevision: view.version.sessionRevision + 1,
        },
      });
      const next = applySessionChange(view, event);
      if (!next) throw new Error("Invalid session projection transition");
      partition.view = immutable(next);
      this.notify(event);
    } catch (error) {
      this.markUnavailable(sessionId, error);
      throw error;
    }
  }

  markUnavailable(sessionId: string, error: unknown): void {
    const partition = this.partition(sessionId);
    partition.error = error instanceof Error ? error : new Error(String(error));
    if (partition.unavailableNotified === partition.generation) return;
    partition.unavailableNotified = partition.generation;
    this.notify({
      type: "session.unavailable",
      viewGeneration: partition.generation,
      runtimeEpoch: this.options.runtimeEpoch,
      sessionId,
      reason: partition.error.message,
    });
  }

  private notify(event: UiSessionRecoveryEvent): void {
    try {
      this.options.publish(event);
    } catch (error) {
      const sessionId =
        event.type === "session.changed"
          ? event.version.sessionId
          : event.sessionId;
      const partition = this.partition(sessionId);
      partition.error =
        error instanceof Error ? error : new Error(String(error));
      if (event.type === "session.changed")
        this.markUnavailable(sessionId, error);
      try {
        this.options.onNotificationFailure?.(sessionId, error);
      } catch {
        /* Diagnostic only. */
      }
    }
  }

  rebuild(sessionId: string): Promise<void> {
    const partition = this.partitions.get(sessionId);
    if (!partition)
      return Promise.reject(new Error("Session view has not been initialized"));
    if (partition.rebuilding) return partition.rebuilding;
    // Query budgets belong to the caller's recovery cycle. The source performs
    // one explicit attempt and shares its cut with concurrent readers.
    const pending = partition.tail
      .then(async () => {
        partition.ready = undefined;
        await this.initialize(sessionId);
      })
      .finally(() => {
        if (partition.rebuilding === pending) partition.rebuilding = undefined;
      });
    partition.rebuilding = pending;
    partition.tail = pending.catch(() => undefined);
    return pending;
  }

  dispose(): void {
    this.disposed = true;
    this.partitions.clear();
  }
}
function immutable<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

/** Only lossless prefix extension is compacted; terminal/metadata/shape edits stay whole. */
function incrementalTextChange(view: UiSessionView, change: Change): Change {
  if (!change.messages || change.textAppends) return change;
  const messages: UiMessage[] = [];
  const textAppends: NonNullable<Change["textAppends"]>[number][] = [];
  const current = new Map(
    view.session.messages.map((message) => [message.id, message]),
  );
  const removed = new Set([
    ...(change.removedMessageIds ?? []),
    ...(change.evictedMessageIds ?? []),
  ]);
  for (const next of change.messages) {
    const previous = current.get(next.id);
    const appends =
      previous && !removed.has(next.id)
        ? textExtension(previous, next)
        : undefined;
    if (appends) textAppends.push(...appends);
    else messages.push(next);
  }
  const { messages: _messages, ...rest } = change;
  return {
    ...rest,
    ...(messages.length ? { messages } : {}),
    ...(textAppends.length ? { textAppends } : {}),
  };
}
function textExtension(
  previous: UiMessage,
  next: UiMessage,
): NonNullable<Change["textAppends"]> | undefined {
  const { parts: oldParts, ...oldMetadata } = previous;
  const { parts: newParts, ...newMetadata } = next;
  if (
    !isDeepStrictEqual(oldMetadata, newMetadata) ||
    oldParts.length !== newParts.length
  )
    return undefined;
  const appends: NonNullable<Change["textAppends"]>[number][] = [];
  const ids = new Set<string>();
  for (let index = 0; index < oldParts.length; index++) {
    const oldPart = oldParts[index];
    const newPart = newParts[index];
    if (!oldPart.id || ids.has(oldPart.id) || oldPart.id !== newPart.id)
      return undefined;
    ids.add(oldPart.id);
    if (
      (oldPart.type === "text" || oldPart.type === "reasoning") &&
      newPart.type === oldPart.type
    ) {
      const { text: oldText, ...oldProperties } = oldPart;
      const { text: newText, ...newProperties } = newPart;
      if (
        !isDeepStrictEqual(oldProperties, newProperties) ||
        !newText.startsWith(oldText)
      )
        return undefined;
      if (newText.length > oldText.length)
        appends.push({
          messageId: next.id,
          partId: oldPart.id,
          offset: oldText.length,
          text: newText.slice(oldText.length),
        });
    } else if (!isDeepStrictEqual(oldPart, newPart)) return undefined;
  }
  return appends;
}
