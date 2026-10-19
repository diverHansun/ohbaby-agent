import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
  it("keeps primary system stable and exposes detected environment separately", async () => {
    const provider = createSystemPromptProvider({
      environmentDetector: vi.fn().mockResolvedValue(ENVIRONMENT),
      customInstructionLoader: vi
        .fn()
        .mockResolvedValue([{ scope: "project", text: "Project-only rule" }]),
    });

    const prompt = await provider.build({
      sessionId: "session_1",
      directory: "D:/repo",
      isSubagent: false,
      toolNames: ["read", "bash"],
    });
    const environment = await provider.detectEnvironment?.({
      sessionId: "session_1",
      directory: "D:/repo",
      isSubagent: false,
      toolNames: ["read", "bash"],
    });

    expect(prompt).toContain("Lychee");
    expect(prompt).toContain("Project-only rule");
    expect(prompt).not.toContain("D:/repo");
    expect(prompt).not.toContain("Available tools");
    expect(environment).toEqual(ENVIRONMENT);
  });

  it("adds primary agent prompts without switching to subagent assembly", async () => {
    const provider = createSystemPromptProvider({
      agentNameResolver: vi.fn().mockResolvedValue("build"),
      agentPromptResolver: vi.fn().mockResolvedValue("Primary runtime prompt"),
      customInstructionLoader: vi
        .fn()
        .mockResolvedValue([{ scope: "project", text: "Project rule" }]),
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

  it("loads custom instructions for subagents from the session project root", async () => {
    const customInstructionLoader = vi
      .fn()
      .mockResolvedValue([{ scope: "project", text: "Subagent project rule" }]);
    const provider = createSystemPromptProvider({
      agentNameResolver: vi.fn().mockResolvedValue("explore"),
      environmentDetector: vi.fn().mockResolvedValue(ENVIRONMENT),
      customInstructionLoader,
    });
    const input = {
      sessionId: "session_2",
      directory: "D:/repo/packages/worktree",
      projectRoot: "D:/repo",
      isSubagent: true,
      toolNames: ["read"] as readonly string[],
    };

    const prompt = await provider.build(input);

    expect(prompt).toContain("exploration");
    expect(prompt).toContain("Subagent project rule");
    expect(prompt.indexOf("<agent_prompt_addon>")).toBeLessThan(
      prompt.indexOf("Subagent project rule"),
    );
    expect(prompt).toContain("Core Capabilities");
    expect(prompt).not.toContain("You are Lychee, an AI coding assistant");
    expect(customInstructionLoader).toHaveBeenCalledWith(input);
  });

  it("reads default instruction files from projectRoot instead of the subagent workdir", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-provider-"));
    try {
      const workdir = path.join(root, "nested", "workdir");
      await fs.mkdir(workdir, { recursive: true });
      await fs.writeFile(path.join(root, "AGENTS.md"), "ROOT_RULE", "utf8");
      await fs.writeFile(
        path.join(workdir, "AGENTS.md"),
        "WORKDIR_RULE",
        "utf8",
      );
      const previousHome = process.env.OHBABY_HOME;
      process.env.OHBABY_HOME = path.join(root, "empty-home");
      try {
        const provider = createSystemPromptProvider({
          agentNameResolver: vi.fn().mockResolvedValue("generic"),
        });
        const prompt = await provider.build({
          sessionId: "session_child",
          directory: workdir,
          projectRoot: root,
          isSubagent: true,
          toolNames: [],
        });

        expect(prompt).toContain("## Project Instructions\nROOT_RULE");
        expect(prompt).not.toContain("WORKDIR_RULE");
      } finally {
        if (previousHome === undefined) delete process.env.OHBABY_HOME;
        else process.env.OHBABY_HOME = previousHome;
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses stable primary mode definitions even when a resolver returns plan", async () => {
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

    expect(prompt).toContain("plan mode");
    expect(prompt).toContain("auto mode");
    expect(prompt).not.toContain("Task: plan");
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

  it("detects the execution directory while instructions retain the project root", async () => {
    const provider = createSystemPromptProvider({
      customInstructionLoader: (input) => [
        {
          scope: "project",
          text: `Rules for ${input.projectRoot ?? input.directory}`,
        },
      ],
      environmentDetector: (directory) => ({ ...ENVIRONMENT, cwd: directory }),
    });
    const input = {
      sessionId: "session_1",
      directory: "/execution/child",
      projectRoot: "/project",
      isSubagent: true,
      toolNames: [],
    };
    expect(await provider.build(input)).toContain("Rules for /project");
    expect(await provider.detectEnvironment?.(input)).toMatchObject({
      cwd: "/execution/child",
    });
  });
});
