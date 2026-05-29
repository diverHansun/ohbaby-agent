import { describe, expect, it } from "vitest";
import { formatUnknown } from "./runtime-format.js";

describe("formatUnknown", () => {
  it("formats errors, primitives, functions, symbols, and objects for runtime notices", () => {
    function namedFunction(): void {
      return undefined;
    }
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(formatUnknown(new Error("boom"))).toBe("boom");
    expect(formatUnknown("plain")).toBe("plain");
    expect(formatUnknown(42)).toBe("42");
    expect(formatUnknown(false)).toBe("false");
    expect(formatUnknown(null)).toBe("null");
    expect(formatUnknown(undefined)).toBe("undefined");
    expect(formatUnknown(Symbol("marker"))).toBe("marker");
    expect(formatUnknown(namedFunction)).toBe("[function namedFunction]");
    expect(formatUnknown({ a: 1 })).toBe('{"a":1}');
    expect(formatUnknown(circular)).toBe("[object Object]");
  });
});
