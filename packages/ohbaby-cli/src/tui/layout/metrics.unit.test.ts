import { describe, expect, it } from "vitest";
import { computeLayoutMetrics } from "./metrics.js";

describe("computeLayoutMetrics", () => {
  it("uses compact padding below 80 columns", () => {
    expect(computeLayoutMetrics({ columns: 60, rows: 30 })).toEqual({
      columns: 60,
      contentWidth: 56,
      horizontalPadding: 2,
      isCompact: true,
      liveTailRows: 20,
      rows: 30,
    });
  });

  it("uses the available width on ordinary wide terminals", () => {
    expect(computeLayoutMetrics({ columns: 180, rows: 40 })).toEqual({
      columns: 180,
      contentWidth: 172,
      horizontalPadding: 4,
      isCompact: false,
      liveTailRows: 30,
      rows: 40,
    });
  });

  it("uses regular padding and caps ultra-wide content", () => {
    expect(computeLayoutMetrics({ columns: 300, rows: 40 })).toEqual({
      columns: 300,
      contentWidth: 220,
      horizontalPadding: 4,
      isCompact: false,
      liveTailRows: 30,
      rows: 40,
    });
  });

  it("keeps a minimum live tail height on tiny terminals", () => {
    expect(computeLayoutMetrics({ columns: 80, rows: 8 }).liveTailRows).toBe(3);
  });

  it("falls back to default dimensions when the stream reports none", () => {
    const metrics = computeLayoutMetrics({
      columns: Number.NaN,
      rows: Number.NaN,
    });

    expect(metrics.columns).toBe(80);
    expect(metrics.rows).toBe(24);
    expect(metrics.liveTailRows).toBe(14);
  });
});
