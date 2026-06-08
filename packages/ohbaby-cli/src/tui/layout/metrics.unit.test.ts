import { describe, expect, it } from "vitest";
import { computeLayoutMetrics } from "./metrics.js";

describe("computeLayoutMetrics", () => {
  it("uses compact padding below 80 columns", () => {
    expect(computeLayoutMetrics({ columns: 60, rows: 30 })).toEqual({
      columns: 60,
      contentWidth: 56,
      horizontalPadding: 2,
      isCompact: true,
      rows: 30,
    });
  });

  it("uses the available width on ordinary wide terminals", () => {
    expect(computeLayoutMetrics({ columns: 180, rows: 40 })).toEqual({
      columns: 180,
      contentWidth: 172,
      horizontalPadding: 4,
      isCompact: false,
      rows: 40,
    });
  });

  it("uses regular padding and caps ultra-wide content", () => {
    expect(computeLayoutMetrics({ columns: 300, rows: 40 })).toEqual({
      columns: 300,
      contentWidth: 220,
      horizontalPadding: 4,
      isCompact: false,
      rows: 40,
    });
  });
});
