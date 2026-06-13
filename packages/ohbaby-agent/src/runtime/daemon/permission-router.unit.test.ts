import { describe, expect, it } from "vitest";
import type { UiEvent, UiSnapshot } from "ohbaby-sdk";
import { PermissionRouter } from "./permission-router.js";

const timestamp = "2026-06-12T00:00:00.000Z";

function runUpdated(runId: string, sessionId = "session_1"): UiEvent {
  return {
    run: {
      id: runId,
      sessionId,
      startedAt: timestamp,
      status: { kind: "running", runId },
      updatedAt: timestamp,
    },
    type: "run.updated",
  };
}

function permissionRequested(runId: string): Extract<
  UiEvent,
  { type: "permission.requested" }
> {
  return {
    request: {
      choices: [{ id: "allow", intent: "allow", label: "Allow" }],
      description: "Allow tool",
      id: `permission_${runId}`,
      runId,
      title: "Tool permission",
    },
    type: "permission.requested",
  };
}

function permissionResolved(requestId: string): Extract<
  UiEvent,
  { type: "permission.resolved" }
> {
  return {
    requestId,
    type: "permission.resolved",
  };
}

function snapshotWithPermission(runId: string): UiSnapshot {
  return {
    activeSessionId: "session_1",
    permission: {
      level: "default",
      mode: "auto",
      sessionRules: [],
    },
    permissions: [permissionRequested(runId).request],
    runs: [
      {
        id: runId,
        sessionId: "session_1",
        startedAt: timestamp,
        status: { kind: "waiting-for-permission", requestId: `permission_${runId}` },
        updatedAt: timestamp,
      },
    ],
    sessions: [
      {
        createdAt: timestamp,
        id: "session_1",
        messages: [],
        title: "Session",
        updatedAt: timestamp,
      },
    ],
    status: { kind: "waiting-for-permission", requestId: `permission_${runId}` },
  };
}

describe("PermissionRouter", () => {
  it("maps a run to the client that started the prompt", () => {
    const router = new PermissionRouter();
    const release = router.trackPromptClient("client_a");

    router.observeEvent(runUpdated("run_1"));
    release();

    const event = permissionRequested("run_1");
    expect(router.filterEventForClient(event, "client_a")).toEqual(event);
    expect(router.filterEventForClient(event, "client_b")).toBeNull();
  });

  it("maps overlapping prompt windows by target session before using recency", () => {
    const router = new PermissionRouter();
    const releaseFirst = router.trackPromptClient("client_a", "session_a");
    const releaseSecond = router.trackPromptClient("client_b", "session_b");

    router.observeEvent(runUpdated("run_a", "session_a"));

    releaseFirst();
    releaseSecond();

    const event = permissionRequested("run_a");
    expect(router.filterEventForClient(event, "client_a")).toEqual(event);
    expect(router.filterEventForClient(event, "client_b")).toBeNull();
  });

  it("delivers unknown permission requests to all clients to avoid deadlock", () => {
    const router = new PermissionRouter();
    const event = permissionRequested("run_unknown");

    expect(router.filterEventForClient(event, "client_a")).toEqual(event);
    expect(router.filterEventForClient(event, "client_b")).toEqual(event);
  });

  it("keeps permission resolution events visible to every client", () => {
    const router = new PermissionRouter();
    const release = router.trackPromptClient("client_a");
    router.observeEvent(runUpdated("run_1"));
    release();

    const event = permissionResolved("permission_run_1");
    expect(router.filterEventForClient(event, "client_a")).toEqual(event);
    expect(router.filterEventForClient(event, "client_b")).toEqual(event);
  });

  it("authorizes permission responses only for the owning client", () => {
    const router = new PermissionRouter();
    const release = router.trackPromptClient("client_a", "session_1");
    router.observeEvent(runUpdated("run_1", "session_1"));
    router.observeEvent(permissionRequested("run_1"));
    release();

    expect(router.canRespondPermission("permission_run_1", "client_a")).toBe(
      true,
    );
    expect(router.canRespondPermission("permission_run_1", "client_b")).toBe(
      false,
    );
  });

  it("allows all clients to respond to unknown-owner permissions", () => {
    const router = new PermissionRouter();

    expect(router.canRespondPermission("permission_unknown", "client_a")).toBe(
      true,
    );
    expect(router.canRespondPermission("permission_unknown", "client_b")).toBe(
      true,
    );
  });

  it("filters snapshot permissions for observing clients without mutating the snapshot", () => {
    const router = new PermissionRouter();
    const release = router.trackPromptClient("client_a");
    router.observeEvent(runUpdated("run_1"));
    release();
    const snapshot = snapshotWithPermission("run_1");

    const ownerSnapshot = router.filterSnapshotForClient(snapshot, "client_a");
    const observerSnapshot = router.filterSnapshotForClient(snapshot, "client_b");

    expect(ownerSnapshot.permissions).toHaveLength(1);
    expect(observerSnapshot.permissions).toEqual([]);
    expect(observerSnapshot.runs).toEqual(snapshot.runs);
    expect(observerSnapshot.sessions).toEqual(snapshot.sessions);
    expect(snapshot.permissions).toHaveLength(1);
  });
});
