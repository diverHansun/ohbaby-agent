import { createHash } from "node:crypto";
import type { PromptCachePolicy } from "../../config/index.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions";
import type {
  InterfaceProviderKind,
  InterfaceProviderPromptCache,
  LLMRequestPurpose,
  PromptCacheRequestStrategy,
} from "../../services/interface-providers/index.js";
import { scopedSessionKey } from "../../utils/scoped-session.js";

interface PromptCacheCapabilityInput {
  readonly baseUrl: string;
  readonly interfaceProvider: InterfaceProviderKind;
  readonly policy: PromptCachePolicy;
  readonly provider: string;
}

interface PromptCacheCapability {
  readonly reason: string;
  readonly strategy: PromptCacheRequestStrategy;
}

export interface PromptCacheRequestInput extends PromptCacheCapabilityInput {
  readonly contextScopeId?: string;
  readonly messages?: readonly ChatCompletionMessageParam[];
  readonly purpose?: LLMRequestPurpose;
  readonly sessionId?: string;
}

type KnownEndpoint =
  | "openai"
  | "anthropic"
  | "deepseek-openai"
  | "deepseek-anthropic"
  | "zhipu"
  | "kimi"
  | "zenmux-openai"
  | "zenmux-anthropic"
  | "unknown";

const KNOWN_PATHS: Readonly<
  Record<Exclude<KnownEndpoint, "unknown">, Set<string>>
> = {
  anthropic: new Set(["", "/v1"]),
  "deepseek-anthropic": new Set(["/anthropic", "/anthropic/v1"]),
  "deepseek-openai": new Set(["", "/v1"]),
  kimi: new Set(["/v1", "/coding/v1"]),
  openai: new Set(["", "/v1"]),
  "zenmux-anthropic": new Set(["/api/anthropic", "/api/anthropic/v1"]),
  "zenmux-openai": new Set(["/api/v1"]),
  zhipu: new Set(["/api/paas/v4", "/api/coding/paas/v4"]),
};

function normalizedKnownUrl(baseUrl: string): {
  readonly hostname: string;
  readonly pathname: string;
} | null {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return null;
  }

  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return null;
  }

  const pathname = url.pathname.replace(/\/+$/u, "");
  return { hostname: url.hostname.toLowerCase(), pathname };
}

function endpointMatches(
  endpoint: Exclude<KnownEndpoint, "unknown">,
  input: { readonly hostname: string; readonly pathname: string },
): boolean {
  const hostMatches =
    (endpoint === "openai" && input.hostname === "api.openai.com") ||
    (endpoint === "anthropic" && input.hostname === "api.anthropic.com") ||
    ((endpoint === "deepseek-openai" || endpoint === "deepseek-anthropic") &&
      input.hostname === "api.deepseek.com") ||
    (endpoint === "zhipu" && input.hostname === "open.bigmodel.cn") ||
    (endpoint === "kimi" &&
      (input.hostname === "api.moonshot.cn" ||
        input.hostname === "api.kimi.com")) ||
    ((endpoint === "zenmux-openai" || endpoint === "zenmux-anthropic") &&
      input.hostname === "zenmux.ai");
  return hostMatches && KNOWN_PATHS[endpoint].has(input.pathname);
}

function classifyEndpoint(baseUrl: string): KnownEndpoint {
  const url = normalizedKnownUrl(baseUrl);
  if (!url) {
    return "unknown";
  }

  const endpoints = Object.keys(KNOWN_PATHS) as Exclude<
    KnownEndpoint,
    "unknown"
  >[];
  return (
    endpoints.find((endpoint) => endpointMatches(endpoint, url)) ?? "unknown"
  );
}

function resolved(
  strategy: PromptCacheRequestStrategy,
  reason: string,
): PromptCacheCapability {
  return { strategy, reason };
}

