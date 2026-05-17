import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectEnvironment,
  generateEnvironmentPrompt,
} from "../layers/environment.js";
import type { EnvironmentInfo } from "../types.js";

const ENVIRONMENT: EnvironmentInfo = {
  cwd: "/repo",
  platform: "linux",
  date: "2026-05-17",
  isGitRepo: true,
  osVersion: "test-os",
};

describe("environment layer", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-env-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("renders full environment with cwd, platform, date, git status, os version, and tools", () => {
    const prompt = generateEnvironmentPrompt({
      info: ENVIRONMENT,
      minimal: false,
      tools: ["read", "grep"],
    });

    expect(prompt).toContain("Current working directory: /repo");
    expect(prompt).toContain("Platform: linux");
    expect(prompt).toContain("OS version: test-os");
    expect(prompt).toContain("Date: 2026-05-17");
    expect(prompt).toContain("Git repository: true");
    expect(prompt).toContain("Available tools: read, grep");
  });

  it("renders minimal environment without tools but still includes git status", () => {
    const prompt = generateEnvironmentPrompt({
      info: ENVIRONMENT,
      minimal: true,
      tools: ["read", "grep"],
    });

    expect(prompt).toContain("Current working directory: /repo");
    expect(prompt).toContain("Git repository: true");
    expect(prompt).not.toContain("Available tools");
    expect(prompt).not.toContain("OS version");
  });

  it("detects environment through injectable probes", async () => {
    const isGitRepo = vi.fn().mockResolvedValue(true);

    await expect(
      detectEnvironment(tempDir, {
        isGitRepo,
        now: () => new Date("2026-05-17T08:00:00.000Z"),
        platform: "win32",
        osVersion: () => "Windows Test",
      }),
    ).resolves.toEqual({
      cwd: tempDir,
      platform: "win32",
      date: "2026-05-17",
      isGitRepo: true,
      osVersion: "Windows Test",
    });
    expect(isGitRepo).toHaveBeenCalledWith(tempDir);
  });

  it("detects git repositories by walking upward from the working directory", async () => {
    const nested = path.join(tempDir, "repo", "src", "feature");
    await fs.mkdir(path.join(tempDir, "repo", ".git"), { recursive: true });
    await fs.mkdir(nested, { recursive: true });

    await expect(detectEnvironment(nested)).resolves.toMatchObject({
      cwd: nested,
      isGitRepo: true,
    });
  });
});
