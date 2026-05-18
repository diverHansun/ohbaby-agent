import { describe, expect, it } from "vitest";
import { SystemPrompt } from "../assembler.js";
import type { EnvironmentInfo } from "../types.js";

const ENVIRONMENT: EnvironmentInfo = {
  cwd: "D:/repo",
  platform: "win32",
  date: "2026-05-17",
  isGitRepo: true,
};

describe("SystemPrompt", () => {
  it("assembles primary prompts from identity, full environment, custom instructions, and tools", () => {
    const prompts = SystemPrompt.assemble({
      agentName: "build",
      environment: ENVIRONMENT,
      customInstructions: ["Prefer Vitest for tests."],
      isSubagent: false,
      tools: ["read", "bash"],
    });
    const fullPrompt = prompts.join("\n\n");

    expect(fullPrompt).toContain("ohbaby-agent");
    expect(fullPrompt).toContain("Core Capabilities");
    expect(fullPrompt).toContain("D:/repo");
    expect(fullPrompt).toContain("Git repository: true");
    expect(fullPrompt).toContain("Available tools: read, bash");
    expect(fullPrompt).toContain("Prefer Vitest for tests.");
  });

  it("includes primary agent runtime prompts before custom instructions", () => {
    const prompts = SystemPrompt.assemble({
      agentName: "build",
      agentPrompt: "Primary agent runtime prompt.",
      customInstructions: ["Project custom instruction."],
      environment: ENVIRONMENT,
      isSubagent: false,
    });
    const fullPrompt = prompts.join("\n\n");

    expect(fullPrompt).toContain("Primary agent runtime prompt.");
    expect(fullPrompt.indexOf("Primary agent runtime prompt.")).toBeLessThan(
      fullPrompt.indexOf("Project custom instruction."),
    );
    expect(fullPrompt).toContain("Core Capabilities");
  });

  it("assembles subagent prompts without identity or custom instructions", () => {
    const prompts = SystemPrompt.assemble({
      agentName: "explore",
      agentPrompt: "You are a focused exploration agent.",
      environment: ENVIRONMENT,
      customInstructions: ["This must not leak to subagents."],
      isSubagent: true,
      tools: ["read"],
    });
    const fullPrompt = prompts.join("\n\n");

    expect(fullPrompt).toContain("focused exploration agent");
    expect(fullPrompt).toContain("D:/repo");
    expect(fullPrompt).toContain("Git repository: true");
    expect(fullPrompt).not.toContain("Core Capabilities");
    expect(fullPrompt).not.toContain("This must not leak");
    expect(fullPrompt).not.toContain("Available tools");
  });

  it("returns builtin agent prompts and undefined for unknown agents", () => {
    expect(SystemPrompt.getAgentPrompt("explore")).toContain("exploration");
    expect(SystemPrompt.getAgentPrompt("research")).toContain("research");
    expect(SystemPrompt.getAgentPrompt("unknown")).toBeUndefined();
  });

  it("rejects empty agent names", () => {
    expect(() =>
      SystemPrompt.assemble({
        agentName: "",
        environment: ENVIRONMENT,
        isSubagent: false,
      }),
    ).toThrow(/agentName/);
  });

  it("requires callers to declare the primary/subagent boundary", () => {
    expect(() =>
      SystemPrompt.assemble({
        agentName: "build",
        agentPrompt: "Primary agent runtime prompt.",
        environment: ENVIRONMENT,
      } as never),
    ).toThrow(/isSubagent/);
  });
});
