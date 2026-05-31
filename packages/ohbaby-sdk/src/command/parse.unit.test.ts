import { describe, expect, it } from "vitest";
import { parseSlashInput } from "../index.js";

describe("parseSlashInput", () => {
  it("returns null for non-slash input", () => {
    expect(parseSlashInput("hello there")).toBeNull();
    expect(parseSlashInput(" /status")).toBeNull();
  });

  it("parses a root command candidate", () => {
    expect(parseSlashInput("/models")).toMatchObject({
      body: "",
      commandLine: "models",
      path: ["models"],
      raw: "/models",
      rawArgs: "",
      segments: ["models"],
    });
  });

  it("preserves raw args and builds argv from the first command segment", () => {
    expect(parseSlashInput("/resume --session_id session_1")).toMatchObject({
      path: ["resume"],
      rawArgs: "--session_id session_1",
      argv: ["--session_id", "session_1"],
      segments: ["resume", "--session_id", "session_1"],
    });
  });

  it("handles quoted argv values", () => {
    expect(parseSlashInput('/resume "session 1"')).toMatchObject({
      argv: ["session 1"],
      segments: ["resume", "session 1"],
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
