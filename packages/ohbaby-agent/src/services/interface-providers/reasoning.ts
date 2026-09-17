import type { UiReasoningCapabilityView } from "ohbaby-sdk";
import { normalizedEndpoint } from "../../config/llm/model-profile.js";
import {
  ConfigError,
  type InterfaceProviderKind,
  type ModelJsonModelProfile,
  type ReasoningCapabilities,
  type ReasoningConfig,
} from "../../config/llm/types.js";
import {
  validateReasoningCapabilities,
  validateReasoningConfig,
} from "../../config/llm/validation.js";

/** Internal provenance survives inheritance; it is never a persisted user field. */
export interface ReasoningIntent {
  readonly enabled: boolean;
  readonly effort: string;
  readonly explicit: { readonly enabled: boolean; readonly effort: boolean };
}
export interface ResolvedReasoning {
  readonly intent: ReasoningIntent;
  readonly mode: "none" | "disabled" | "binary" | "effort" | "service-default";
  readonly wire: ReasoningCapabilities["wire"];
  readonly effort?: string;
  readonly budgetTokens?: number;
  readonly capabilitySource: string;
}
export interface ResolveRequestReasoningOptions {
  readonly provider: string;
  readonly baseUrl: string;
  readonly interfaceProvider: InterfaceProviderKind;
  readonly model: string;
  readonly maxTokens: number;
  readonly temperature?: number;
  readonly reasoning?: ReasoningConfig | ReasoningIntent;
  readonly override?: ReasoningConfig;
  readonly purpose?: "agent-step" | "context-summary" | "session-title";
  readonly modelProfiles?: readonly ModelJsonModelProfile[];
}

export function mergeReasoningIntent(
  base?: ReasoningConfig | ReasoningIntent,
  override?: ReasoningConfig,
): ReasoningIntent {
  validateReasoningConfig(base);
  validateReasoningConfig(override);
  const explicit =
    base && "explicit" in base
      ? base.explicit
      : {
          enabled: base?.enabled !== undefined,
          effort: base?.effort !== undefined,
        };
  return Object.freeze({
    enabled: override?.enabled ?? base?.enabled ?? true,
    effort: override?.effort ?? base?.effort ?? "medium",
    explicit: Object.freeze({
      enabled: override?.enabled !== undefined || explicit.enabled,
      effort: override?.effort !== undefined || explicit.effort,
    }),
  });
}

