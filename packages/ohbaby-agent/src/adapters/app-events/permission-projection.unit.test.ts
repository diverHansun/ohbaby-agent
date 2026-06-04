import { describe, expect, it, vi, type Mock } from "vitest";
import type { UiEvent, UiPermissionRequest, UiRunStatus } from "ohbaby-sdk";
import { createBus } from "../../bus/index.js";
import { PermissionEvent, type PermissionInfo } from "../../permission/index.js";
import { startPermissionEventProjection } from "./permission-projection.js";

interface PermissionProjectionHarness {
  readonly asyncErrors: unknown[];
  readonly bus: ReturnType<typeof createBus>;
  readonly events: UiEvent[];
  readonly pendingPermissionSessions: Map<string, string>;
  readonly reconcileRuntimeStatus: Mock<() => Promise<UiRunStatus>>;
  readonly stateStore: {
    readonly upsertPermission: Mock<
      (request: UiPermissionRequest) => Promise<void>
    >;
    readonly removePermission: Mock<(requestId: string) => Promise<void>>;
  };
}

function createPermissionInfo(
  overrides: Partial<PermissionInfo> = {},
): PermissionInfo {
  return {
    callId: "call_1",
    id: "perm_1",
    messageId: "message_1",
    metadata: {},
    name: "shell",
    pattern: "bash:echo hello",
    sessionId: "session_1",
    time: { created: 100 },
    title: "Run shell command",
    type: "bash",
    ...overrides,
  };
}

function createHarness(options: {
  readonly activeRunId?: string;
  readonly currentStatus?: UiRunStatus;
  readonly upsertPermission?: (request: UiPermissionRequest) => Promise<void>;
  readonly removePermission?: (requestId: string) => Promise<void>;
} = {}): PermissionProjectionHarness {
  const bus = createBus();
  const events: UiEvent[] = [];
  const pendingPermissionSessions = new Map<string, string>();
  const runtimeStatus: UiRunStatus = options.currentStatus ?? { kind: "idle" };
  const reconcileRuntimeStatus = vi.fn((): Promise<UiRunStatus> => {
    return Promise.resolve(runtimeStatus);
  });
  const stateStore = {
    upsertPermission: vi.fn((request: UiPermissionRequest): Promise<void> => {
      return options.upsertPermission?.(request) ?? Promise.resolve();
    }),
    removePermission: vi.fn((requestId: string): Promise<void> => {
      return options.removePermission?.(requestId) ?? Promise.resolve();
    }),
  };
  const asyncErrors: unknown[] = [];

  startPermissionEventProjection({
    bus,
    currentPermissionState: () => ({
      level: "default",
      mode: "auto",
      sessionRules: [
        {
          rules: [
            {
              decision: "allow",
              pattern: "bash:*",
              scope: "session",
              tool: "bash",
            },
          ],
          sessionId: "session_1",
        },
      ],
    }),
    getActiveRunId: () => options.activeRunId,
    now: () => 1234,
    onAsyncError: (error) => {
      asyncErrors.push(error);
    },
    pendingPermissionSessions,
    publish: (event) => {
      events.push(event);
    },
    reconcileRuntimeStatus,
    stateStore,
  });

  return {
    asyncErrors,
    bus,
    events,
    pendingPermissionSessions,
    reconcileRuntimeStatus,
    stateStore,
  };
}

