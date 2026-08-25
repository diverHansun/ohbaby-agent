import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryLoader } from "./index.js";
import type { ProjectResolver } from "./types.js";

describe("MemoryLoader", () => {
  let tempDir: string;
  let projectRoot: string;
  let globalPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-memory-"));
    projectRoot = path.join(tempDir, "repo");
    globalPath = path.join(tempDir, "config", "ohbaby-agent", "OHBABY.md");
    await fs.mkdir(path.join(projectRoot, "src", "feature"), {
      recursive: true,
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("loads and merges global memory with the nearest project file", async () => {
    await fs.mkdir(path.dirname(globalPath), { recursive: true });
    await fs.writeFile(globalPath, "# Global\n\nUse TypeScript", "utf8");
    await fs.writeFile(path.join(projectRoot, "OHBABY.md"), "# Root", "utf8");
    await fs.writeFile(
      path.join(projectRoot, "src", "OHBABY.md"),
      "# Src",
      "utf8",
    );
    const projectResolver: ProjectResolver = {
      fromDirectory(): { readonly id: string; readonly rootPath: string } {
        return { id: "project:test", rootPath: projectRoot };
      },
    };
    const loader = createMemoryLoader({
      globalMemoryPath: globalPath,
      projectResolver,
    });

    const memory = await loader.load(path.join(projectRoot, "src", "feature"));

    expect(memory.global).toContain("Use TypeScript");
    expect(memory.project).toBe("# Src");
    expect(memory.merged).toContain("<!-- Global Memory from");
    expect(memory.merged).toContain("<!-- Project Memory from");
    expect(memory.merged).toContain("---");
  });

  it("does not discover project memory when the start directory is outside the project root", async () => {
    const outside = path.join(tempDir, "outside", "nested");
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(
      path.join(tempDir, "outside", "OHBABY.md"),
      "outside memory",
      "utf8",
    );
    const loader = createMemoryLoader({
      globalMemoryPath: globalPath,
      projectResolver: {
        fromDirectory: () => ({ id: "project:test", rootPath: projectRoot }),
      },
    });

    const memory = await loader.load(outside);

    expect(memory.project).toBe("");
    expect(memory.merged).not.toContain("outside memory");
  });

  it("does not follow a project memory symlink outside the project root", async () => {
    const externalMemory = path.join(tempDir, "external-memory.md");
    await fs.writeFile(externalMemory, "external memory", "utf8");
    await fs.symlink(externalMemory, path.join(projectRoot, "OHBABY.md"));
    const loader = createMemoryLoader({
      globalMemoryPath: globalPath,
      projectResolver: {
        fromDirectory: () => ({ id: "project:test", rootPath: projectRoot }),
      },
    });

    const memory = await loader.load(path.join(projectRoot, "src"));

    expect(memory.project).toBe("");
    expect(memory.merged).not.toContain("external memory");
  });

  it("degrades missing and unreadable memory to empty without aborting", async () => {
    const warnings: string[] = [];
    const loader = createMemoryLoader({
      globalMemoryPath: globalPath,
      onWarning: (message) => warnings.push(message),
      projectResolver: {
        fromDirectory: () => ({ id: "project:test", rootPath: projectRoot }),
      },
    });

    await expect(loader.load(projectRoot)).resolves.toEqual({
      global: "",
      merged: "",
      project: "",
    });
    expect(warnings).toEqual([]);

    await fs.mkdir(path.join(projectRoot, "OHBABY.md"));
    await expect(loader.load(projectRoot)).resolves.toEqual({
      global: "",
      merged: "",
      project: "",
    });
    expect(warnings).toEqual([
      expect.stringContaining("Unable to read memory file") as string,
    ]);
  });

  it("is read-only and has no CRUD or event surface", () => {
    const loader = createMemoryLoader();

    expect(Object.keys(loader)).toEqual(["load"]);
  });
});
