import { describe, expect, it } from "vitest";
import type { TuiCommandCatalog, TuiCommandSpec } from "../store/snapshot.js";
import {
  applySlashCompletion,
  filterCommandCatalog,
  parseSlashInput,
  resolveCommand,
} from "./runtime.js";

const catalog: TuiCommandCatalog = {
  commands: [
    command({
      description: "Show current model",
      id: "models",
      path: ["models"],
    }),
    command({
      acceptsArguments: true,
      description: "Resume a session",
      id: "resume",
      path: ["resume"],
    }),
    command({
      description: "Choose a session",
      id: "sessions",
      path: ["sessions"],
    }),
    command({
      description: "Start a new session",
      id: "new",
      path: ["new"],
    }),
    command({
      description: "Choose permission level",
      id: "permission",
      path: ["permission"],
    }),
  ],
  version: "v1",
};

describe("slash command runtime", () => {
  it("delegates slash parsing to the SDK parser", () => {
    const parsed = parseSlashInput('/resume   "session 1" --force');

    expect(parsed).toMatchObject({
      argv: ["session 1", "--force"],
      path: ["resume"],
      rawArgs: '"session 1" --force',
      segments: ["resume", "session 1", "--force"],
    });
  });

  it("returns not-slash for normal prompt text", () => {
    const result = resolveCommand(parseSlashInput("hello"), catalog, {
      surface: "tui",
    });

    expect(result).toMatchObject({
      kind: "not-slash",
      reason: "Input is not a slash command",
    });
  });

  it("resolves /models as the single model command", () => {
    const result = resolveCommand(parseSlashInput("/models"), catalog, {
      sessionId: "session_1",
      surface: "tui",
    });

    expect(result.kind).toBe("resolved");
    expect(result.kind === "resolved" ? result.invocation : null).toEqual(
      expect.objectContaining({
        argv: [],
        commandId: "models",
        path: ["models"],
        raw: "/models",
        rawArgs: "",
        sessionId: "session_1",
        surface: "tui",
      }),
    );
  });

  it("builds invocation args from SDK matched segments", () => {
    const result = resolveCommand(
      parseSlashInput('/resume   "session 1"'),
      catalog,
      {
        surface: "tui",
      },
    );

    expect(result.kind).toBe("resolved");
    expect(result.kind === "resolved" ? result.invocation.commandId : "").toBe(
      "resume",
    );
    expect(result.kind === "resolved" ? result.invocation.argv : []).toEqual([
      "session 1",
    ]);
    expect(result.kind === "resolved" ? result.invocation.rawArgs : "").toBe(
      '"session 1"',
    );
  });

  it("does not resolve removed slash commands", () => {
    for (const input of [
      "/model",
      "/model switch gpt-5.5",
      "/session list",
      "/session resume session_1",
      "/permission default",
      "/permission full-access",
    ]) {
      expect(
        resolveCommand(parseSlashInput(input), catalog, {
          surface: "tui",
        }),
      ).toMatchObject({
        kind: "not-found",
      });
    }
  });

  it("filters command catalog for slash hints through SDK semantics", () => {
    const matches = filterCommandCatalog(parseSlashInput("/ses"), catalog, {
      surface: "tui",
    });

    expect(matches.map((command) => command.id)).toEqual(["sessions"]);
  });

  it("applies tab completion without resolving or executing", () => {
    const completed = applySlashCompletion("/res", catalog, { surface: "tui" });

    expect(completed).toEqual("/resume ");
  });
});

function command(
  input: Pick<TuiCommandSpec, "description" | "id" | "path"> &
    Partial<TuiCommandSpec>,
): TuiCommandSpec {
  return {
    argumentMode: "argv",
    category: "system",
    source: "builtin",
    surfaces: ["tui"],
    ...input,
  };
}
