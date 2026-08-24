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
  it("keeps primary system stable and emits runtime context separately", async () => {
    const provider = createSystemPromptProvider({
      environmentDetector: vi.fn().mockResolvedValue(ENVIRONMENT),
      customInstructionLoader: vi.fn().mockResolvedValue(["Project-only rule"]),
    });

    const prompt = await provider.build({
      sessionId: "session_1",
      directory: "D:/repo",
      isSubagent: false,
      toolNames: ["read", "bash"],
    });
    const runtimeContext = await provider.buildRuntimeContext?.({
      sessionId: "session_1",
      directory: "D:/repo",
      isSubagent: false,
      toolNames: ["read", "bash"],
    });

    expect(prompt).toContain("Lychee");
    expect(prompt).toContain("Project-only rule");
    expect(prompt).not.toContain("D:/repo");
    expect(prompt).not.toContain("Available tools");
    expect(runtimeContext).toContain("D:/repo");
    expect(runtimeContext).not.toContain("Available tools");
  });

  it("places runtime provider content in the user-turn context only", async () => {
    const provider = createSystemPromptProvider({
      customInstructionLoader: vi.fn().mockResolvedValue([]),
      environmentDetector: vi.fn().mockResolvedValue(ENVIRONMENT),
      runtimePromptsProvider: vi
        .fn()
        .mockResolvedValue(["<mcp_tool_catalog>catalog</mcp_tool_catalog>"]),
    });
    const input = {
      sessionId: "session_1",
      directory: "D:/repo",
      isSubagent: false,
      toolNames: [] as readonly string[],
    };

    const system = await provider.build(input);
    const runtime = await provider.buildRuntimeContext?.(input);

    expect(system).not.toContain("mcp_tool_catalog");
    expect(system).not.toContain("environment_context");
    expect(runtime).toContain("environment_context");
    expect(runtime).toContain("mcp_tool_catalog");
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
      toolNames: [],
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
    });

    const prompt = await provider.build({
      sessionId: "session_2",
      directory: "D:/repo",
      isSubagent: true,
      toolNames: ["read"],
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
    });

    const prompt = await provider.build({
      sessionId: "session_1",
      directory: "D:/repo",
      isSubagent: false,
      toolNames: ["read", "grep"],
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
      toolNames: [],
    });
    const subagentPrompt = await provider.build({
      sessionId: "session_child",
      directory: "D:/repo",
      isSubagent: true,
      toolNames: [],
    });

    expect(primaryPrompt).toContain("Subagent roles for subagent_run");
    expect(primaryPrompt).toContain("Omit role to use generic");
    expect(subagentPrompt).not.toContain("Subagent roles for subagent_run");
    expect(availableSubagentRolesProvider).toHaveBeenCalledTimes(1);
  });

  it("keeps runtime-owned fragments out of the stable system prompt", async () => {
    const provider = createSystemPromptProvider({
      customInstructionLoader: vi.fn().mockResolvedValue([]),
      environmentDetector: vi.fn().mockResolvedValue(ENVIRONMENT),
      runtimePromptsProvider: vi
        .fn()
        .mockResolvedValue(["<runtime_prompt>MCP menu</runtime_prompt>"]),
    });

    const input = {
      sessionId: "session_1",
      directory: "D:/repo",
      isSubagent: false,
      toolNames: ["mcp_bad", "read"] as readonly string[],
    };
    const prompt = await provider.build(input);
    const runtime = await provider.buildRuntimeContext?.(input);

    expect(prompt).not.toContain("<runtime_prompt>MCP menu</runtime_prompt>");
    expect(runtime).toContain("<runtime_prompt>MCP menu</runtime_prompt>");
  });
});
