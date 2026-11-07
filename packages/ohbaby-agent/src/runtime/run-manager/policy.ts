import { RunDefaultsPolicyError } from "./errors.js";
import type { RunDefaults, RunDefaultsPolicy, TriggerSource } from "./types.js";

const interactive: RunDefaults = {
  permissionProfileId: "interactive",
  multitaskStrategy: "reject",
  disconnectMode: "continue",
};

export const DEFAULT_RUN_POLICY: RunDefaultsPolicy = {
  defaults: { user: interactive, goal: interactive, subagent: interactive },
};

export function mergeRunDefaults(
  policy: RunDefaultsPolicy,
  triggerSource: TriggerSource,
  explicit: Partial<RunDefaults> = {},
): RunDefaults {
  if (!Object.hasOwn(policy.defaults, triggerSource)) {
    throw new RunDefaultsPolicyError(triggerSource);
  }

  return {
    ...policy.defaults[triggerSource],
    ...explicit,
  };
}
