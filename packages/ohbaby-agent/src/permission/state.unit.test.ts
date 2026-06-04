import { describe, expect, it } from "vitest";
import { createBus } from "../bus/index.js";
import { PermissionEvent } from "./events.js";
import { createPermissionState } from "./state.js";
import type { PermissionRule } from "./types.js";

function allowEditRule(pattern = "src/**"): PermissionRule {
  return {
    decision: "allow",
    pattern,
    scope: "session",
    tool: "edit",
  };
}

describe("PermissionState", () => {
  it("starts in auto/default with no session rules", () => {
    const state = createPermissionState({ bus: createBus() });

    expect(state.getMode()).toBe("auto");
    expect(state.getLevel()).toBe("default");
    expect(state.getState().sessionRules.size).toBe(0);
  });

  it("publishes mode and level changes without coupling the two axes", () => {
    const bus = createBus();
    const state = createPermissionState({ bus });
    const modeEvents: unknown[] = [];
    const levelEvents: unknown[] = [];

    bus.subscribe(PermissionEvent.ModeChanged, (event) => {
      modeEvents.push(event);
    });
    bus.subscribe(PermissionEvent.LevelChanged, (event) => {
      levelEvents.push(event);
    });

    state.setMode("plan");
    state.setMode("plan");
    state.setLevel("full-access");
    state.setLevel("full-access");

    expect(state.getMode()).toBe("plan");
    expect(state.getLevel()).toBe("full-access");
    expect(modeEvents).toEqual([{ current: "plan", previous: "auto" }]);
    expect(levelEvents).toEqual([
      { current: "full-access", previous: "default" },
    ]);

    state.setMode("auto");
    expect(state.getLevel()).toBe("full-access");
    state.setLevel("default");
    expect(state.getMode()).toBe("auto");
  });

  it("toggles only between plan and auto", () => {
    const state = createPermissionState({ bus: createBus() });

    expect(state.toggleMode()).toBe("plan");
    expect(state.toggleMode()).toBe("auto");
  });

  it("stores session rules by session id and clears only the target session", () => {
    const bus = createBus();
    const state = createPermissionState({ bus });
    const ruleEvents: unknown[] = [];
    const sessionA = allowEditRule("src/**");
    const sessionB = allowEditRule("docs/**");

    bus.subscribe(PermissionEvent.RuleAdded, (event) => {
      ruleEvents.push(event);
    });

    state.addSessionRule("session_a", sessionA);
    state.addSessionRule("session_b", sessionB);

    expect(state.getSessionRules("session_a")).toEqual([sessionA]);
    expect(state.getSessionRules("session_b")).toEqual([sessionB]);
    expect(ruleEvents).toEqual([
      { rule: sessionA, sessionId: "session_a" },
      { rule: sessionB, sessionId: "session_b" },
    ]);

    state.clearSession("session_a");

    expect(state.getSessionRules("session_a")).toEqual([]);
    expect(state.getSessionRules("session_b")).toEqual([sessionB]);
  });

  it("serializes snapshot state without exposing a Map", () => {
    const state = createPermissionState({ bus: createBus() });
    const rule = allowEditRule();
    state.setMode("plan");
    state.setLevel("full-access");
    state.addSessionRule("session_1", rule);

    expect(state.toSnapshot()).toEqual({
      level: "full-access",
      mode: "plan",
      sessionRules: [{ rules: [rule], sessionId: "session_1" }],
    });
  });
});
