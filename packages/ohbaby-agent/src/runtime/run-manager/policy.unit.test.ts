import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUN_POLICY,
  RunDefaultsPolicyError,
  mergeRunDefaults,
} from "./index.js";

describe("mergeRunDefaults", () => {
  it("merges trigger defaults with explicit overrides", () => {
    expect(
      mergeRunDefaults(DEFAULT_RUN_POLICY, "user", {
        permissionProfileId: "full-auto",
      }),
    ).toEqual({
      permissionProfileId: "full-auto",
      multitaskStrategy: "reject",
      disconnectMode: "continue",
    });
  });

  it.each(["user", "goal", "subagent"] as const)(
    "uses interactive reject defaults for %s",
    (source) => {
      expect(mergeRunDefaults(DEFAULT_RUN_POLICY, source)).toEqual({
        permissionProfileId: "interactive",
        multitaskStrategy: "reject",
        disconnectMode: "continue",
      });
    },
  );

  it("throws for an unknown trigger source", () => {
    expect(() =>
      mergeRunDefaults(DEFAULT_RUN_POLICY, "scheduler" as never),
    ).toThrow(RunDefaultsPolicyError);
  });
});
