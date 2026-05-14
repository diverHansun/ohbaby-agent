import { describe, expect, it } from "vitest";
import { CliArgumentError, parseCliArgs } from "./args.js";

describe("parseCliArgs", () => {
  it("parses help and version flags", () => {
    expect(parseCliArgs(["node", "ohbaby", "--help"])).toEqual({
      mode: "help",
    });
    expect(parseCliArgs(["node", "ohbaby", "-v"])).toEqual({
      mode: "version",
    });
  });

  it("parses prompt flags", () => {
    expect(parseCliArgs(["node", "ohbaby", "-p", "hello"])).toEqual({
      mode: "prompt",
      prompt: "hello",
    });
    expect(parseCliArgs(["node", "ohbaby", "--prompt=hello"])).toEqual({
      mode: "prompt",
      prompt: "hello",
    });
  });

  it("throws on missing prompt values and unknown flags", () => {
    expect(() => parseCliArgs(["node", "ohbaby", "-p"])).toThrow(
      CliArgumentError,
    );
    expect(() => parseCliArgs(["node", "ohbaby", "--wat"])).toThrow(
      CliArgumentError,
    );
  });

  it("defaults to interactive mode", () => {
    expect(parseCliArgs(["node", "ohbaby"])).toEqual({
      mode: "interactive",
    });
  });
});

