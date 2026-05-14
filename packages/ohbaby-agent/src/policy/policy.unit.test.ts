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

    policy.setMode("ask");
    policy.setMode("ask");
    policy.setAgentState("edit-automatically");
    policy.setAgentState("edit-automatically");

    expect(modeEvents).toEqual([
      { currentMode: "ask", previousMode: "agent" },
    ]);
    expect(agentEvents).toEqual([
      {
        currentState: "edit-automatically",
        previousState: "ask-before-edit",
      },
    ]);
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
});
