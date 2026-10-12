import { describe, expect, it } from "vitest";
import {
  AgentManager,
  AgentRegistry,
  Project,
  SandboxManager,
  Shell,
  analyzeShellCommand,
} from "./index.js";

describe("package entrypoint", () => {
  it("exports the MVP tool infrastructure modules", async () => {
    expect(Project.fromDirectory).toBeTypeOf("function");
    expect(AgentManager).toBeTypeOf("function");
    expect(AgentRegistry).toBeTypeOf("function");
    expect(SandboxManager).toBeTypeOf("function");
    expect(Shell.acceptable).toBeTypeOf("function");
    expect(
      (await analyzeShellCommand("echo ok", "bash")).commands[0]?.root,
    ).toBe("echo");
  });
});
