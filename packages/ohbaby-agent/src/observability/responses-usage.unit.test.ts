import { describe, expect, it } from "vitest";
import { tokenUsageNormalization } from "./events.js";
import { encodeDiagnosticEvent } from "./logger.js";

const payload = {
  protocol: "openai-responses",
  code: "raw-total-mismatch",
  field: undefined,
  received: 999,
  retained: undefined,
  normalizedTotal: 120,
} as const;
describe("Responses usage diagnostic closed contract", () => {
  it("encodes the Responses protocol without widening diagnostic contents", () => {
    const result = encodeDiagnosticEvent(
      tokenUsageNormalization,
      payload,
      { roots: {} },
      "2026-09-12T00:00:00Z",
    );
    expect(result.record).toMatchObject({
      event: "llm.usage.normalization",
      protocol: "openai-responses",
      received: 999,
      normalizedTotal: 120,
    });
  });
  it.each([
    { ...payload, protocol: "future-protocol" },
    { ...payload, prompt: "sensitive" },
    { ...payload, arguments: "sensitive" },
    { ...payload, code: "unknown-code" },
  ])("rejects undeclared values or sensitive fields: %j", (input) => {
    expect(() =>
      encodeDiagnosticEvent(
        tokenUsageNormalization,
        input as never,
        { roots: {} },
        "2026-09-12T00:00:00Z",
      ),
    ).toThrow();
  });
});
