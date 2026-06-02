import { describe, expect, it } from "vitest";
import { parseSlashCommandInput } from "../index.js";

describe("parseSlashCommandInput", () => {
  it("returns null for non-slash input", () => {
    expect(parseSlashCommandInput("hello there")).toBeNull();
    expect(parseSlashCommandInput(" /status")).toBeNull();
  });

  it("parses a root command candidate", () => {
    expect(parseSlashCommandInput("/models")).toMatchObject({
      body: "",
      commandLine: "models",
      raw: "/models",
      rawArgs: "",
      segments: ["models"],
    });
    expect(parseSlashCommandInput("/models")).not.toHaveProperty("path");
  });

  it("preserves raw args and builds argv from the first command segment", () => {
    expect(
      parseSlashCommandInput("/resume --session_id session_1"),
    ).toMatchObject({
      rawArgs: "--session_id session_1",
      argv: ["--session_id", "session_1"],
      segments: ["resume", "--session_id", "session_1"],
    });
  });

  it("handles quoted argv values", () => {
    expect(parseSlashCommandInput('/resume "session 1"')).toMatchObject({
      argv: ["session 1"],
      segments: ["resume", "session 1"],
    });
  });

  it("keeps multiline body separate from the command line", () => {
    expect(
      parseSlashCommandInput("/status --json\nbody line 1\nbody line 2"),
    ).toEqual(
      expect.objectContaining({
        body: "body line 1\nbody line 2",
        commandLine: "status --json",
        rawArgs: "--json",
        argv: ["--json"],
      }),
    );
  });
});
