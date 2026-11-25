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
    expect(prompt).not.toContain("D:/repo");
    expect(prompt).not.toContain("Available tools");
    expect(environment).toEqual(ENVIRONMENT);
  });

  it("adds primary agent prompts without switching to subagent assembly", async () => {
    const provider = createSystemPromptProvider({
      agentNameResolver: vi.fn().mockResolvedValue("build"),
      agentPromptResolver: vi.fn().mockResolvedValue("Primary runtime prompt"),
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
  });

  it.each([false, true])(
    "keeps system bytes stable across file changes (isSubagent=%s)",
    async (isSubagent) => {
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "ohbaby-provider-"),
      );
      try {
        const input = {
          sessionId: "session",
          directory,
          isSubagent,
          toolNames: [],
        };
        const provider = createSystemPromptProvider();
        const original = await provider.build(input);
        await fs.writeFile(
          path.join(directory, "AGENTS.md"),
          "Project rule marker.",
        );
        expect(await provider.build(input)).toBe(original);
        expect(original).not.toContain("Project rule marker.");
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  );

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

    expect(primaryPrompt).toContain("Subagent roles for agent spawn");
    expect(primaryPrompt).toContain("Omit role to use generic");
    expect(subagentPrompt).not.toContain("Subagent roles for agent spawn");
    expect(availableSubagentRolesProvider).toHaveBeenCalledTimes(1);
  });

  it("detects the execution directory for a subagent running below the project root", async () => {
    const provider = createSystemPromptProvider({
      environmentDetector: (directory) => ({ ...ENVIRONMENT, cwd: directory }),
    });
    const input = {
      sessionId: "session_1",
      directory: "/execution/child",
      projectRoot: "/project",
      isSubagent: true,
      toolNames: [],
    };
    expect(await provider.detectEnvironment?.(input)).toMatchObject({
      cwd: "/execution/child",
    });
  });
});
