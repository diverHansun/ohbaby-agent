import { describe, expect, it } from "vitest";
import { resolveStartupSession } from "./ui-startup-session.js";
import type { StartupSessionCandidate } from "./ui-startup-session.js";

function candidate(
  id: string,
  updatedAt: number,
  kind: StartupSessionCandidate["kind"] = "primary",
): StartupSessionCandidate {
  return {
    id,
    kind,
    updatedAt,
  };
}

describe("resolveStartupSession", () => {
  it("returns null for fresh startup even when sessions exist", () => {
    expect(
      resolveStartupSession(
        { type: "fresh" },
        [candidate("session_recent", 2_000), candidate("session_old", 1_000)],
      ),
    ).toBeNull();
  });

  it("returns the explicit resume session id for resume startup", () => {
    expect(
      resolveStartupSession(
        { type: "resume", sessionId: "session_requested" },
        [candidate("session_recent", 2_000)],
      ),
    ).toBe("session_requested");
  });

  it("returns the latest primary session id for continue startup", () => {
    expect(
      resolveStartupSession(
        { type: "continue" },
        [
          candidate("session_temporary_newer", 3_000, "temporary"),
          candidate("session_primary_newer", 2_000),
          candidate("session_primary_older", 1_000),
        ],
      ),
    ).toBe("session_primary_newer");
  });

  it("returns null for continue startup when no primary session exists", () => {
    expect(
      resolveStartupSession(
        { type: "continue" },
        [candidate("session_temporary", 1_000, "temporary")],
      ),
    ).toBeNull();
  });
});
