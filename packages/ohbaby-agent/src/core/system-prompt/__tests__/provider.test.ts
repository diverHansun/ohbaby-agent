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

    expect(prompt).toContain("ohbaby-agent");
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

    expect(prompt).toContain("ohbaby-agent");
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
    expect(prompt).not.toContain("Core Capabilities");
    expect(customInstructionLoader).not.toHaveBeenCalled();
  });
});
