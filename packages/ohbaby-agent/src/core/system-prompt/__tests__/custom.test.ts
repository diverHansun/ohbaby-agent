import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  generateCustomInstructionsPrompt,
  loadCustomInstructions,
} from "../layers/custom.js";

describe("custom instruction layer", () => {
  let tempDir: string;
  let projectPath: string;
  let globalPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-prompt-"));
    projectPath = path.join(tempDir, "repo", "OHBABY.md");
    globalPath = path.join(tempDir, "home", ".ohbaby-agent", "OHBABY.md");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("loads project and global OHBABY.md in project-first order", async () => {
    await fs.mkdir(path.dirname(projectPath), { recursive: true });
    await fs.mkdir(path.dirname(globalPath), { recursive: true });
    await fs.writeFile(projectPath, "# Project\nUse pnpm", "utf8");
    await fs.writeFile(globalPath, "# Global\nUse TypeScript", "utf8");

    const instructions = await loadCustomInstructions({
      projectPath,
      globalPath,
    });

    expect(instructions).toEqual([
      "# Project\nUse pnpm",
      "# Global\nUse TypeScript",
    ]);
  });

  it("falls back to .ohbaby-agent/OHBABY.md when project root instructions are absent", async () => {
    const projectDirectory = path.join(tempDir, "repo");
    const configProjectPath = path.join(
      projectDirectory,
      ".ohbaby-agent",
      "OHBABY.md",
    );
    await fs.mkdir(path.dirname(configProjectPath), { recursive: true });
    await fs.writeFile(configProjectPath, "# Project Config", "utf8");

    const instructions = await loadCustomInstructions({
      projectDirectory,
      globalPath,
    });

    expect(instructions).toEqual(["# Project Config"]);
  });

  it("skips missing files without warning", async () => {
    const onWarning = vi.fn();

    await expect(
      loadCustomInstructions({ projectPath, globalPath, onWarning }),
    ).resolves.toEqual([]);
    expect(onWarning).not.toHaveBeenCalled();
  });

  it("warns and skips files that cannot be read", async () => {
    const onWarning = vi.fn();
    await fs.mkdir(projectPath, { recursive: true });

    await expect(
      loadCustomInstructions({ projectPath, globalPath, onWarning }),
    ).resolves.toEqual([]);
    expect(onWarning).toHaveBeenCalledWith(
      expect.stringContaining(projectPath),
      expect.any(Error),
    );
  });

  it("renders loaded instructions as a custom prompt layer", () => {
    const prompt = generateCustomInstructionsPrompt(["# Project", "# Global"]);

    expect(prompt).toContain("Custom Instructions");
    expect(prompt).toContain("# Project");
    expect(prompt).toContain("# Global");
    expect(generateCustomInstructionsPrompt([])).toBe("");
  });
});
