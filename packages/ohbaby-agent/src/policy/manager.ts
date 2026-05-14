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

export function createPolicyManager(
  options: PolicyManagerOptions = {},
): PolicyManager {
  const bus = options.bus ?? Bus;
  let mode: Mode = "agent";
  let agentState: AgentState = "ask-before-edit";

  function resetAgentState(): void {
    agentState = "ask-before-edit";
  }

  return {
    getMode(): Mode {
      return mode;
    },

    setMode(nextMode: Mode): void {
      if (mode === nextMode) {
        return;
      }
      const previousMode = mode;
      mode = nextMode;
      resetAgentState();
      bus.publish(PolicyEvent.ModeChanged, {
        previousMode,
        currentMode: mode,
      });
    },

    cycleMode(): Mode {
      const currentIndex = MODE_CYCLE.indexOf(mode);
      const nextMode = MODE_CYCLE[(currentIndex + 1) % MODE_CYCLE.length];
      this.setMode(nextMode);
      return mode;
    },

    getAgentState(): AgentState {
      return agentState;
    },

    setAgentState(nextState: AgentState): void {
      if (agentState === nextState) {
        return;
      }
      const previousState = agentState;
      agentState = nextState;
      bus.publish(PolicyEvent.AgentStateChanged, {
        previousState,
        currentState: agentState,
      });
    },

    toggleAgentState(): AgentState {
      this.setAgentState(
        agentState === "ask-before-edit"
          ? "edit-automatically"
          : "ask-before-edit",
      );
      return agentState;
    },

    getState(): PolicyState {
      return { agentState, mode };
    },

    check(input: PolicyCheckInput): PolicyDecision {
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
    },
  };
}
