import type { UiReasoningCapabilityView } from "ohbaby-sdk";
import {
  capabilitiesFor,
  defaultReasoningEffort,
  orderedReasoningEfforts,
  type ResolveRequestReasoningOptions,
} from "../interface-providers/reasoning.js";

export function reasoningCapabilityView(
  options: ResolveRequestReasoningOptions,
  discovery?: {
    status: "detecting" | "identified" | "unknown";
    reason?: string;
  },
): UiReasoningCapabilityView {
  const { capability, source } = capabilitiesFor(options);
  if (!capability)
    return {
      status: discovery?.status === "detecting" ? "detecting" : "unknown",
      efforts: [],
      ...(discovery?.reason ? { reason: discovery.reason } : {}),
    };
  const efforts = orderedReasoningEfforts(capability);
  const effort = defaultReasoningEffort(capability);
  if (capability.mode === "effort" && effort === undefined)
    return {
      status: "unknown",
      mode: "effort",
      supportsDisabled: capability.supportsDisabled,
      efforts,
      source,
      reason: "unknown-effort-order",
    };
  return {
    status: "identified",
    mode: capability.mode,
    supportsDisabled: capability.supportsDisabled,
    efforts,
    default:
      capability.mode === "none"
        ? {}
        : { enabled: true, ...(effort === undefined ? {} : { effort }) },
    source,
    ...(discovery?.status === "unknown"
      ? { stale: true, reason: discovery.reason }
      : {}),
  };
}
