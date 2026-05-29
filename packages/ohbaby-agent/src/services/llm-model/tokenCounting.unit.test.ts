import { describe, expect, it } from "vitest";
import {
  createHeuristicTokenCounter,
  estimateTokensForText,
} from "./tokenCounting.js";
import type { TokenCounter } from "../../core/context/index.js";

describe("tokenCounting", () => {
  describe("estimateTokensForText", () => {
    it("estimates ASCII, non-ASCII, mixed, emoji, and empty text", () => {
      expect(estimateTokensForText("")).toBe(0);
      expect(estimateTokensForText("abcd")).toBe(1);
      expect(estimateTokensForText("abcde")).toBe(2);
      expect(estimateTokensForText("你好")).toBe(3);
      expect(estimateTokensForText("Hello 世界")).toBe(5);
      expect(estimateTokensForText("🙂")).toBe(2);
      expect(estimateTokensForText("🙂🙂")).toBe(3);
    });

    it("throws TypeError for non-string text", () => {
      expect(() =>
        estimateTokensForText(undefined as unknown as string),
      ).toThrow(TypeError);
      expect(() => estimateTokensForText(123 as unknown as string)).toThrow(
        TypeError,
      );
      expect(() => estimateTokensForText(null as unknown as string)).toThrow(
        TypeError,
      );
    });
  });

  describe("createHeuristicTokenCounter", () => {
    it("returns a shape compatible with context TokenCounter", () => {
      const counter: TokenCounter = createHeuristicTokenCounter();

      expect(counter.estimateTokens("abcd")).toBe(1);
      expect(counter.getLimit("gpt-4")).toBe(8_192);
    });

    it("uses a configured default context window for unknown model ids", () => {
      const counter: TokenCounter = createHeuristicTokenCounter({
        defaultLimit: 256_000,
      });

      expect(counter.getLimit("custom-large-context-model")).toBe(256_000);
      expect(counter.getLimit("gpt-4o")).toBe(128_000);
    });

    it("uses registered model profiles for context limits and token budgets", () => {
      const counter = createHeuristicTokenCounter({
        profiles: [
          {
            contextWindowTokens: 250_000,
            maxOutputTokens: 16_000,
            model: "custom-chat",
            provider: "local",
          },
        ],
      });

      expect(counter.getLimit("custom-chat")).toBe(250_000);
      expect(
        counter.getBudget("custom-chat", {
          requestedOutputTokens: 20_000,
          safetyMarginTokens: 2_000,
          usedInputTokens: 20_000,
        }),
      ).toMatchObject({
        contextWindowTokens: 250_000,
        inputBudgetTokens: 232_000,
        maxOutputTokens: 16_000,
        remainingInputTokens: 212_000,
        reservedOutputTokens: 16_000,
        safetyMarginTokens: 2_000,
      });
    });
  });
});
