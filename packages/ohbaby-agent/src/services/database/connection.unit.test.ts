import { afterEach, describe, expect, it, vi } from "vitest";
import { suppressNodeSqliteExperimentalWarning } from "./connection.js";

const originalEmitWarning = Reflect.get(process, "emitWarning");

function installEmitWarningRecorder(): {
  readonly emitWarning: ReturnType<typeof vi.fn>;
  readonly replacement: typeof process.emitWarning;
} {
  const emitWarning = vi.fn();
  const replacement = ((...args: unknown[]): void => {
    emitWarning(...args);
  }) as typeof process.emitWarning;
  process.emitWarning = replacement;
  return { emitWarning, replacement };
}

afterEach(() => {
  process.emitWarning = originalEmitWarning;
});

describe("NodeSqliteConnection", () => {
  it("suppresses only the node sqlite experimental warning while loading sqlite", () => {
    const { emitWarning, replacement } = installEmitWarningRecorder();

    const result = suppressNodeSqliteExperimentalWarning(() => {
      process.emitWarning(
        "SQLite is an experimental feature and might change at any time",
        "ExperimentalWarning",
      );
      return "loaded";
    });

    expect(result).toBe("loaded");
    expect(emitWarning).not.toHaveBeenCalled();
    expect(Reflect.get(process, "emitWarning")).toBe(replacement);
  });

  it("keeps unrelated warnings visible", () => {
    const { emitWarning } = installEmitWarningRecorder();

    suppressNodeSqliteExperimentalWarning(() => {
      process.emitWarning("Something else", "ExperimentalWarning");
    });

    expect(emitWarning).toHaveBeenCalledWith(
      "Something else",
      "ExperimentalWarning",
    );
  });
});
