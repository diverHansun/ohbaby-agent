import { describe, expect, it } from "vitest";
import { createBus } from "../bus/index.js";
import { createPolicyManager, PolicyEvent } from "./index.js";
import type { PolicyCheckInput, PolicyDecision, ToolCategory } from "./index.js";

function checkInput(category: ToolCategory): PolicyCheckInput {
  return {
    category,
    messageId: "message_1",
    params: {},
    sessionId: "session_1",
    toolName: `${category}_tool`,
  };
}

function decisionType(decision: PolicyDecision): PolicyDecision["type"] {
  return decision.type;
}

describe("PolicyManager", () => {
  it("starts in agent mode with ask-before-edit state", () => {
    const policy = createPolicyManager({ bus: createBus() });

    expect(policy.getState()).toEqual({
      agentState: "ask-before-edit",
      mode: "agent",
    });
  });

  it("cycles Agent to Ask to Plan to Agent and resets agent state", () => {
    const policy = createPolicyManager({ bus: createBus() });

    policy.setAgentState("edit-automatically");

    expect(policy.cycleMode()).toBe("ask");
    expect(policy.getState()).toEqual({
      agentState: "ask-before-edit",
      mode: "ask",
    });
    expect(policy.cycleMode()).toBe("plan");
    expect(policy.cycleMode()).toBe("agent");
  });

  it("publishes mode and agent-state events only when state changes", () => {
    const bus = createBus();
    const policy = createPolicyManager({ bus });
    const modeEvents: unknown[] = [];
    const agentEvents: unknown[] = [];

    bus.subscribe(PolicyEvent.ModeChanged, (event) => {
      modeEvents.push(event);
    });
    bus.subscribe(PolicyEvent.AgentStateChanged, (event) => {
      agentEvents.push(event);
    });

    policy.setAgentState("edit-automatically");
    policy.setAgentState("edit-automatically");
    policy.setMode("ask");
    policy.setMode("ask");

    expect(modeEvents).toEqual([
      { currentMode: "ask", previousMode: "agent" },
    ]);
    expect(agentEvents).toEqual([
      {
        currentState: "edit-automatically",
        previousState: "ask-before-edit",
      },
      {
        currentState: "ask-before-edit",
        previousState: "edit-automatically",
      },
    ]);
  });

  it("publishes an agent-state event when mode changes reset auto-edit state", () => {
    const bus = createBus();
    const policy = createPolicyManager({ bus });
    const agentEvents: unknown[] = [];

    bus.subscribe(PolicyEvent.AgentStateChanged, (event) => {
      agentEvents.push(event);
    });

    policy.setAgentState("edit-automatically");
    policy.setMode("ask");

    expect(policy.getState()).toEqual({
      agentState: "ask-before-edit",
      mode: "ask",
    });
    expect(agentEvents).toEqual([
      {
        currentState: "edit-automatically",
        previousState: "ask-before-edit",
      },
      {
        currentState: "ask-before-edit",
        previousState: "edit-automatically",
      },
    ]);
  });

  it("ignores invalid runtime mode and agent-state values", () => {
    const bus = createBus();
    const policy = createPolicyManager({ bus });
    const setRuntimeMode = policy.setMode as (mode: string) => void;
    const setRuntimeAgentState = policy.setAgentState as (state: string) => void;
    const modeEvents: unknown[] = [];
    const agentEvents: unknown[] = [];

    bus.subscribe(PolicyEvent.ModeChanged, (event) => {
      modeEvents.push(event);
    });
    bus.subscribe(PolicyEvent.AgentStateChanged, (event) => {
      agentEvents.push(event);
    });

    expect(() => {
      setRuntimeMode("invalid");
      setRuntimeAgentState("invalid");
    }).not.toThrow();

    expect(policy.getState()).toEqual({
      agentState: "ask-before-edit",
      mode: "agent",
    });
    expect(modeEvents).toEqual([]);
    expect(agentEvents).toEqual([]);
  });

  it("keeps command-facing methods usable when passed as callbacks", () => {
    const policy = createPolicyManager({ bus: createBus() });
    const cycleMode = policy.cycleMode;
    const toggleAgentState = policy.toggleAgentState;

    expect(toggleAgentState()).toBe("edit-automatically");
    expect(cycleMode()).toBe("ask");
  });

  it("keeps ask and plan modes out of automatic edit state", () => {
    const bus = createBus();
    const policy = createPolicyManager({ bus });
    const agentEvents: unknown[] = [];

    policy.setMode("ask");
    bus.subscribe(PolicyEvent.AgentStateChanged, (event) => {
      agentEvents.push(event);
    });

    policy.setAgentState("edit-automatically");
    expect(policy.getState()).toEqual({
      agentState: "ask-before-edit",
      mode: "ask",
    });
    expect(policy.toggleAgentState()).toBe("ask-before-edit");

    policy.setMode("plan");
    policy.setAgentState("edit-automatically");
    expect(policy.getState()).toEqual({
      agentState: "ask-before-edit",
      mode: "plan",
    });
    expect(agentEvents).toEqual([]);
  });

  it("applies the ask and plan readonly-only decision matrix", () => {
    const policy = createPolicyManager({ bus: createBus() });

    policy.setMode("ask");
    expect(decisionType(policy.check(checkInput("readonly")))).toBe("allow");
    expect(decisionType(policy.check(checkInput("network")))).toBe("allow");
    expect(decisionType(policy.check(checkInput("memory")))).toBe("allow");
    expect(decisionType(policy.check(checkInput("skill")))).toBe("allow");
    expect(decisionType(policy.check(checkInput("write")))).toBe("deny");
    expect(decisionType(policy.check(checkInput("dangerous")))).toBe("deny");
    expect(decisionType(policy.check(checkInput("subagent")))).toBe("deny");

    policy.setMode("plan");
    expect(decisionType(policy.check(checkInput("readonly")))).toBe("allow");
    expect(decisionType(policy.check(checkInput("write")))).toBe("deny");
    expect(decisionType(policy.check(checkInput("dangerous")))).toBe("deny");
  });

  it("asks before edits in agent mode, then allows writes after automatic edit state", () => {
    const policy = createPolicyManager({ bus: createBus() });

    expect(decisionType(policy.check(checkInput("readonly")))).toBe("allow");
    expect(decisionType(policy.check(checkInput("write")))).toBe("ask");
    expect(decisionType(policy.check(checkInput("dangerous")))).toBe("ask");
    expect(decisionType(policy.check(checkInput("subagent")))).toBe("allow");

    policy.setAgentState("edit-automatically");

    expect(decisionType(policy.check(checkInput("write")))).toBe("allow");
    expect(decisionType(policy.check(checkInput("dangerous")))).toBe("ask");
  });

  it("denies unknown categories conservatively", () => {
    const policy = createPolicyManager({ bus: createBus() });

    expect(
      decisionType(
        policy.check(checkInput("unknown" as unknown as ToolCategory)),
      ),
    ).toBe("deny");
  });

  it("denies malformed runtime check input without throwing", () => {
    const policy = createPolicyManager({ bus: createBus() });
    const runtimeCheck = policy.check as (input: unknown) => PolicyDecision;

    expect(runtimeCheck(null).type).toBe("deny");
    expect(runtimeCheck(undefined).type).toBe("deny");
    expect(runtimeCheck({ category: "write" }).type).toBe("deny");
  });
});
