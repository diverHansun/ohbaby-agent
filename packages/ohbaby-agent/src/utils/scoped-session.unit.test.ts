import { describe, expect, it } from "vitest";
import {
  isScopedSessionKeyForSession,
  scopedSessionKey,
} from "./scoped-session.js";

describe("scopedSessionKey", () => {
  it("keeps ordinary session and scope keys readable", () => {
    expect(scopedSessionKey({ sessionId: "child_1" })).toBe("child_1");
    expect(
      scopedSessionKey({
        contextScopeId: "subagent_1",
        sessionId: "child_1",
      }),
    ).toBe("child_1::subagent_1");
  });

  it("encodes parts so a scope cannot collide with a session delimiter", () => {
    const key = scopedSessionKey({
      contextScopeId: "scope::a%",
      sessionId: "child::1%",
    });

    expect(key).toBe("child%3A%3A1%25::scope%3A%3Aa%25");
    expect(isScopedSessionKeyForSession(key, "child::1%")).toBe(true);
    expect(isScopedSessionKeyForSession(key, "child")).toBe(false);
  });
});
