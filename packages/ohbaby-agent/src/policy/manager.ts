import { Bus, type BusInstance } from "../bus/index.js";
import type {
  AgentState,
  Mode,
  PolicyCheckInput,
  PolicyDecision,
  PolicyManager,
  PolicyState,
  ToolCategory,
} from "./types.js";
import { PolicyEvent } from "./events.js";

const MODE_CYCLE: readonly Mode[] = ["agent", "ask", "plan"];
const AGENT_STATES = new Set<string>([
  "ask-before-edit",
  "edit-automatically",
]);
const VALID_CATEGORIES = new Set<ToolCategory>([
  "readonly",
  "write",
  "dangerous",
  "network",
  "memory",
  "skill",
  "subagent",
]);

export interface PolicyManagerOptions {
  readonly bus?: BusInstance;
}

function allow(): PolicyDecision {
  return { type: "allow" };
}

function ask(reason?: string): PolicyDecision {
  return reason ? { reason, type: "ask" } : { type: "ask" };
}

function deny(reason?: string): PolicyDecision {
  return reason ? { reason, type: "deny" } : { type: "deny" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAlwaysAllowed(category: ToolCategory): boolean {
  return (
    category === "readonly" ||
    category === "network" ||
    category === "memory" ||
    category === "skill"
  );
}

function isKnownCategory(category: ToolCategory): boolean {
  return VALID_CATEGORIES.has(category);
}

function isMode(value: string): value is Mode {
  return MODE_CYCLE.includes(value as Mode);
}

function isAgentState(value: string): value is AgentState {
  return AGENT_STATES.has(value);
}

function isPolicyCheckInput(value: unknown): value is PolicyCheckInput {
  return (
    isRecord(value) &&
    typeof value.toolName === "string" &&
    typeof value.callId === "string" &&
    typeof value.category === "string" &&
    isRecord(value.params) &&
    typeof value.sessionId === "string" &&
    typeof value.messageId === "string"
  );
}

export function createPolicyManager(
  options: PolicyManagerOptions = {},
): PolicyManager {
  const bus = options.bus ?? Bus;
  let mode: Mode = "agent";
  let agentState: AgentState = "ask-before-edit";

  function setAgentState(nextState: AgentState): void {
    if (!isAgentState(nextState) || agentState === nextState) {
      return;
    }
    if (nextState === "edit-automatically" && mode !== "agent") {
      return;
    }
    const previousState = agentState;
    agentState = nextState;
    bus.publish(PolicyEvent.AgentStateChanged, {
      previousState,
      currentState: agentState,
    });
  }

  function resetAgentState(): void {
    setAgentState("ask-before-edit");
  }

  function getMode(): Mode {
    return mode;
  }

  function setMode(nextMode: Mode): void {
    if (!isMode(nextMode) || mode === nextMode) {
      return;
    }
    const previousMode = mode;
    mode = nextMode;
    resetAgentState();
    bus.publish(PolicyEvent.ModeChanged, {
      previousMode,
      currentMode: mode,
    });
  }

  function cycleMode(): Mode {
    const currentIndex = MODE_CYCLE.indexOf(mode);
    const nextMode = MODE_CYCLE[(currentIndex + 1) % MODE_CYCLE.length];
    setMode(nextMode);
    return mode;
  }

  function getAgentState(): AgentState {
    return agentState;
  }

  function toggleAgentState(): AgentState {
    setAgentState(
      agentState === "ask-before-edit"
        ? "edit-automatically"
        : "ask-before-edit",
    );
    return agentState;
  }

  function getState(): PolicyState {
    return { agentState, mode };
  }

  function check(input: PolicyCheckInput): PolicyDecision {
    if (!isPolicyCheckInput(input)) {
      return deny("Malformed policy input");
    }
    const { category } = input;
    if (!isKnownCategory(category)) {
      return deny(`Unknown tool category: ${category}`);
    }
    if (isAlwaysAllowed(category)) {
      return allow();
    }
    if (mode === "ask" || mode === "plan") {
      return deny(`Tool category ${category} is not allowed in ${mode} mode`);
    }
    if (category === "subagent") {
      return allow();
    }
    if (category === "dangerous") {
      return ask(`Dangerous tool requires confirmation: ${input.toolName}`);
    }
    if (category === "write") {
      return agentState === "edit-automatically"
        ? allow()
        : ask(`Write tool requires confirmation: ${input.toolName}`);
    }

    return deny(`Tool category ${category} is not allowed`);
  }

  return {
    check,
    cycleMode,
    getAgentState,
    getMode,
    getState,
    setAgentState,
    setMode,
    toggleAgentState,
  };
}