/** Pure capability resolution. Provider id is diagnostic only; URL matching grants capability. */
export function resolvePromptCacheStrategy(
  input: PromptCacheCapabilityInput,
): PromptCacheCapability {
  if (input.policy === "disabled") {
    return resolved("observe-only", "prompt cache controls are disabled");
  }

  const endpoint = classifyEndpoint(input.baseUrl);
  if (input.policy === "enabled") {
    if (input.interfaceProvider === "openai-compatible") {
      return resolved(
        "openai-keyed-implicit",
        "explicitly enabled for an OpenAI-compatible endpoint",
      );
    }
    if (endpoint === "anthropic") {
      return resolved(
        "anthropic-top-level-auto",
        "explicitly enabled for the official Anthropic endpoint",
      );
    }
    if (endpoint === "deepseek-anthropic") {
      return resolved(
        "observe-only",
        "DeepSeek Anthropic format ignores cache_control",
      );
    }
    return resolved(
      "anthropic-explicit-last-block",
      "explicitly enabled with a conservative Anthropic block marker",
    );
  }

  if (
    input.interfaceProvider === "openai-compatible" &&
    endpoint === "openai"
  ) {
    return resolved(
      "openai-keyed-implicit",
      "trusted official OpenAI endpoint",
    );
  }
  if (input.interfaceProvider === "anthropic" && endpoint === "anthropic") {
    return resolved(
      "anthropic-top-level-auto",
      "trusted official Anthropic endpoint",
    );
  }
  if (
    input.interfaceProvider === "anthropic" &&
    endpoint === "zenmux-anthropic"
  ) {
    return resolved(
      "anthropic-explicit-last-block",
      "known ZenMux Anthropic endpoint",
    );
  }

  return resolved(
    "observe-only",
    `no trusted cache-control capability for ${endpoint} (${input.provider})`,
  );
}

export function createScopedPromptCacheKey(input: {
  readonly contextScopeId?: string;
  readonly sessionId: string;
}): string {
  const identity = scopedSessionKey(input);
  const digest = createHash("sha256").update(identity).digest("base64url");
  return `ob:v1:${digest}`;
}

/**
 * Resolve request policy once before the provider retry loop. Auxiliary and
 * legacy calls remain observable but cannot accidentally share a cache key.
 */
export function resolvePromptCacheRequest(
  input: PromptCacheRequestInput,
): InterfaceProviderPromptCache {
  if (input.purpose === undefined) {
    return {
      strategy: "observe-only",
      reason: "legacy caller omitted request purpose",
    };
  }
  if (input.purpose !== "agent-step") {
    return {
      strategy: "observe-only",
      reason: `${input.purpose} is an auxiliary request`,
    };
  }
  if (input.sessionId === undefined || input.sessionId === "") {
    return {
      strategy: "observe-only",
      reason: "agent-step caller omitted its session identity",
    };
  }

  const capability = resolvePromptCacheStrategy(input);
  if (
    capability.strategy === "anthropic-explicit-last-block" &&
    !hasAnthropicExplicitCacheTarget(input.messages ?? [])
  ) {
    return {
      strategy: "observe-only",
      reason:
        "anthropic explicit cache control degraded: no eligible content block",
    };
  }
  if (capability.strategy === "openai-keyed-implicit") {
    return {
      strategy: capability.strategy,
      reason: capability.reason,
      key: createScopedPromptCacheKey({
        sessionId: input.sessionId,
        ...(input.contextScopeId === undefined
          ? {}
          : { contextScopeId: input.contextScopeId }),
      }),
    };
  }
  return {
    strategy: capability.strategy,
    reason: capability.reason,
  };
}

function nonEmptyTextContent(content: unknown): boolean {
  if (typeof content === "string") {
    return content.length > 0;
  }
  return (
    Array.isArray(content) &&
    content.some((part: unknown) => {
      if (part === null || typeof part !== "object") {
        return false;
      }
      const text = (part as Record<string, unknown>).text;
      return typeof text === "string" && text.length > 0;
    })
  );
}

function hasAnthropicExplicitCacheTarget(
  messages: readonly ChatCompletionMessageParam[],
): boolean {
  return messages.some((message) => {
    const wireMessage = message as ChatCompletionMessageParam & {
      readonly content?: unknown;
      readonly role: string;
      readonly tool_calls?: readonly unknown[];
    };
    if (wireMessage.role === "tool") {
      return true;
    }
    return (
      nonEmptyTextContent(wireMessage.content) ||
      (wireMessage.role === "assistant" &&
        (wireMessage.tool_calls?.length ?? 0) > 0)
    );
  });
}