const OPENAI_EFFORT: ReasoningCapabilities = {
  mode: "effort",
  wire: "openai",
  supportsDisabled: true,
  efforts: ["low", "medium", "high", "xhigh"],
  temperature: "disabled-only",
};
const NON_REASONING: ReasoningCapabilities = {
  mode: "none",
  wire: "none",
  supportsDisabled: true,
  temperature: "allowed",
};
export function capabilitiesFor(options: ResolveRequestReasoningOptions): {
  capability?: ReasoningCapabilities;
  source: string;
} {
  let matching = options.modelProfiles?.filter(
    (profile) =>
      profile.model === options.model &&
      (profile.provider ?? options.provider) === options.provider &&
      (profile.interfaceProvider === undefined ||
        profile.interfaceProvider === options.interfaceProvider) &&
      (profile.baseUrl === undefined ||
        normalizedEndpoint(profile.baseUrl) ===
          normalizedEndpoint(options.baseUrl)) &&
      profile.reasoningCapabilities !== undefined,
  );
  const explicitProfiles = matching?.filter(
    (profile) => profile.reasoningCapabilitySource !== "model-metadata",
  );
  if (explicitProfiles?.length) matching = explicitProfiles;
  // Prefer more constrained routes; preserve last-entry precedence for ties.
  matching?.sort(
    (a, b) =>
      Number(a.provider !== undefined) +
      Number(a.interfaceProvider !== undefined) +
      Number(a.baseUrl !== undefined) -
      Number(b.provider !== undefined) -
      Number(b.interfaceProvider !== undefined) -
      Number(b.baseUrl !== undefined),
  );
  if (matching && matching.length > 0) {
    const capability = matching[matching.length - 1].reasoningCapabilities;
    if (capability === undefined)
      return fail("Missing model reasoning capabilities");
    validateReasoningCapabilities(capability);
    return {
      capability,
      source:
        matching[matching.length - 1].reasoningCapabilitySource ??
        "local-model-profile",
    };
  }
  const endpoint = normalizedEndpoint(options.baseUrl);
  // Verified route profiles: Zenmux reasoning guide and the exact model pages.
  // https://zenmux.ai/docs/guide/advanced/reasoning.html
  // Live regression evidence lives in the native-reasoning harness.
  if (options.provider === "zenmux") {
    const common = {
      mode: "effort" as const,
      supportsDisabled: true,
      temperature: "unsupported" as const,
    };
    if (endpoint === "https://zenmux.ai/api/v1") {
      if (
        options.model === "deepseek/deepseek-v4-flash" &&
        options.interfaceProvider === "openai-compatible"
      )
        return {
          capability: {
            ...common,
            wire: "reasoning",
            efforts: ["high", "max"],
          },
          source: "builtin:zenmux/deepseek-v4-flash",
        };
      if (
        options.model === "openai/gpt-5.6-luna" &&
        options.interfaceProvider !== "anthropic"
      )
        return {
          capability: {
            ...common,
            // The exact model page confirms levels, not a disable control.
            // https://zenmux.ai/openai/gpt-5.6-luna
            supportsDisabled: false,
            wire:
              options.interfaceProvider === "openai-responses"
                ? "openai"
                : "reasoning",
            efforts:
              options.interfaceProvider === "openai-responses"
                ? ["low", "medium", "high", "xhigh", "max"]
                : ["low", "medium", "high"],
          },
          source: "builtin:zenmux/gpt-5.6-luna",
        };
    }
    if (
      endpoint === "https://zenmux.ai/api/anthropic" &&
      options.model === "anthropic/claude-sonnet-5" &&
      options.interfaceProvider === "anthropic"
    )
      return {
        capability: {
          ...common,
          // Sonnet 5 adaptive thinking is always on.
          // https://zenmux.ai/anthropic/claude-sonnet-5
          supportsDisabled: false,
          wire: "anthropic-adaptive",
          efforts: ["low", "medium", "high", "xhigh", "max"],
        },
        source: "builtin:zenmux/claude-sonnet-5",
      };
  }
  // Exact identities only. Sources describe capabilities, not arbitrary proxy routes.
  // https://developers.openai.com/api/docs/models/gpt-5.2
  // https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.2
  if (
    options.provider === "openai" &&
    endpoint === "https://api.openai.com/v1" &&
    options.interfaceProvider !== "anthropic"
  ) {
    if (["gpt-5.2", "gpt-5.2-2025-12-11"].includes(options.model))
      return { capability: OPENAI_EFFORT, source: "builtin:openai/gpt-5.2" };
    if (
      ["gpt-5", "gpt-5-mini", "gpt-5-nano", "o3", "o4-mini"].includes(
        options.model,
      )
    )
      return {
        capability: {
          ...OPENAI_EFFORT,
          supportsDisabled: false,
          efforts: options.model.startsWith("gpt-5")
            ? ["minimal", "low", "medium", "high"]
            : ["low", "medium", "high"],
          temperature: "unsupported",
        },
        source: "builtin:openai/reasoning-models",
      };
    if (
      [
        "gpt-4o",
        "gpt-4o-mini",
        "gpt-4.1",
        "gpt-4.1-mini",
        "gpt-4.1-nano",
        "gpt-4",
        "gpt-3.5-turbo",
      ].includes(options.model)
    )
      return {
        capability: NON_REASONING,
        source: "builtin:openai/non-reasoning-models",
      };
  }
  // https://platform.claude.com/docs/en/build-with-claude/effort
  // https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking
  if (
    options.provider === "anthropic" &&
    ["https://api.anthropic.com", "https://api.anthropic.com/v1"].includes(
      endpoint,
    ) &&
    options.interfaceProvider === "anthropic"
  ) {
    if (["claude-sonnet-4-6", "claude-opus-4-6"].includes(options.model))
      return {
        capability: {
          mode: "effort",
          wire: "anthropic-adaptive",
          supportsDisabled: true,
          efforts: ["low", "medium", "high", "max"],
          temperature: "disabled-only",
        },
        source: "builtin:anthropic/adaptive-thinking",
      };
  }
  return { source: "unknown" };
}
function fail(message: string): never {
  throw new ConfigError(message, "INVALID_FIELD");
}
function validateWireProtocol(
  wire: ReasoningCapabilities["wire"],
  protocol: InterfaceProviderKind,
): void {
  if (wire === "none") return;
  if (
    protocol === "anthropic"
      ? !["anthropic-adaptive", "anthropic-budget"].includes(wire)
      : protocol === "openai-responses"
        ? wire !== "openai"
        : wire.startsWith("anthropic-")
  )
    fail(`Reasoning wire ${wire} is incompatible with ${protocol}`);
}

