import { describe, expect, it } from "vitest";
import { parseSlashInput } from "../index.js";

describe("parseSlashInput", () => {
  it("returns null for non-slash input", () => {
    expect(parseSlashInput("hello there")).toBeNull();
    expect(parseSlashInput(" /status")).toBeNull();
  });

  it("parses a root command candidate", () => {
    expect(parseSlashInput("/model")).toMatchObject({
      body: "",
      commandLine: "model",
      path: ["model"],
      raw: "/model",
      rawArgs: "",
      segments: ["model"],
    });
  });

  it("preserves raw args and builds argv from the first command segment", () => {
    expect(
      parseSlashInput("/model switch anthropic claude-opus-4-7"),
    ).toMatchObject({
      path: ["model"],
      rawArgs: "switch anthropic claude-opus-4-7",
      argv: ["switch", "anthropic", "claude-opus-4-7"],
      segments: ["model", "switch", "anthropic", "claude-opus-4-7"],
    });
  });

  it("handles quoted argv values", () => {
    expect(parseSlashInput('/model switch openai "gpt 5.5"')).toMatchObject({
      argv: ["switch", "openai", "gpt 5.5"],
      segments: ["model", "switch", "openai", "gpt 5.5"],
    });
  });

  it("keeps multiline body separate from the command line", () => {
    expect(parseSlashInput("/status --json\nbody line 1\nbody line 2")).toEqual(
      expect.objectContaining({
        body: "body line 1\nbody line 2",
        commandLine: "status --json",
        rawArgs: "--json",
        argv: ["--json"],
      }),
    );
  });
});

