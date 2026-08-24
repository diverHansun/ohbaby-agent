import { describe, expect, it, vi } from "vitest";
import {
  aggregateCacheGateResults,
  exitCodeForCacheGateAggregate,
  formatCacheGateAggregate,
  REAL_CACHE_GATES,
  runCacheGates,
} from "../../scripts/real-cache-runner.mjs";

describe("real cache runner", () => {
  it("reports every external gate as skip without credentials", async () => {
    const executeGate = vi.fn();

    const results = await runCacheGates({
      env: {},
      executeGate,
      gates: REAL_CACHE_GATES,
    });

    expect(results.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "openai-compatible", status: "skip" },
      { id: "anthropic", status: "skip" },
      { id: "m13", status: "skip" },
    ]);
    expect(executeGate).not.toHaveBeenCalled();
    expect(aggregateCacheGateResults(results)).toBe("skip");
  });

  it("turns an enabled gate configuration or test error into fail", async () => {
    const gate = REAL_CACHE_GATES[0];
    if (!gate) {
      throw new Error("missing OpenAI-compatible gate fixture");
    }

    const results = await runCacheGates({
      env: { OPENAI_API_KEY: "test-only" },
      executeGate: () => Promise.reject(new Error("missing model config")),
      gates: [gate],
    });

    expect(results).toEqual([
      {
        id: "openai-compatible",
        reason: "missing model config",
        status: "fail",
      },
    ]);
    expect(aggregateCacheGateResults(results)).toBe("fail");
  });

  it("executes provider gates serially and fails the aggregate if one fails", async () => {
    const execution: string[] = [];
    const releaseFirst = Promise.withResolvers<void>();
    const executeGate = vi.fn(async (gate: { readonly id: string }) => {
      execution.push(`start:${gate.id}`);
      if (gate.id === "openai-compatible") {
        await releaseFirst.promise;
      }
      execution.push(`end:${gate.id}`);
      return gate.id === "anthropic" ? 1 : 0;
    });
    const run = runCacheGates({
      env: {
        ANTHROPIC_API_KEY: "test-only",
        OPENAI_API_KEY: "test-only",
      },
      executeGate,
      gates: REAL_CACHE_GATES.slice(0, 2),
    });

    await vi.waitFor(() => {
      expect(execution).toEqual(["start:openai-compatible"]);
    });
    releaseFirst.resolve();
    const results = await run;

    expect(execution).toEqual([
      "start:openai-compatible",
      "end:openai-compatible",
      "start:anthropic",
      "end:anthropic",
    ]);
    expect(aggregateCacheGateResults(results)).toBe("fail");
  });

  it("keeps an uncredentialed M13 skip external to the local G5 result", async () => {
    const m13 = REAL_CACHE_GATES.find((gate) => gate.id === "m13");
    if (!m13) {
      throw new Error("missing M13 gate fixture");
    }

    const results = await runCacheGates({
      env: {},
      executeGate: vi.fn(),
      gates: [m13],
    });

    expect(results).toEqual([
      expect.objectContaining({ id: "m13", status: "skip" }),
    ]);
    expect(aggregateCacheGateResults(results)).toBe("skip");
  });

  it("reports pass only when every selected external gate passes", () => {
    expect(
      aggregateCacheGateResults([
        { id: "openai-compatible", status: "pass" },
        { id: "anthropic", status: "pass" },
        { id: "m13", status: "pass" },
      ]),
    ).toBe("pass");
    expect(formatCacheGateAggregate("pass")).toBe("pass");
    expect(formatCacheGateAggregate("skip")).toBe("skip (partial evidence)");
    expect(exitCodeForCacheGateAggregate("pass")).toBe(0);
    expect(exitCodeForCacheGateAggregate("skip")).toBe(0);
    expect(exitCodeForCacheGateAggregate("fail")).toBe(1);
  });
});
