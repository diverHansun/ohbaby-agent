import { applyPatch } from "diff";
import { describe, expect, it } from "vitest";
import { renderUnifiedDiff } from "./output.js";
import { boundedDiff } from "./mutation-budgets.js";

describe("real unified diff", () => {
  it("keeps distant unchanged lines out of a one-line hunk", () => {
    const before = Array.from(
      { length: 40 },
      (_, i) => `line ${String(i)}`,
    ).join("\n");
    const diff = renderUnifiedDiff({
      before,
      after: before.replace("line 20", "changed"),
    });
    expect(diff).toContain("@@ -18,7 +18,7 @@");
    expect(diff).toContain("-line 20\n+changed");
    expect(diff).not.toContain("line 0\n");
  });
  it.each([
    ["", "a\n"],
    ["a\n", ""],
    ["a\nb\na\n", "a\na\n"],
    ["a\r\nb\r\n", "a\r\nc\r\n"],
    ["a", "a\n"],
  ])("represents boundary and newline changes %j", (before, after) => {
    const diff = renderUnifiedDiff({ before, after });
    expect(diff).toContain("@@");
    expect(applyPatch(before, diff)).toBe(after);
    if (before === "a") expect(diff).toContain("\\ No newline at end of file");
  });
  it("has no hunk for unchanged input", () => {
    expect(renderUnifiedDiff({ before: "a\n", after: "a\n" })).not.toContain(
      "@@",
    );
  });
  it("retains a small hunk from large unchanged context within the input budget", () => {
    const before = "same\n".repeat(10000) + "old\n";
    expect(boundedDiff(before, before.replace("old", "new")).diffOmitted).toBe(
      false,
    );
  });
});
