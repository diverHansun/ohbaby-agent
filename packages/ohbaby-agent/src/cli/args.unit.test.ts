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

  it("parses initial permission mode and level flags", () => {
    expect(
      parseCliArgs([
        "node",
        "ohbaby",
        "--mode",
        "plan",
        "--permission=full-access",
      ]),
    ).toEqual({
      mode: "interactive",
      permissionLevel: "full-access",
      permissionMode: "plan",
    });
    expect(
      parseCliArgs([
        "node",
        "ohbaby",
        "--prompt",
        "hello",
        "--mode=auto",
        "--permission",
        "default",
      ]),
    ).toEqual({
      mode: "prompt",
      permissionLevel: "default",
      permissionMode: "auto",
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
    expect(() => parseCliArgs(["node", "ohbaby", "--mode", "ask"])).toThrow(
      CliArgumentError,
    );
    expect(() =>
      parseCliArgs(["node", "ohbaby", "--permission", "auto"]),
    ).toThrow(CliArgumentError);
  });

  it("defaults to interactive mode", () => {
    expect(parseCliArgs(["node", "ohbaby"])).toEqual({
      mode: "interactive",
    });
  });
});
