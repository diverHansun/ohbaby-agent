import { describe, expect, it } from "vitest";
import { RunDefaultsPolicyError, mergeRunDefaults } from "./index.js";
import type { RunDefaultsPolicy } from "./index.js";

const policy: RunDefaultsPolicy = {
  defaults: {
    user: {
      permissionProfileId: "interactive",
      multitaskStrategy: "reject",
      disconnectMode: "continue",
    },
  },
};

describe("mergeRunDefaults", () => {
  it("merges trigger defaults with explicit overrides", () => {
    expect(
      mergeRunDefaults(policy, "user", {
        permissionProfileId: "full-auto",
      }),
    ).toEqual({
      permissionProfileId: "full-auto",
      multitaskStrategy: "reject",
      disconnectMode: "continue",
    });
  });

  it("throws when policy is missing a trigger source", () => {
    expect(() =>
      mergeRunDefaults({ defaults: {} }, "scheduler" as never),
    ).toThrow(RunDefaultsPolicyError);
  });
});