async function flushAsyncProjection(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("startPermissionEventProjection", () => {
  it("publishes permission.updated for mode, level, and rule changes", () => {
    const { bus, events } = createHarness();

    bus.publish(PermissionEvent.ModeChanged, {
      current: "plan",
      previous: "auto",
    });
    bus.publish(PermissionEvent.LevelChanged, {
      current: "full-access",
      previous: "default",
    });
    bus.publish(PermissionEvent.RuleAdded, {
      rule: {
        decision: "allow",
        pattern: "bash:*",
        scope: "session",
        tool: "bash",
      },
      sessionId: "session_1",
    });

    expect(events).toEqual([
      {
        permission: {
          level: "default",
          mode: "auto",
          sessionRules: [
            {
              rules: [
                {
                  decision: "allow",
                  pattern: "bash:*",
                  scope: "session",
                  tool: "bash",
                },
              ],
              sessionId: "session_1",
            },
          ],
        },
        timestamp: 1234,
        type: "permission.updated",
      },
      {
        permission: {
          level: "default",
          mode: "auto",
          sessionRules: [
            {
              rules: [
                {
                  decision: "allow",
                  pattern: "bash:*",
                  scope: "session",
                  tool: "bash",
                },
              ],
              sessionId: "session_1",
            },
          ],
        },
        timestamp: 1234,
        type: "permission.updated",
      },
      {
        permission: {
          level: "default",
          mode: "auto",
          sessionRules: [
            {
              rules: [
                {
                  decision: "allow",
                  pattern: "bash:*",
                  scope: "session",
                  tool: "bash",
                },
              ],
              sessionId: "session_1",
            },
          ],
        },
        timestamp: 1234,
        type: "permission.updated",
      },
    ]);
  });

  it("projects PermissionEvent.Updated into permission.requested state and runtime updates", async () => {
    const { bus, events, pendingPermissionSessions, reconcileRuntimeStatus, stateStore } =
      createHarness({ activeRunId: "run_1" });
    const info = createPermissionInfo({ id: "perm_2", sessionId: "session_2" });

    bus.publish(PermissionEvent.Updated, { info });
    await flushAsyncProjection();

    const request: UiPermissionRequest = {
      choices: [
        { id: "allow_once", intent: "allow", label: "Allow once" },
        { id: "reject", intent: "deny", label: "Reject" },
        { id: "cancel", intent: "abort", label: "Cancel run" },
      ],
      description: "bash:echo hello",
      id: "perm_2",
      runId: "run_1",
      title: "Run shell command",
    };
    expect(pendingPermissionSessions.get("perm_2")).toBe("session_2");
    expect(stateStore.upsertPermission).toHaveBeenCalledWith(request);
    expect(reconcileRuntimeStatus).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      {
        request,
        timestamp: 1234,
        type: "permission.requested",
      },
    ]);
  });

  it("keeps the legacy no-active-run callId fallback only as the request runId", async () => {
    const { bus, events, pendingPermissionSessions } = createHarness();
    const info = createPermissionInfo({
      callId: "call_legacy",
      id: "perm_legacy",
      sessionId: "session_real",
    });

    bus.publish(PermissionEvent.Updated, { info });
    await flushAsyncProjection();

    expect(
      events.find((event) => event.type === "permission.requested"),
    ).toMatchObject({
      request: {
        id: "perm_legacy",
        runId: "call_legacy",
      },
      type: "permission.requested",
    });
    expect(pendingPermissionSessions.get("perm_legacy")).toBe("session_real");
    expect(pendingPermissionSessions.has("call_legacy")).toBe(false);
  });

  it("projects PermissionEvent.Replied into permission.resolved state and runtime updates", async () => {
    const { bus, events, pendingPermissionSessions, reconcileRuntimeStatus, stateStore } =
      createHarness();
    pendingPermissionSessions.set("perm_1", "session_1");

    bus.publish(PermissionEvent.Replied, {
      callId: "call_1",
      permissionId: "perm_1",
      response: { type: "once" },
      sessionId: "session_1",
    });
    await flushAsyncProjection();

    expect(pendingPermissionSessions.has("perm_1")).toBe(false);
    expect(stateStore.removePermission).toHaveBeenCalledWith("perm_1");
    expect(events).toEqual([
      {
        requestId: "perm_1",
        timestamp: 1234,
        type: "permission.resolved",
      },
    ]);
    expect(reconcileRuntimeStatus).toHaveBeenCalledTimes(1);
  });

  it("passes asynchronous projection errors to onAsyncError", async () => {
    const error = new Error("store failed");
    const { asyncErrors, bus, events } = createHarness({
      upsertPermission: vi.fn(() => Promise.reject(error)),
    });

    bus.publish(PermissionEvent.Updated, { info: createPermissionInfo() });
    await flushAsyncProjection();

    expect(asyncErrors).toEqual([error]);
    expect(events).toEqual([]);
  });
});
