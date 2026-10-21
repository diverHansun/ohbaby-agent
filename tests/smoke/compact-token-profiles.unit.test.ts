import { expect, it } from "vitest";
import { validateReasoningCapabilities } from "ohbaby-llm";
import {
  COMPACT_TOKEN_PROFILES,
  generationEndpoint,
} from "./compact-token-profiles.js";

it("covers all 15 listed routes with production-valid capabilities", () => {
  expect(COMPACT_TOKEN_PROFILES).toHaveLength(15);
  expect(new Set(COMPACT_TOKEN_PROFILES.map((p) => p.id)).size).toBe(15);
  for (const p of COMPACT_TOKEN_PROFILES) {
    expect(() => {
      validateReasoningCapabilities(p.capabilities);
    }, p.id).not.toThrow();
    expect(new URL(generationEndpoint(p)).protocol).toBe("https:");
  }
});
