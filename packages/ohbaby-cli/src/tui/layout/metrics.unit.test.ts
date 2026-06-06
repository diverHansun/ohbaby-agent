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

  it("uses regular padding and caps wide content", () => {
    expect(computeLayoutMetrics({ columns: 300, rows: 40 })).toEqual({
      columns: 300,
      contentWidth: 132,
      horizontalPadding: 4,
      isCompact: false,
      rows: 40,
    });
  });
});
