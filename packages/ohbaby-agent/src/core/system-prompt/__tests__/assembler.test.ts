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

    expect(fullPrompt).toContain("Lychee");
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

  it("includes the selected primary task contract", () => {
    const prompts = SystemPrompt.assemble({
      agentName: "build",
      environment: ENVIRONMENT,
      isSubagent: false,
      taskKind: "plan",
      tools: ["read", "grep"],
    });

    const fullPrompt = prompts.join("\n\n");
    expect(fullPrompt).toContain("<primary_task>");
    expect(fullPrompt).toContain("Task: plan");
    expect(fullPrompt).toContain(
      "Prefer analysis and read-only exploration unless the user explicitly asks to execute changes.",
    );
  });

  it("treats agentPrompt as an add-on instead of replacing defaults", () => {
    const prompts = SystemPrompt.assemble({
      agentName: "build",
      agentPrompt: "Use extra release-note care.",
      environment: ENVIRONMENT,
      isSubagent: false,
      taskKind: "agent",
    });

    const fullPrompt = prompts.join("\n\n");
    expect(fullPrompt).toContain("You are Lychee");
    expect(fullPrompt).toContain("Task: agent");
    expect(fullPrompt).toContain("<agent_prompt_addon>");
    expect(fullPrompt).toContain("Use extra release-note care.");
  });

  it("keeps primary prompt layers in the documented order", () => {
    const prompts = SystemPrompt.assemble({
      agentName: "build",
      agentPromptAddon: "Primary addon.",
      customInstructions: ["Project rule."],
      environment: ENVIRONMENT,
      isSubagent: false,
      taskKind: "agent",
      toolSnippets: {
        read: "Read one text file.",
      },
      tools: ["read"],
    });

    expect(prompts).toHaveLength(6);
    expect(prompts[0]).toContain("# Identity");
    expect(prompts[1]).toContain("<primary_task>");
    expect(prompts[2]).toContain("<agent_prompt_addon>");
    expect(prompts[3]).toContain("<tool_guidance>");
    expect(prompts[4]).toContain("<environment>");
    expect(prompts[5]).toContain("<custom_instructions>");
  });

  it("adds subagent role guidance to primary prompts", () => {
    const prompts = SystemPrompt.assemble({
      agentName: "build",
      availableSubagentRoles: [
        {
          default: true,
          description: "Default general-purpose subagent",
          role: "generic",
        },
        { description: "Fast code exploration", role: "explore" },
        { description: "Deep research", role: "research" },
      ],
      environment: ENVIRONMENT,
      isSubagent: false,
    });
    const fullPrompt = prompts.join("\n\n");

    expect(fullPrompt).toContain("Subagent roles for task / agent_open");
    expect(fullPrompt).toContain("- generic (default)");
    expect(fullPrompt).toContain("- explore");
    expect(fullPrompt).toContain("- research");
    expect(fullPrompt).toContain("Omit role to use generic");
    expect(fullPrompt).toContain("description and name are metadata only");
    expect(fullPrompt).toContain(
      "build and plan are primary-agent modes, not subagent roles",
    );
  });

  it("assembles subagent prompts without identity or custom instructions", () => {
    const prompts = SystemPrompt.assemble({
      agentName: "explore",
      agentPrompt: "You are a focused exploration agent.",
      availableSubagentRoles: [
        {
          default: true,
          description: "Default general-purpose subagent",
          role: "generic",
        },
      ],
      environment: ENVIRONMENT,
      customInstructions: ["This must not leak to subagents."],
      isSubagent: true,
      tools: ["read"],
    });
    const fullPrompt = prompts.join("\n\n");

    expect(fullPrompt).toContain("focused exploration agent");
    expect(fullPrompt).toContain("D:/repo");
    expect(fullPrompt).toContain("Git repository: true");
    expect(fullPrompt).toContain("Core Capabilities");
    expect(fullPrompt).not.toContain("This must not leak");
    expect(fullPrompt).not.toContain("Available tools");
    expect(fullPrompt).not.toContain("Subagent roles for task / agent_open");
    // Primary identity must not leak into subagent prompts. "Core Capabilities"
    // is now shared by both bases, so guard with a primary-only sentinel.
    expect(fullPrompt).not.toContain("You are Lychee, an AI coding assistant");
  });

  it("keeps subagent prompt layers in the documented order", () => {
    const prompts = SystemPrompt.assemble({
      agentName: "explore",
      agentPromptAddon: "Subagent addon.",
      environment: ENVIRONMENT,
      isSubagent: true,
      taskKind: "explore",
      toolSnippets: {
        read: "Read one text file.",
      },
      tools: ["read"],
    });

    expect(prompts).toHaveLength(5);
    expect(prompts[0]).toContain("<subagent_base>");
    expect(prompts[1]).toContain("<subagent_task>");
    expect(prompts[2]).toContain("<agent_prompt_addon>");
    expect(prompts[3]).toContain("<tool_guidance>");
    expect(prompts[4]).toContain("<environment>");
  });

  it("includes the selected subagent task contract", () => {
    const prompts = SystemPrompt.assemble({
      agentName: "explore",
      environment: ENVIRONMENT,
      isSubagent: true,
      taskKind: "explore",
      tools: ["read", "grep"],
    });

    const fullPrompt = prompts.join("\n\n");
    expect(fullPrompt).toContain("<subagent_task>");
    expect(fullPrompt).toContain("Task: explore");
    expect(fullPrompt).toContain("quickly find, inspect, and summarize");
  });

  it("does not allow subagent prompts to resolve plan task kind", () => {
    const prompts = SystemPrompt.assemble({
      agentName: "generic",
      environment: ENVIRONMENT,
      isSubagent: true,
      taskKind: "plan",
    });
    const fullPrompt = prompts.join("\n\n");

    expect(fullPrompt).not.toContain("Task: plan");
    expect(fullPrompt).toContain("Task: generic");
  });

  it("does not include primary custom instructions in subagent prompts", () => {
    const prompts = SystemPrompt.assemble({
      agentName: "research",
      customInstructions: ["Project-only rule"],
      environment: ENVIRONMENT,
      isSubagent: true,
      taskKind: "research",
    });

    const fullPrompt = prompts.join("\n\n");
    expect(fullPrompt).toContain("Task: research");
    expect(fullPrompt).not.toContain("Project-only rule");
    expect(fullPrompt).not.toContain("You are Lychee");
  });

  it("returns builtin agent prompts and undefined for unknown agents", () => {
    expect(SystemPrompt.getAgentPrompt("generic")).toContain("generic");
    expect(SystemPrompt.getAgentPrompt("explore")).toContain("exploration");
    expect(SystemPrompt.getAgentPrompt("research")).toContain("research");
    expect(SystemPrompt.getAgentPrompt("plan")).toBeUndefined();
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
