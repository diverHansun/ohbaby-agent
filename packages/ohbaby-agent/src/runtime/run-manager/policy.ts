import { RunDefaultsPolicyError } from "./errors.js";
import type { RunDefaults, RunDefaultsPolicy, TriggerSource } from "./types.js";

export function mergeRunDefaults(
  policy: RunDefaultsPolicy,
  triggerSource: TriggerSource,
  explicit: Partial<RunDefaults> = {},
): RunDefaults {
  const defaults = policy.defaults[triggerSource];
  if (!defaults) {
    throw new RunDefaultsPolicyError(triggerSource);
  }

  return {
    ...defaults,
    ...explicit,
  };
}
