import { Bus } from "../bus/index.js";
import { PolicyEvent } from "./events.js";
import { createPolicyManager } from "./manager.js";

export { PolicyEvent } from "./events.js";
export { createPolicyManager } from "./manager.js";
export type {
  AgentState,
  Mode,
  PolicyCheckInput,
  PolicyDecision,
  PolicyManager,
  PolicyState,
  ToolCategory,
} from "./types.js";

export const Policy = {
  Event: PolicyEvent,
  ...createPolicyManager({ bus: Bus }),
} as const;
