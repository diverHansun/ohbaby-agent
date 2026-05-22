import { describe, expect, it } from "vitest";
import {
  calculateContextTokens,
  createHeuristicTokenCounter,
  estimateTokensForMessage,
  estimateTokensForMessages,
  estimateTokensForText,
  getTokenLimit,
  isApproachingTokenLimit,
  type TokenCountMessage,
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

  describe("estimateTokensForMessage", () => {
    it("adds role overhead for user, assistant, and system messages", () => {
      expect(estimateTokensForMessage({ role: "user", content: "test" })).toBe(
        estimateTokensForText("test") + 3,
      );
      expect(
        estimateTokensForMessage({ role: "assistant", content: "response" }),
      ).toBe(estimateTokensForText("response") + 3);
      expect(
        estimateTokensForMessage({ role: "system", content: "be helpful" }),
      ).toBe(estimateTokensForText("be helpful") + 100);
    });

    it("counts tool_call_id and assistant tool_calls", () => {
      const toolMessage: TokenCountMessage = {
        role: "tool",
        content: "done",
        tool_call_id: "call_123",
      };
      const toolCalls = [
        {
          function: { arguments: '{"path":"README.md"}', name: "read" },
          id: "call_123",
          type: "function",
        },
      ];

      expect(estimateTokensForMessage(toolMessage)).toBe(
        estimateTokensForText("done") + estimateTokensForText("call_123") + 5,
      );
      expect(
        estimateTokensForMessage({
          role: "assistant",
          content: null,
          tool_calls: toolCalls,
        }),
      ).toBe(3 + estimateTokensForText(JSON.stringify(toolCalls)));
      expect(
        estimateTokensForMessage({ role: "assistant", content: null }),
      ).toBe(3);
    });
  });

  describe("estimateTokensForMessages", () => {
    it("adds conversation overhead and supports empty arrays", () => {
      const messages: readonly TokenCountMessage[] = [
        { role: "system", content: "rules" },
        { role: "user", content: "hello" },
      ];

      expect(estimateTokensForMessages([])).toBe(4);
      expect(estimateTokensForMessages(messages)).toBe(
        estimateTokensForMessage(messages[0]) +
          estimateTokensForMessage(messages[1]) +
          4,
      );
    });

    it("throws TypeError for non-array messages", () => {
      expect(() =>
        estimateTokensForMessages("not array" as unknown as []),
      ).toThrow(TypeError);
      expect(() => estimateTokensForMessages(null as unknown as [])).toThrow(
        TypeError,
      );
    });
  });

  describe("getTokenLimit", () => {
    it("returns known limits, prefix matches, and conservative defaults", () => {
      expect(getTokenLimit("gpt-4")).toBe(8_192);
      expect(getTokenLimit("GPT-4-TURBO-preview")).toBe(128_000);
      expect(getTokenLimit("gpt-4o")).toBe(128_000);
      expect(getTokenLimit("gpt-4o-mini")).toBe(128_000);
      expect(getTokenLimit("gpt-3.5-turbo")).toBe(4_096);
      expect(getTokenLimit("gpt-4o-realtime-preview")).toBe(4_096);
      expect(getTokenLimit("gpt-4o-mini-transcribe")).toBe(4_096);
      expect(getTokenLimit("unknown-model")).toBe(4_096);
      expect(getTokenLimit("")).toBe(4_096);
    });

    it("throws TypeError for invalid model identifiers", () => {
      expect(() => getTokenLimit(123 as unknown as string)).toThrow(TypeError);
    });
  });

  describe("calculateContextTokens", () => {
    it("calculates remaining tokens, percent used, and warning state", () => {
      const messages: readonly TokenCountMessage[] = [
        { role: "user", content: "hello" },
      ];
      const messagesTokens = estimateTokensForMessages(messages);
      const context = calculateContextTokens(messages, "gpt-3.5-turbo", 128);

      expect(context.messagesTokens).toBe(messagesTokens);
      expect(context.estimatedResponseTokens).toBe(128);
      expect(context.totalUsedTokens).toBe(messagesTokens + 128);
      expect(context.remainingTokens).toBe(4_096 - context.totalUsedTokens);
      expect(context.usage.percentUsed).toBeCloseTo(
        (context.totalUsedTokens / 4_096) * 100,
        6,
      );
      expect(context.usage.hasWarning).toBe(false);
    });

    it("uses a default max response token budget", () => {
      const context = calculateContextTokens([], "gpt-4");

      expect(context.messagesTokens).toBe(4);
      expect(context.estimatedResponseTokens).toBe(2_048);
      expect(context.totalUsedTokens).toBe(2_052);
    });

    it("sets hasWarning when total usage reaches the warning threshold", () => {
      const context = calculateContextTokens(
        [{ role: "user", content: "a".repeat(13_100) }],
        "gpt-3.5-turbo",
        0,
      );

      expect(context.usage.percentUsed).toBeGreaterThanOrEqual(80);
      expect(context.usage.hasWarning).toBe(true);
    });
  });

  describe("isApproachingTokenLimit", () => {
    it("classifies none, warning, and critical thresholds including response budget", () => {
      expect(
        isApproachingTokenLimit(
          [{ role: "user", content: "short" }],
          "gpt-3.5-turbo",
        ),
      ).toMatchObject({
        isApproaching: false,
        severity: "none",
      });

      const warningFromResponseBudget = isApproachingTokenLimit(
        [{ role: "user", content: "a".repeat(4_900) }],
        "gpt-3.5-turbo",
      );
      const warning = isApproachingTokenLimit(
        [{ role: "user", content: "a".repeat(6_000) }],
        "gpt-3.5-turbo",
      );
      const critical = isApproachingTokenLimit(
        [{ role: "user", content: "a".repeat(15_600) }],
        "gpt-3.5-turbo",
      );

      expect(warningFromResponseBudget.severity).toBe("warning");
      expect(warningFromResponseBudget.isApproaching).toBe(true);
      expect(warning.severity).toBe("warning");
      expect(warning.isApproaching).toBe(true);
      expect(warning.percentUsed).toBeGreaterThanOrEqual(80);
      expect(warning.percentUsed).toBeLessThan(95);
      expect(critical.severity).toBe("critical");
      expect(critical.isApproaching).toBe(true);
      expect(critical.percentUsed).toBeGreaterThanOrEqual(95);
    });
  });

  describe("createHeuristicTokenCounter", () => {
    it("returns a shape compatible with context TokenCounter", () => {
      const counter: TokenCounter = createHeuristicTokenCounter();

      expect(counter.estimateTokens("abcd")).toBe(1);
      expect(counter.getLimit("gpt-4")).toBe(8_192);
    });
  });
});
