import { describe, expect, it } from "vitest";
import {
  getOptionalNonEmptyStringParam,
  getRequiredNonEmptyStringParam,
  optionalEnum,
  ToolParameterError,
} from "./params.js";

describe("tool parameter helpers", () => {
  it("reads required and optional non-empty strings", () => {
    expect(
      getRequiredNonEmptyStringParam({ prompt: "Find files" }, "prompt"),
    ).toBe("Find files");
    expect(
      getOptionalNonEmptyStringParam({ description: "Explore files" }, "description"),
    ).toBe("Explore files");
    expect(getOptionalNonEmptyStringParam({}, "description")).toBeUndefined();
  });

  it("rejects missing, empty, and non-string values", () => {
    expect(() => getRequiredNonEmptyStringParam({}, "prompt")).toThrow(
      'Expected parameter "prompt" to be a non-empty string.',
    );
    expect(() =>
      getRequiredNonEmptyStringParam({ prompt: "  " }, "prompt"),
    ).toThrow('Expected parameter "prompt" to be a non-empty string.');
    expect(() =>
      getOptionalNonEmptyStringParam({ description: 7 }, "description"),
    ).toThrow(
      'Expected parameter "description" to be a non-empty string when provided.',
    );
  });

  it("defaults optional enums and returns allowed values", () => {
    const allowed = ["generic", "explore", "research"] as const;

    expect(
      optionalEnum({}, "role", allowed, {
        defaultValue: "generic",
        invalidMessage: () => "bad role",
      }),
    ).toBe("generic");
    expect(
      optionalEnum({ role: "research" }, "role", allowed, {
        defaultValue: "generic",
        invalidMessage: () => "bad role",
      }),
    ).toBe("research");
  });

  it("rejects optional enum values with the supplied message", () => {
    const allowed = ["generic", "explore", "research"] as const;

    expect(() =>
      optionalEnum({ role: "plan" }, "role", allowed, {
        defaultValue: "generic",
        invalidMessage: (value) => `bad ${value}`,
      }),
    ).toThrow(new ToolParameterError("bad plan"));
    expect(() =>
      optionalEnum({ role: { custom: true } }, "role", allowed, {
        defaultValue: "generic",
        invalidMessage: (value) => `bad ${value}`,
      }),
    ).toThrow(new ToolParameterError("bad object"));
  });
});