export function resolveRequestReasoning(
  options: ResolveRequestReasoningOptions,
): ResolvedReasoning {
  let intent = mergeReasoningIntent(options.reasoning, options.override);
  if (
    options.temperature !== undefined &&
    (!Number.isFinite(options.temperature) ||
      options.temperature < 0 ||
      options.temperature > 2)
  )
    fail("Invalid temperature: must be between 0 and 2");
  const { capability, source } = capabilitiesFor(options);
  if (!capability)
    return Object.freeze({
      intent,
      mode: "service-default",
      wire: "none",
      capabilitySource: source,
    });
  // Validate an explicit selection before applying the auxiliary title policy.
  if (options.purpose === "session-title") {
    resolveRequestReasoning({ ...options, purpose: "agent-step" });
    if (capability.supportsDisabled)
      intent = mergeReasoningIntent(intent, { enabled: false });
  }
  validateWireProtocol(capability.wire, options.interfaceProvider);
  const base = { intent, wire: capability.wire, capabilitySource: source };
  if (options.temperature !== undefined) {
    if (
      !Number.isFinite(options.temperature) ||
      options.temperature < 0 ||
      options.temperature > 2
    )
      fail("Invalid temperature: must be between 0 and 2");
    if (
      capability.temperature === "unsupported" ||
      (capability.temperature === "disabled-only" &&
        intent.enabled &&
        capability.mode !== "none")
    )
      fail(
        "Explicit temperature is unsupported for this reasoning configuration; remove temperature from llmParams or disable reasoning when supported",
      );
  }
  if (!intent.enabled) {
    if (!capability.supportsDisabled)
      fail(`Model ${options.model} cannot disable reasoning`);
    return Object.freeze({
      ...base,
      mode: capability.mode === "none" ? "none" : "disabled",
    });
  }
  if (capability.mode === "none") {
    if (intent.explicit.enabled || intent.explicit.effort)
      fail(
        `Model ${options.model} does not support reasoning; remove explicit reasoning intent`,
      );
    return Object.freeze({ ...base, mode: "none" });
  }
  if (capability.mode === "binary") {
    if (intent.explicit.effort)
      fail(
        `Model ${options.model} supports only on/off (binary reasoning), not explicit effort ${intent.effort}`,
      );
    return Object.freeze({ ...base, mode: "binary" });
  }
  const effort = intent.explicit.effort
    ? (capability.effortMap?.[intent.effort] ?? intent.effort)
    : defaultReasoningEffort(capability);
  if (effort === undefined)
    return Object.freeze({ ...base, mode: "service-default" });
  if (!capability.efforts?.includes(effort))
    fail(
      `Unsupported reasoning effort ${intent.effort}; supported: ${capability.efforts?.join(", ") ?? "none"}. Configure an explicit effortMap to map strengths`,
    );
  if (capability.wire === "anthropic-budget") {
    const budgetTokens = capability.budgets?.[effort];
    if (
      budgetTokens === undefined ||
      !Number.isInteger(budgetTokens) ||
      budgetTokens < Math.max(1024, capability.minBudgetTokens ?? 1024) ||
      budgetTokens >= options.maxTokens
    )
      fail(
        "Reasoning budget must be explicitly mapped, meet the minimum, and be strictly less than maxTokens",
      );
    return Object.freeze({ ...base, mode: "effort", effort, budgetTokens });
  }
  return Object.freeze({ ...base, mode: "effort", effort });
}

