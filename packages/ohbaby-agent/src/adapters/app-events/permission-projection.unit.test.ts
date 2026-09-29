import { describe, expect, it } from "vitest";
import type { UiPermissionEvent } from "ohbaby-sdk";
import { createBus } from "../../bus/index.js";
import {
  createPermissionManager,
  PermissionEvent,
} from "../../permission/index.js";
import type {
  PermissionCommit,
  PermissionInfo,
} from "../../permission/index.js";
import {
  createPermissionProjection,
  startPermissionEventProjection,
  toUiPermissionRequest,
} from "./permission-projection.js";

function info(overrides: Partial<PermissionInfo> = {}): PermissionInfo {
  return {
    id: "p1",
    sessionId: "child",
    runId: "run-child",
    callId: "call-child",
    messageId: "message-child",
    rootSessionId: "root",
    ancestorSessionIds: ["root"],
    sourceLabel: "Child agent",
    title: "Edit file",
    type: "tool",
    name: "edit",
    pattern: "edit(src/**)",
    metadata: {},
    time: { created: 100 },
    ...overrides,
  };
}
function requested(overrides: Partial<PermissionInfo> = {}): PermissionCommit {
  return { type: "requested", info: info(overrides) };
}
function resolved(overrides: Partial<PermissionInfo> = {}): PermissionCommit {
  const source = info(overrides);
  return {
    type: "resolved",
    identity: {
      id: source.id,
      sessionId: source.sessionId,
      rootSessionId: source.rootSessionId,
      ancestorSessionIds: source.ancestorSessionIds,
      runId: source.runId,
      callId: source.callId,
      messageId: source.messageId,
      status: "resolved",
      reason: "once",
    },
    response: { type: "once" },
  };
}

