import { describe, expect, it } from "vitest";
import type { UiPermissionEvent } from "ohbaby-sdk";
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
