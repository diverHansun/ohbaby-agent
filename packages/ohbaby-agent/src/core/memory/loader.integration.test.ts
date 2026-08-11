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

  it("is read-only and has no CRUD or event surface", () => {
    const loader = createMemoryLoader();

    expect(Object.keys(loader)).toEqual(["load"]);
  });
});
