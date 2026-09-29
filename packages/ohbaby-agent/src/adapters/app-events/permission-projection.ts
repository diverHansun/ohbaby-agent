import { randomUUID } from "node:crypto";
import type {
  UiEvent,
  UiPermissionEvent,
  UiPermissionRequest,
  UiPermissionSnapshot,
  UiSnapshot,
} from "ohbaby-sdk";
import type { BusInstance, BusUnsubscribe } from "../../bus/index.js";
import {
  isRememberablePermissionPattern,
  PermissionEvent,
  PermissionUnavailableError,
  type PermissionCommit,
  type PermissionInfo,
} from "../../permission/index.js";

export type UiPermissionState = NonNullable<UiSnapshot["permission"]>;

export interface StartPermissionEventProjectionOptions {
  readonly bus: BusInstance;
  readonly currentPermissionState: () => UiPermissionState;
  readonly publish: (event: UiEvent) => void;
  readonly now?: () => number;
}

export function toUiPermissionRequest(input: {
  readonly info: PermissionInfo;
}): UiPermissionRequest {
  const { info } = input;
  const allowAlways =
    info.metadata.rememberable !== false &&
    isRememberablePermissionPattern(info.pattern);
  return Object.freeze({
    choices: Object.freeze([
      Object.freeze({
        id: "allow_once",
        label: "Allow once",
        intent: "allow",
      } as const),
      ...(allowAlways
        ? [
            Object.freeze({
              id: "allow_always",
              label: "Always allow",
              intent: "allow",
            } as const),
          ]
        : []),
      Object.freeze({ id: "reject", label: "Reject", intent: "deny" } as const),
    ]),
    description: info.pattern,
    id: info.id,
    sessionId: info.sessionId,
    runId: info.runId,
    callId: info.callId,
    messageId: info.messageId,
    rootSessionId: info.rootSessionId,
    sourceLabel: info.sourceLabel,
    contextScopeId: info.contextScopeId,
    createdAt: info.time.created,
    title: info.title,
  });
}

export interface PermissionProjection {
  readonly permissionEpoch: string;
  readonly criticalCommit: (event: PermissionCommit) => void;
  readonly notifyCommitted: (event: PermissionCommit) => void;
  readonly markUnavailable: (
    rootSessionId: string | undefined,
    error: Error,
  ) => void;
  readonly getSnapshot: (rootSessionId: string | null) => UiPermissionSnapshot;
  readonly listRequests: () => readonly UiPermissionRequest[];
  readonly subscribe: (
    handler: (event: UiPermissionEvent) => void,
    onError?: (error: unknown) => void,
  ) => BusUnsubscribe;
}

interface Subscriber {
  readonly handler: (event: UiPermissionEvent) => void;
  readonly onError?: (error: unknown) => void;
}
interface CommittedState {
  readonly roots: ReadonlyMap<string, UiPermissionSnapshot>;
  readonly requests: ReadonlyMap<string, UiPermissionRequest>;
  readonly notifications: ReadonlyMap<string, UiPermissionEvent>;
  readonly ancestors: ReadonlyMap<string, readonly string[]>;
}

