import { describe, expect, it, vi } from "vitest";
import type { UiCommandRecord } from "ohbaby-sdk";
import { createStructuredUiCommandRecorder } from "./command-recorder.js";

function record(
  operationId: string,
  phase: "started" | "completed",
): UiCommandRecord {
  const base = {
    correlation: {},
    entryPoint: "agent-host" as const,
    method: "abortRun" as const,
    occurredAt: "2026-08-14T00:00:00.000Z",
    operationId,
  };
  return phase === "started"
    ? { ...base, phase }
    : { ...base, outcome: { kind: "returned" }, phase };
}

describe("createStructuredUiCommandRecorder", () => {
  it("delivers accepted records to an async sink in order", async () => {
    const delivered: string[] = [];
    const recorder = createStructuredUiCommandRecorder({
      capacity: 4,
      sink: async (entry) => {
        await Promise.resolve();
        delivered.push(`${entry.operationId}:${entry.phase}`);
      },
    });

    recorder.record(record("operation_1", "started"));
    recorder.record(record("operation_1", "completed"));
    await recorder.flush();

    expect(delivered).toEqual(["operation_1:started", "operation_1:completed"]);
  });

  it("rejects synchronously when its bounded intake is full", () => {
    const recorder = createStructuredUiCommandRecorder({
      capacity: 1,
      sink: () =>
        new Promise<void>(() => {
          // Intentionally never settles to exercise the bounded intake.
        }),
    });

    recorder.record(record("operation_1", "started"));

    expect(() => {
      recorder.record(record("operation_2", "started"));
    }).toThrow("UI command recorder queue is full");
  });

  it("contains sink and diagnostic failures", async () => {
    const diagnostic = vi.fn(() => {
      throw new Error("diagnostic failed");
    });
    const recorder = createStructuredUiCommandRecorder({
      onDiagnostic: diagnostic,
      sink: () => Promise.reject(new Error("sink failed")),
    });

    recorder.record(record("operation_1", "started"));
    await expect(recorder.flush()).resolves.toBeUndefined();
    expect(diagnostic).toHaveBeenCalledTimes(1);
  });

  it("does not expose caller-controlled error names in default diagnostics", async () => {
    const writes: string[] = [];
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk): boolean => {
        writes.push(String(chunk));
        return true;
      });
    const error = new Error("sink failed");
    error.name = "caller-secret-name";

    try {
      const recorder = createStructuredUiCommandRecorder({
        sink: () => Promise.reject(error),
      });

      recorder.record(record("operation_1", "started"));
      await recorder.flush();

      expect(writes.join("\n")).toContain('"name":"Error"');
      expect(writes.join("\n")).not.toContain("caller-secret-name");
    } finally {
      write.mockRestore();
    }
  });
});
