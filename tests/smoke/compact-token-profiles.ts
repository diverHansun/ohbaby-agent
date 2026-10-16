import type { NativeRealProfile } from "./reasoning-native-harness.js";

export interface CompactTokenProfile extends NativeRealProfile {
  provider: string;
  apiKeyEnv: string;
}

// The complete model/protocol matrix in tests/models-4-tests.md.
export const COMPACT_TOKEN_PROFILES: readonly CompactTokenProfile[] = [
  ...routes(
    "zenmux",
    "ZENMUX_API_KEY",
    "deepseek/deepseek-v4.1-flash",
    "zenmux-deepseek",
    ["openai-compatible", "openai-responses", "anthropic"],
  ),
  ...routes(
    "zenmux",
    "ZENMUX_API_KEY",
    "anthropic/claude-sonnet-5",
    "zenmux-sonnet",
    ["anthropic"],
  ),
  ...routes("zenmux", "ZENMUX_API_KEY", "openai/gpt-5.6-luna", "zenmux-luna", [
    "openai-compatible",
    "openai-responses",
  ]),
  ...routes("zhipu", "ZAI_API_KEY", "glm-5.3-flash", "zhipu-glm", [
    "openai-compatible",
  ]),
  ...routes(
    "aliyun-dashscope",
    "DASHSCOPE_API_KEY",
    "qwen3.8-flash",
    "aliyun-qwen",
    ["openai-compatible", "anthropic"],
  ),
  ...routes(
    "deepseek",
    "DEEPSEEK_API_KEY",
    "deepseek-flash",
    "deepseek-flash",
    ["openai-compatible", "openai-responses", "anthropic"],
  ),
  ...routes("deepseek", "DEEPSEEK_API_KEY", "deepseek-v4-pro", "deepseek-pro", [
    "openai-compatible",
    "openai-responses",
    "anthropic",
  ]),
];

function routes(
  provider: string,
  apiKeyEnv: string,
  model: string,
  prefix: string,
  protocols: NativeRealProfile["protocol"][],
): CompactTokenProfile[] {
  return protocols.map((protocol) => ({
    id: `${prefix}-${protocol}`,
    provider,
    apiKeyEnv,
    model,
    protocol,
    baseUrl:
      provider === "zenmux"
        ? `https://zenmux.ai/api/${protocol === "anthropic" ? "anthropic" : "v1"}`
        : provider === "zhipu"
          ? "https://open.bigmodel.cn/api/paas/v4"
          : provider === "aliyun-dashscope"
            ? `https://dashscope.aliyuncs.com/${protocol === "anthropic" ? "apps/anthropic" : "compatible-mode/v1"}`
            : `https://api.deepseek.com${protocol === "anthropic" ? "/anthropic" : ""}`,
    enabledEffort: "medium",
    capabilities: {
      ...(protocol !== "openai-compatible" || model.includes("gpt-")
        ? { mode: "effort" as const, efforts: ["low", "medium", "high"] }
        : { mode: "binary" as const }),
      supportsDisabled: true,
      wire:
        protocol === "anthropic"
          ? "anthropic-adaptive"
          : protocol === "openai-responses" || model.includes("gpt-")
            ? "openai"
            : provider === "aliyun-dashscope"
              ? "enable-thinking"
              : provider === "zenmux"
                ? "reasoning"
                : "thinking",
    },
    sources: ["tests/models-4-tests.md"],
  }));
}

export function generationEndpoint(profile: CompactTokenProfile): string {
  return (
    profile.baseUrl +
    (profile.protocol === "anthropic"
      ? "/v1/messages"
      : profile.protocol === "openai-responses"
        ? "/responses"
        : "/chat/completions")
  );
}
