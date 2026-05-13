import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBus } from "../../bus/index.js";
import { createMemoryManager, MemoryEvent } from "./index.js";
import type { MemoryManager, MergedMemory, ProjectResolver } from "./types.js";

type RecordedMemoryEvent =
  | { readonly type: "added"; readonly scope: string; readonly text: string }
  | {
      readonly type: "updated";
      readonly scope: string;
      readonly index: number;
      readonly newText: string;
    }
  | { readonly type: "removed"; readonly scope: string; readonly index: number }
  | {
      readonly type: "refreshed";
      readonly directory: string;
      readonly memory: MergedMemory;
    };

interface MemoryFixture {
  readonly events: RecordedMemoryEvent[];
  readonly manager: MemoryManager;
}

describe("MemoryManager", () => {
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

  function createManager(): MemoryFixture {
    const bus = createBus();
    const events: RecordedMemoryEvent[] = [];
    const projectResolver: ProjectResolver = {
      fromDirectory(): { readonly id: string; readonly rootPath: string } {
        return { id: "project:test", rootPath: projectRoot };
      },
    };

    bus.subscribe(MemoryEvent.Added, (payload) => {
      events.push({ type: "added", ...payload });
    });
    bus.subscribe(MemoryEvent.Updated, (payload) => {
      events.push({ type: "updated", ...payload });
    });
    bus.subscribe(MemoryEvent.Removed, (payload) => {
      events.push({ type: "removed", ...payload });
    });
    bus.subscribe(MemoryEvent.Refreshed, (payload) => {
      events.push({ type: "refreshed", ...payload });
    });

    return {
      events,
      manager: createMemoryManager({
        bus,
        projectResolver,
        globalMemoryPath: globalPath,
        now: () => new Date("2026-01-01T22:00:00.000Z"),
      }),
    };
  }

  it("loads global memory and the nearest project OHBABY.md", async () => {
    const { manager } = createManager();
    await fs.mkdir(path.dirname(globalPath), { recursive: true });
    await fs.writeFile(globalPath, "# Global\n\nUse TypeScript", "utf8");
    await fs.writeFile(path.join(projectRoot, "OHBABY.md"), "# Root", "utf8");
    await fs.writeFile(
      path.join(projectRoot, "src", "OHBABY.md"),
      "# Src",
      "utf8",
    );

    const memory = await manager.load(path.join(projectRoot, "src", "feature"));

    expect(memory.global).toContain("Use TypeScript");
    expect(memory.project).toBe("# Src");
    expect(memory.merged).toContain("<!-- Global Memory from");
    expect(memory.merged).toContain("<!-- Project Memory from");
    expect(memory.merged).toContain("---");
  });

  it("adds, updates, lists, removes, and refreshes managed entries", async () => {
    const { events, manager } = createManager();

    await manager.add({ scope: "global", fact: "Prefer concise commits" });
    await expect(manager.listEntries("global")).resolves.toEqual([
      {
        index: 0,
        timestamp: "2026-01-01 22:00:00",
        text: "Prefer concise commits",
      },
    ]);

    await manager.update({
      scope: "global",
      index: 0,
      newText: "Prefer structured commits",
    });
    await manager.remove({ scope: "global", index: 0 });
    await manager.refresh(projectRoot);

    const written = await fs.readFile(globalPath, "utf8");
    expect(written).toContain("## Ohbaby Added Memories");
    expect(written).not.toContain("Prefer structured commits");
    expect(events.slice(0, 3)).toEqual([
      { type: "added", scope: "global", text: "Prefer concise commits" },
      {
        type: "updated",
        scope: "global",
        index: 0,
        newText: "Prefer structured commits",
      },
      { type: "removed", scope: "global", index: 0 },
    ]);
    const refreshed = events[3];
    expect(refreshed).toMatchObject({
      type: "refreshed",
      directory: projectRoot,
    });
    expect(refreshed.type === "refreshed" ? refreshed.memory.global : "").toBe(
      written,
    );
    expect(
      refreshed.type === "refreshed" ? refreshed.memory.project : "not-empty",
    ).toBe("");
    expect(
      refreshed.type === "refreshed" ? refreshed.memory.merged : "",
    ).toContain("Global Memory");
  });

  it("creates project memory at the project root when no OHBABY.md exists", async () => {
    const { manager } = createManager();

    await manager.add({
      scope: "project",
      directory: path.join(projectRoot, "src", "feature"),
      fact: "Project uses Vitest",
    });

    await expect(
      fs.readFile(path.join(projectRoot, "OHBABY.md"), "utf8"),
    ).resolves.toContain("Project uses Vitest");
  });
});
