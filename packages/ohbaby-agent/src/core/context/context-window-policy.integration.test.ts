import { afterEach, expect, it, vi } from "vitest";
import { probeContextWindow } from "../../config/llm/context-window-probe.js";
import { createHeuristicTokenCounter } from "../../services/llm-model/tokenCounting.js";
import { decideCompactionRung, getContextUsage } from "./compaction-policy.js";
import { contextUsageToContextWindowUsage } from "./context-window-usage.js";

afterEach(() => vi.unstubAllGlobals());

it.each(["openai-compatible", "openai-responses", "anthropic"] as const)(
  "%s uses the detected model window for display and automatic summary",
  async (interfaceProvider) => {
    // Deliberately differ from both the built-in gpt-4o window and fallback.
    const contextWindowTokens = 200_000;
    const metadata = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: "gpt-4o", context_length: contextWindowTokens }],
        }),
      ),
    );
    vi.stubGlobal("fetch", metadata);
    const detected = await probeContextWindow({
      apiKey: "fixture-key",
      baseUrl: "https://fixture.invalid/v1",
      interfaceProvider,
      model: "gpt-4o",
    });
    expect(detected.contextWindowTokens).toBe(contextWindowTokens);
    if (detected.contextWindowTokens === undefined)
      throw new Error("Fixture metadata missing window");
    const counter = createHeuristicTokenCounter({
      defaultLimit: 64_000,
      provider: "fixture",
      profiles: [
        {
          model: "gpt-4o",
          provider: "fixture",
          contextWindowTokens: detected.contextWindowTokens,
          maxOutputTokens: 32_000,
        },
      ],
    });
    for (const currentTokens of [189_999, 190_000, 190_001]) {
      const usage = getContextUsage(currentTokens, "gpt-4o", counter);
      const displayed = contextUsageToContextWindowUsage({
        sessionId: "s",
        usage,
      });
      expect(displayed?.contextWindowTokens).toBe(contextWindowTokens);
      expect(displayed?.contextWindowRatio).toBe(
        currentTokens / contextWindowTokens,
      );
      expect(usage.remainingTokens).toBe(0);
      expect(decideCompactionRung({ force: false, usage })).toBe(
        currentTokens < 190_000 ? "mask" : "prune-summary",
      );
    }
    expect(metadata).toHaveBeenCalledTimes(1);
  },
);
