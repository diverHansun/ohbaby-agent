import { describe, expect, it } from "vitest";
import type { UiPermissionEvent, UiPermissionUpdatedEvent } from "ohbaby-sdk";
import { PermissionRouter } from "./permission-router.js";

describe("PermissionRouter", () => {
  it("routes resolved events using frozen root after the pending request was removed", () => {
    const router = new PermissionRouter();
    const event: UiPermissionEvent = {
      type: "permission.resolved",
      permissionEpoch: "epoch",
      rootSessionId: "root",
      permissionRevision: 2,
      requestId: "request",
      sessionId: "child",
      reason: "once",
    };
    expect(router.filterEventForClient(event, "root")).toBe(event);
    expect(router.filterEventForClient(event, "other")).toBeNull();
    expect(router.filterEventForClient(event, null)).toBeNull();
  });
  it("keeps side-chat rules private on rule changes and global mode updates", () => {
    const router = new PermissionRouter();
    const update: UiPermissionUpdatedEvent = {
      type: "permission.updated",
      permission: {
        mode: "plan",
        level: "default",
        sessionRules: [
          {
            sessionId: "side",
            rules: [
              {
                tool: "bash",
                pattern: "side-only",
                scope: "session",
                decision: "allow",
              },
            ],
          },
        ],
      },
    };
    const remembered = { ...update, sessionId: "side" };
    expect(router.filterEventForClient(remembered, "side")).toEqual(remembered);
    for (const other of ["main", null]) {
      expect(router.filterEventForClient(remembered, other)).toBeNull();
      expect(
        router.filterEventForClient(
          { ...update, previousPermission: update.permission },
          other,
        ),
      ).toMatchObject({
        permission: { mode: "plan", sessionRules: [] },
        previousPermission: { sessionRules: [] },
      });
    }
  });
  it("limits root failures while delivering a runtime failure to every binding", () => {
    const router = new PermissionRouter();
    const event: UiPermissionEvent = {
      type: "permission.unavailable",
      permissionEpoch: "epoch",
      rootSessionId: "root",
      reason: "unavailable",
    };
    expect(router.filterEventForClient(event, "other")).toBeNull();
    expect(
      router.filterEventForClient({ ...event, rootSessionId: null }, "other"),
    ).not.toBeNull();
  });
});