export function createPermissionProjection(
  options: {
    readonly permissionEpoch?: string;
    readonly now?: () => number;
  } = {},
): PermissionProjection {
  const permissionEpoch = options.permissionEpoch ?? randomUUID();
  const now = options.now ?? Date.now;
  let committed: CommittedState = {
    roots: new Map(),
    requests: new Map(),
    notifications: new Map(),
    ancestors: new Map(),
  };
  const subscribers = new Set<Subscriber>();
  const deliveryQueue: UiPermissionEvent[] = [];
  let delivering = false;
  const unavailableRoots = new Map<string, PermissionUnavailableError>();
  let runtimeFailure: PermissionUnavailableError | undefined;
  const unselected = Object.freeze({
    permissionEpoch,
    rootSessionId: null,
    permissionRevision: 0,
    requests: Object.freeze([]),
  });

  function checkHealth(root: string | null): void {
    const failure =
      runtimeFailure ??
      (root === null ? undefined : unavailableRoots.get(root));
    if (failure) throw failure;
  }

  function getSnapshot(root: string | null): UiPermissionSnapshot {
    checkHealth(root);
    if (root === null) return unselected;
    return (
      committed.roots.get(root) ??
      Object.freeze({
        permissionEpoch,
        rootSessionId: root,
        permissionRevision: 0,
        requests: Object.freeze([]),
      })
    );
  }

  function key(event: PermissionCommit): string {
    return `${event.type}:${event.type === "requested" ? event.info.id : event.identity.id}`;
  }

  function deliver(event: UiPermissionEvent): void {
    deliveryQueue.push(event);
    if (delivering) return;
    delivering = true;
    try {
      while (deliveryQueue.length > 0) {
        const next = deliveryQueue.shift();
        if (!next) break;
        for (const subscriber of [...subscribers]) {
          if (!subscribers.has(subscriber)) continue;
          try {
            subscriber.handler(next);
          } catch (error) {
            subscribers.delete(subscriber);
            try {
              subscriber.onError?.(error);
            } catch {
              /* Other subscriptions remain independent. */
            }
          }
        }
      }
    } finally {
      delivering = false;
    }
  }

  function criticalCommit(event: PermissionCommit): void {
    const identity = event.type === "requested" ? event.info : event.identity;
    checkHealth(identity.rootSessionId);
    if (
      ![
        identity.id,
        identity.rootSessionId,
        identity.sessionId,
        identity.runId,
        identity.callId,
        identity.messageId,
      ].every((value) => typeof value === "string" && value.trim().length > 0)
    ) {
      throw new Error("Invalid permission projection identity.");
    }
    const baseline = getSnapshot(identity.rootSessionId);
    const existing = committed.requests.get(identity.id);
    const requests = new Map(committed.requests);
    const ancestors = new Map(committed.ancestors);
    let rootRequests: readonly UiPermissionRequest[];
    let notification: UiPermissionEvent;
    const permissionRevision = baseline.permissionRevision + 1;
    const shared = {
      permissionEpoch,
      rootSessionId: identity.rootSessionId,
      permissionRevision,
      timestamp: now(),
    };
    if (event.type === "requested") {
      if (existing)
        throw new Error("Conflicting permission projection identity.");
      const request = toUiPermissionRequest({ info: event.info });
      requests.set(request.id, request);
      ancestors.set(
        request.id,
        Object.freeze([...identity.ancestorSessionIds]),
      );
      rootRequests = Object.freeze(
        [...baseline.requests, request].sort(
          (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
        ),
      );
      notification = Object.freeze({
        ...shared,
        type: "permission.requested",
        request,
      });
    } else {
      const originalAncestors = ancestors.get(identity.id);
      if (
        originalAncestors?.length !== identity.ancestorSessionIds.length ||
        !originalAncestors.every(
          (ancestor, index) => ancestor === identity.ancestorSessionIds[index],
        ) ||
        existing?.sessionId !== identity.sessionId ||
        existing.rootSessionId !== identity.rootSessionId ||
        existing.runId !== identity.runId ||
        existing.callId !== identity.callId ||
        existing.messageId !== identity.messageId ||
        existing.contextScopeId !== identity.contextScopeId
      ) {
        throw new Error("Conflicting or missing permission terminal identity.");
      }
      requests.delete(identity.id);
      ancestors.delete(identity.id);
      rootRequests = Object.freeze(
        baseline.requests.filter((request) => request.id !== identity.id),
      );
      notification = Object.freeze({
        ...shared,
        type: "permission.resolved",
        requestId: identity.id,
        sessionId: identity.sessionId,
        reason: event.identity.reason,
      });
    }
    const snapshot = Object.freeze({
      permissionEpoch,
      rootSessionId: identity.rootSessionId,
      permissionRevision,
      requests: rootRequests,
    });
    const roots = new Map(committed.roots);
    roots.set(identity.rootSessionId, snapshot);
    const notifications = new Map(committed.notifications);
    notifications.set(key(event), notification);
    // Nothing visible changes until every candidate object has been constructed.
    committed = { roots, requests, notifications, ancestors };
  }

  return {
    permissionEpoch,
    criticalCommit,
    notifyCommitted(event): void {
      const eventKey = key(event);
      const notification = committed.notifications.get(eventKey);
      if (!notification) return;
      const notifications = new Map(committed.notifications);
      notifications.delete(eventKey);
      committed = { ...committed, notifications };
      if (
        runtimeFailure ||
        (notification.rootSessionId !== null &&
          unavailableRoots.has(notification.rootSessionId))
      )
        return;
      deliver(notification);
    },
    markUnavailable(root, error): void {
      const failure = new PermissionUnavailableError(root, { cause: error });
      if (root === undefined) runtimeFailure = failure;
      else unavailableRoots.set(root, failure);
      deliver(
        Object.freeze({
          type: "permission.unavailable",
          permissionEpoch,
          rootSessionId: root ?? null,
          reason: failure.message,
          timestamp: now(),
        }),
      );
    },
    getSnapshot,
    listRequests: () =>
      runtimeFailure
        ? []
        : [...committed.requests.values()].filter(
            (request) => !unavailableRoots.has(request.rootSessionId),
          ),
    subscribe(handler, onError): BusUnsubscribe {
      const subscriber = { handler, onError };
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
  };
}

/** Mode and remembered rules are ordinary display state, not approval authority. */
export function startPermissionEventProjection(
  options: StartPermissionEventProjectionOptions,
): BusUnsubscribe {
  const publish = (): void => {
    options.publish({
      permission: options.currentPermissionState(),
      timestamp: (options.now ?? Date.now)(),
      type: "permission.updated",
    });
  };
  const unsubscribers = [
    options.bus.subscribe(PermissionEvent.ModeChanged, publish),
    options.bus.subscribe(PermissionEvent.LevelChanged, publish),
    options.bus.subscribe(PermissionEvent.RuleAdded, publish),
  ];
  return () => {
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  };
}