describe("approval projection", () => {
  it("preserves real execution/source identity and offers only valid approval actions", () => {
    expect(toUiPermissionRequest({ info: info() })).toEqual({
      id: "p1",
      sessionId: "child",
      runId: "run-child",
      callId: "call-child",
      messageId: "message-child",
      rootSessionId: "root",
      sourceLabel: "Child agent",
      contextScopeId: undefined,
      createdAt: 100,
      title: "Edit file",
      description: "edit(src/**)",
      choices: [
        { id: "allow_once", label: "Allow once", intent: "allow" },
        { id: "allow_always", label: "Always allow", intent: "allow" },
        { id: "reject", label: "Reject", intent: "deny" },
      ],
    });
    expect(
      toUiPermissionRequest({
        info: info({ metadata: { rememberable: false } }),
      }).choices.map((choice) => choice.id),
    ).toEqual(["allow_once", "reject"]);
  });

  it("captures immutable per-root baselines synchronously and delivers only after commit", () => {
    const projection = createPermissionProjection({ permissionEpoch: "epoch" });
    const events: UiPermissionEvent[] = [];
    projection.subscribe((event) => {
      events.push(event);
    });
    const first = requested();
    projection.criticalCommit(first);
    const baseline = projection.getSnapshot("root");
    expect(events).toEqual([]);
    expect(baseline).toMatchObject({
      permissionEpoch: "epoch",
      rootSessionId: "root",
      permissionRevision: 1,
      requests: [{ id: "p1" }],
    });
    projection.notifyCommitted(first);
    const other = requested({
      id: "p2",
      rootSessionId: "other",
      sessionId: "other",
      ancestorSessionIds: [],
    });
    projection.criticalCommit(other);
    projection.notifyCommitted(other);
    expect(projection.getSnapshot("root")).toBe(baseline);
    const end = resolved();
    projection.criticalCommit(end);
    projection.notifyCommitted(end);
    expect(projection.getSnapshot("root")).toMatchObject({
      permissionRevision: 2,
      requests: [],
    });
    expect(baseline.requests).toHaveLength(1);
    expect(Object.isFrozen(baseline.requests)).toBe(true);
    expect(Object.isFrozen(baseline.requests[0]?.choices)).toBe(true);
    expect(
      events.map((event) =>
        event.type === "permission.unavailable" ||
        event.type === "permission.resync-required"
          ? undefined
          : event.permissionRevision,
      ),
    ).toEqual([1, 1, 2]);
    expect(events[2]).toMatchObject({
      type: "permission.resolved",
      requestId: "p1",
      sessionId: "child",
      rootSessionId: "root",
      reason: "once",
    });
    expect(projection.getSnapshot(null)).toMatchObject({
      rootSessionId: null,
      permissionRevision: 0,
      requests: [],
    });
  });

  it("does not partially commit candidate construction failures", () => {
    const projection = createPermissionProjection({ permissionEpoch: "epoch" });
    projection.criticalCommit(requested());
    const baseline = projection.getSnapshot("root");
    const broken = info({ id: "p2" });
    Object.defineProperty(broken, "title", {
      get() {
        throw new Error("candidate failed");
      },
    });
    expect(() => {
      projection.criticalCommit({ type: "requested", info: broken });
    }).toThrow("candidate failed");
    expect(projection.getSnapshot("root")).toBe(baseline);
    expect(() => {
      projection.criticalCommit(resolved({ sessionId: "wrong" }));
    }).toThrow();
    expect(projection.getSnapshot("root")).toBe(baseline);
  });

  it("rejects conflicting identities and unknown terminals before changing root revision", () => {
    const projection = createPermissionProjection();
    projection.criticalCommit(requested());
    expect(() => {
      projection.criticalCommit(requested({ rootSessionId: "other" }));
    }).toThrow();
    expect(() => {
      projection.criticalCommit(resolved({ id: "missing" }));
    }).toThrow();
    expect(projection.getSnapshot("root").permissionRevision).toBe(1);
    expect(projection.getSnapshot("other").permissionRevision).toBe(0);
  });

  it("isolates the last-event subscriber failure and notifies its error handler immediately", () => {
    const projection = createPermissionProjection();
    const errors: unknown[] = [];
    const healthy: UiPermissionEvent[] = [];
    projection.subscribe(
      (event) => {
        if (event.type === "permission.resolved")
          throw new Error("socket failed");
      },
      (error) => {
        errors.push(error);
      },
    );
    projection.subscribe((event) => {
      healthy.push(event);
    });
    const start = requested();
    projection.criticalCommit(start);
    projection.notifyCommitted(start);
    const end = resolved();
    projection.criticalCommit(end);
    projection.notifyCommitted(end);
    expect(errors).toHaveLength(1);
    expect(healthy.map((event) => event.type)).toEqual([
      "permission.requested",
      "permission.resolved",
    ]);
    expect(projection.getSnapshot("root")).toMatchObject({
      permissionRevision: 2,
      requests: [],
    });
    projection.notifyCommitted(end);
    expect(healthy).toHaveLength(2);
  });

  it("isolates unhealthy roots and exposes explicit unavailability even if notification fails", () => {
    const projection = createPermissionProjection({ permissionEpoch: "epoch" });
    projection.criticalCommit(requested());
    const errors: unknown[] = [];
    projection.subscribe(
      () => {
        throw new Error("delivery failed");
      },
      (error) => {
        errors.push(error);
      },
    );
    projection.markUnavailable("root", new Error("projection failed"));
    expect(errors).toHaveLength(1);
    expect(() => projection.getSnapshot("root")).toThrow(
      "PERMISSION_UNAVAILABLE",
    );
    expect(() => {
      projection.criticalCommit(requested({ id: "p2" }));
    }).toThrow("PERMISSION_UNAVAILABLE");
    expect(projection.getSnapshot("other").requests).toEqual([]);
    projection.markUnavailable(undefined, new Error("shared failure"));
    expect(() => projection.getSnapshot("other")).toThrow(
      "PERMISSION_UNAVAILABLE",
    );
  });

  it("connects the real manager so stored-rule fast paths never advance approval revision", async () => {
    const projection = createPermissionProjection({ permissionEpoch: "epoch" });
    let id = 0;
    const manager = createPermissionManager({
      bus: createBus(),
      generateId: () => `p${String(++id)}`,
      criticalCommit: projection.criticalCommit,
      onCommitted: projection.notifyCommitted,
      onUnavailable: projection.markUnavailable,
    });
    const ask = {
      sessionId: "child",
      runId: "run-child",
      callId: "call-child",
      messageId: "message-child",
      source: { rootSessionId: "root", ancestorSessionIds: ["root"] },
      signal: new AbortController().signal,
      category: "write" as const,
      toolName: "edit",
      params: { file_path: "src/a.ts" },
    };
    const first = manager.ask(ask);
    const second = manager.ask(ask);
    manager.respond("child", "p2", { type: "always" });
    await expect(Promise.all([first, second])).resolves.toEqual([
      "always",
      "always",
    ]);
    expect(projection.getSnapshot("root")).toMatchObject({
      permissionRevision: 4,
      requests: [],
    });
    await expect(manager.ask(ask)).resolves.toBe("always");
    expect(projection.getSnapshot("root").permissionRevision).toBe(4);
  });

  it("keeps ordinary mode and rule updates separate from authoritative approval transitions", () => {
    const bus = createBus();
    const events: unknown[] = [];
    const stop = startPermissionEventProjection({
      bus,
      currentPermissionState: () => ({
        mode: "auto",
        level: "default",
        sessionRules: [],
      }),
      publish: (event) => {
        events.push(event);
      },
    });
    bus.publish(PermissionEvent.Updated, { info: info() });
    expect(events).toEqual([]);
    bus.publish(PermissionEvent.LevelChanged, {
      previous: "default",
      current: "full-access",
    });
    expect(events).toMatchObject([{ type: "permission.updated" }]);
    stop();
    bus.publish(PermissionEvent.ModeChanged, {
      previous: "auto",
      current: "plan",
    });
    expect(events).toHaveLength(1);
  });
  it("preserves event order for every subscriber when an observer answers synchronously", async () => {
    const projection = createPermissionProjection();
    const manager = createPermissionManager({
      bus: createBus(),
      generateId: () => "p1",
      criticalCommit: projection.criticalCommit,
      onCommitted: projection.notifyCommitted,
    });
    const observed: number[] = [];
    projection.subscribe((event) => {
      if (event.type === "permission.requested")
        manager.respond("child", event.request.id, { type: "once" });
    });
    projection.subscribe((event) => {
      if (
        event.type !== "permission.unavailable" &&
        event.type !== "permission.resync-required"
      )
        observed.push(event.permissionRevision);
    });
    await expect(
      manager.ask({
        sessionId: "child",
        runId: "run",
        callId: "call",
        messageId: "message",
        source: { rootSessionId: "root", ancestorSessionIds: ["root"] },
        signal: new AbortController().signal,
        category: "write",
        toolName: "edit",
        params: { file_path: "src/a.ts" },
      }),
    ).resolves.toBe("once");
    expect(observed).toEqual([1, 2]);
  });

  it("rejects changed frozen ancestry even when the visible root and source are unchanged", () => {
    const projection = createPermissionProjection();
    projection.criticalCommit(requested());
    const baseline = projection.getSnapshot("root");
    expect(() => {
      projection.criticalCommit(
        resolved({ ancestorSessionIds: ["different", "root"] }),
      );
    }).toThrow();
    expect(projection.getSnapshot("root")).toBe(baseline);
  });
});
