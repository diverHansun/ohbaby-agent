import { describe, expect, it, vi } from "vitest";
import { createSystemPromptProvider } from "../assembler.js";
import type { EnvironmentInfo } from "../types.js";

const ENVIRONMENT: EnvironmentInfo = {
  cwd: "D:/repo",
  platform: "win32",
  date: "2026-05-17",
  isGitRepo: true,
};

describe("createSystemPromptProvider", () => {
  it("adapts system-prompt assembly to ContextManager primary provider input", async () => {
    const provider = createSystemPromptProvider({
      environmentDetector: vi.fn().mockResolvedValue(ENVIRONMENT),
      customInstructionLoader: vi.fn().mockResolvedValue(["Project-only rule"]),
      toolsProvider: vi.fn().mockResolvedValue(["read", "bash"]),
    });

    const prompt = await provider.build({
      sessionId: "session_1",
      directory: "D:/repo",
      isSubagent: false,
    });

    expect(prompt).toContain("Lychee");
    expect(prompt).toContain("Project-only rule");
    expect(prompt).toContain("Available tools: read, bash");
  });

  it("adds primary agent prompts without switching to subagent assembly", async () => {
    const provider = createSystemPromptProvider({
      agentNameResolver: vi.fn().mockResolvedValue("build"),
      agentPromptResolver: vi.fn().mockResolvedValue("Primary runtime prompt"),
      customInstructionLoader: vi.fn().mockResolvedValue(["Project rule"]),
      environmentDetector: vi.fn().mockResolvedValue(ENVIRONMENT),
    });

    const prompt = await provider.build({
      sessionId: "session_1",
      directory: "D:/repo",
      isSubagent: false,
    });

    expect(prompt).toContain("Lychee");
    expect(prompt).toContain("Primary runtime prompt");
    expect(prompt).toContain("Project rule");
  });

  it("does not load custom instructions for subagents", async () => {
    const customInstructionLoader = vi
      .fn()
      .mockResolvedValue(["This must not be loaded"]);
    const provider = createSystemPromptProvider({
      agentNameResolver: vi.fn().mockResolvedValue("explore"),
      environmentDetector: vi.fn().mockResolvedValue(ENVIRONMENT),
      customInstructionLoader,
      toolsProvider: vi.fn().mockResolvedValue(["read"]),
    });

    const prompt = await provider.build({
      sessionId: "session_2",
      directory: "D:/repo",
      isSubagent: true,
    });

    expect(prompt).toContain("exploration");
    expect(prompt).not.toContain("This must not be loaded");
    expect(prompt).toContain("Core Capabilities");
    expect(prompt).not.toContain("You are Lychee, an AI coding assistant");
    expect(customInstructionLoader).not.toHaveBeenCalled();
  });

  it("resolves primary task kind through the provider", async () => {
    const provider = createSystemPromptProvider({
      environmentDetector: vi.fn().mockResolvedValue(ENVIRONMENT),
      taskKindResolver: vi.fn().mockResolvedValue("plan"),
      toolsProvider: vi.fn().mockResolvedValue(["read", "grep"]),
    });

    const prompt = await provider.build({
      sessionId: "session_1",
      directory: "D:/repo",
      isSubagent: false,
    });

    expect(prompt).toContain("Task: plan");
    expect(prompt).toContain(
      "Prefer analysis and read-only exploration unless the user explicitly asks to execute changes.",
    );
  });

  it("injects subagent role guidance for primary prompts only", async () => {
    const availableSubagentRolesProvider = vi.fn().mockResolvedValue([
      {
        default: true,
        description: "Default general-purpose subagent",
        role: "generic",
      },
      { description: "Fast code exploration", role: "explore" },
      { description: "Deep research", role: "research" },
    ]);
    const provider = createSystemPromptProvider({
      availableSubagentRolesProvider,
      customInstructionLoader: vi.fn().mockResolvedValue([]),
      environmentDetector: vi.fn().mockResolvedValue(ENVIRONMENT),
    });

    const primaryPrompt = await provider.build({
      sessionId: "session_primary",
      directory: "D:/repo",
      isSubagent: false,
    });
    const subagentPrompt = await provider.build({
      sessionId: "session_child",
      directory: "D:/repo",
      isSubagent: true,
    });

    expect(primaryPrompt).toContain("Subagent roles for subagent_run");
    expect(primaryPrompt).toContain("Omit role to use generic");
    expect(subagentPrompt).not.toContain("Subagent roles for subagent_run");
    expect(availableSubagentRolesProvider).toHaveBeenCalledTimes(1);
  });

  it("announces unloaded MCP tools by exact name without tool descriptions", async () => {
    const provider = createSystemPromptProvider({
      customInstructionLoader: vi.fn().mockResolvedValue([]),
      environmentDetector: vi.fn().mockResolvedValue(ENVIRONMENT),
      mcpToolNamesProvider: vi
        .fn()
        .mockResolvedValue(["mcp_s7_example_t6_search"]),
      toolsProvider: vi.fn().mockResolvedValue(["mcp_bad", "read"]),
    });

    const prompt = await provider.build({
      sessionId: "session_1",
      directory: "D:/repo",
      isSubagent: false,
    });

    expect(prompt).toContain("<mcp_tools>");
    expect(prompt).toContain("- mcp_s7_example_t6_search");
    expect(prompt).toContain("Use select_tools with exact names");
    expect(prompt).not.toContain("MCP tool metadata failed");
  });
});
