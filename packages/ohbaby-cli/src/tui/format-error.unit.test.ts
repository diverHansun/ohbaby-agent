import { describe, expect, it } from "vitest";
import { formatError } from "./format-error.js";

describe("TUI error formatting", () => {
  it("preserves stable error codes without loading the agent runtime", () => {
    expect(formatError({ code: "SESSION_NOT_FOUND", message: "Missing" })).toBe(
      "[SESSION_NOT_FOUND] Missing",
    );
    expect(formatError({ code: "private code", message: "Failed" })).toBe(
      "Failed",
    );
    expect(formatError(new Error("Native problem"))).toBe("Native problem");
    expect(formatError("plain")).toBe("plain");
  });

  it("never throws while inspecting hostile error-like objects", () => {
    expect(
      formatError({
        get code(): never {
          throw new Error("code getter exploded");
        },
        message: "Recoverable display",
      }),
    ).toBe("Recoverable display");
    expect(
      formatError({
        get message(): never {
          throw new Error("message getter exploded");
        },
      }),
    ).toBe("Unknown error");
    expect(
      formatError(
        new Proxy(
          {},
          {
            has(): never {
              throw new Error("proxy inspection exploded");
            },
          },
        ),
      ),
    ).toBe("Unknown error");
  });
});