export interface ChatReasoningWire {
  reasoning_effort?: string;
  thinking?: { type: "enabled" | "disabled" };
  enable_thinking?: boolean;
  reasoning?: { enabled: boolean; effort?: string };
}
export function toChatReasoningWire(
  reasoning?: ResolvedReasoning,
): ChatReasoningWire {
  if (
    !reasoning ||
    reasoning.mode === "none" ||
    reasoning.mode === "service-default"
  )
    return {};
  const enabled = reasoning.mode !== "disabled";
  switch (reasoning.wire) {
    case "openai":
      return { reasoning_effort: enabled ? reasoning.effort : "none" };
    case "thinking":
      return { thinking: { type: enabled ? "enabled" : "disabled" } };
    case "enable-thinking":
      return { enable_thinking: enabled };
    case "reasoning":
      return {
        reasoning: {
          enabled,
          ...(enabled && reasoning.effort !== undefined
            ? { effort: reasoning.effort }
            : {}),
        },
      };
    default:
      return fail(
        `Reasoning wire ${reasoning.wire} cannot be sent through Chat`,
      );
  }
}
export interface ResponsesReasoningWire {
  reasoning?: { effort: string };
  include?: ["reasoning.encrypted_content"];
}
export function toResponsesReasoningWire(
  reasoning?: ResolvedReasoning,
): ResponsesReasoningWire {
  if (reasoning?.mode === "service-default")
    return { include: ["reasoning.encrypted_content"] };
  if (!reasoning || reasoning.mode === "none") return {};
  if (reasoning.wire !== "openai")
    return fail(
      `Reasoning wire ${reasoning.wire} cannot be sent through Responses`,
    );
  if (reasoning.mode === "disabled") return { reasoning: { effort: "none" } };
  if (!reasoning.effort) return fail("Responses reasoning requires an effort");
  return {
    reasoning: { effort: reasoning.effort },
    include: ["reasoning.encrypted_content"],
  };
}
export interface AnthropicReasoningWire {
  thinking?:
    | { type: "adaptive" }
    | { type: "disabled" }
    | { type: "enabled"; budget_tokens: number };
  output_config?: { effort: string };
}
export function toAnthropicReasoningWire(
  reasoning?: ResolvedReasoning,
): AnthropicReasoningWire {
  if (
    !reasoning ||
    reasoning.mode === "none" ||
    reasoning.mode === "service-default"
  )
    return {};
  if (!reasoning.wire.startsWith("anthropic-"))
    return fail(
      `Reasoning wire ${reasoning.wire} cannot be sent through Anthropic`,
    );
  if (reasoning.mode === "disabled") return { thinking: { type: "disabled" } };
  if (reasoning.wire === "anthropic-budget") {
    if (reasoning.budgetTokens === undefined)
      return fail("Anthropic thinking requires a budget");
    return {
      thinking: { type: "enabled", budget_tokens: reasoning.budgetTokens },
    };
  }
  if (!reasoning.effort) return fail("Adaptive thinking requires an effort");
  return {
    thinking: { type: "adaptive" },
    output_config: { effort: reasoning.effort },
  };
}

const STANDARD_EFFORT_ORDER = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export function orderedReasoningEfforts(
  capability: ReasoningCapabilities,
): readonly string[] {
  const supported = capability.efforts ?? [];
  const order = capability.effortOrder ?? STANDARD_EFFORT_ORDER;
  return order.filter((value) => supported.includes(value));
}
export function defaultReasoningEffort(
  capability: ReasoningCapabilities,
): string | undefined {
  if (capability.efforts?.includes("medium")) return "medium";
  if (
    capability.defaultEffort &&
    capability.efforts?.includes(capability.defaultEffort)
  )
    return capability.defaultEffort;
  return orderedReasoningEfforts(capability)[0];
}

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

/** Revalidates stored defaults only; immutable submissions use the strict resolver. */
export function compatibleReasoningPreference(
  preference: ReasoningConfig | undefined,
  capability: ReasoningCapabilities | undefined,
): boolean {
  if (!preference || !capability) return true;
  if (preference.enabled === false) return capability.supportsDisabled;
  if (capability.mode === "none")
    return preference.enabled === undefined && preference.effort === undefined;
  if (preference.effort === undefined) return true;
  return (
    capability.mode === "effort" &&
    !!capability.efforts?.includes(
      capability.effortMap?.[preference.effort] ?? preference.effort,
    )
  );
}
