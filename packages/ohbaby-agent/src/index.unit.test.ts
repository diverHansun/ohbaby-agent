import { describe, expect, it } from "vitest";
import {
  AgentManager,
  AgentRegistry,
  Project,
  SandboxManager,
  Shell,
  parseCommand,
} from "./index.js";

describe("package entrypoint", () => {
  it("exports the MVP tool infrastructure modules", () => {
    expect(Project.fromDirectory).toBeTypeOf("function");
    expect(AgentManager).toBeTypeOf("function");
    expect(AgentRegistry).toBeTypeOf("function");
    expect(SandboxManager).toBeTypeOf("function");
    expect(Shell.acceptable).toBeTypeOf("function");
    expect(parseCommand("echo ok").roots).toEqual(["echo"]);
  });
});
