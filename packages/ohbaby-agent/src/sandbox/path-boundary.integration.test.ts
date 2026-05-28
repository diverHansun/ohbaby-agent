import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AdapterRegistry,
  HostLocalAdapter,
  SandboxBoundaryError,
  SandboxManager,
} from "./index.js";

let tempRoot: string;

function createHostLocalManager(): SandboxManager {
  const registry = new AdapterRegistry();
  registry.register(new HostLocalAdapter());
  return new SandboxManager({ adapterRegistry: registry });
}

describe("Sandbox path boundaries", () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-sandbox-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  it("rejects string-level path escapes", async () => {
    const workdir = path.join(tempRoot, "workspace");
    await fs.mkdir(workdir);
    const manager = createHostLocalManager();
    await manager.createContext("session_1", {
      adapterId: "host-local",
      workdir,
    });
    const lease = await manager.acquire("session_1");
    const realWorkdir = await fs.realpath(workdir);

    expect(lease.resolvePath("src/file.ts")).toBe(
      path.join(realWorkdir, "src", "file.ts"),
    );
    expect(() => lease.resolvePath("../outside.txt")).toThrow(
      SandboxBoundaryError,
    );
    expect(() => lease.resolvePath(path.join(tempRoot, "outside.txt"))).toThrow(
      SandboxBoundaryError,
    );
  });

  it("rejects symlink escapes for existing paths", async () => {
    const workdir = path.join(tempRoot, "workspace");
    const outside = path.join(tempRoot, "outside");
    await fs.mkdir(workdir);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    await fs.symlink(outside, path.join(workdir, "linked-outside"), "junction");
    const manager = createHostLocalManager();
    await manager.createContext("session_1", {
      adapterId: "host-local",
      workdir,
    });
    const lease = await manager.acquire("session_1");

    await expect(
      lease.resolvePathForExisting("linked-outside/secret.txt"),
    ).rejects.toBeInstanceOf(SandboxBoundaryError);
  });

  it("resolves write paths through existing parent realpaths", async () => {
    const workdir = path.join(tempRoot, "workspace");
    const inside = path.join(workdir, "inside");
    const outside = path.join(tempRoot, "outside");
    await fs.mkdir(inside, { recursive: true });
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(workdir, "linked-outside"), "junction");
    const manager = createHostLocalManager();
    await manager.createContext("session_1", {
      adapterId: "host-local",
      workdir,
    });
    const lease = await manager.acquire("session_1");
    const realInside = await fs.realpath(inside);

    await expect(lease.resolvePathForWrite("inside/new.txt")).resolves.toBe(
      path.join(realInside, "new.txt"),
    );
    await expect(
      lease.resolvePathForWrite("linked-outside/new.txt"),
    ).rejects.toBeInstanceOf(SandboxBoundaryError);
  });

  it("allows paths inside session trusted roots", async () => {
    const workdir = path.join(tempRoot, "workspace");
    const skillRoot = path.join(tempRoot, "skills", "crawl");
    await fs.mkdir(workdir);
    await fs.mkdir(skillRoot, { recursive: true });
    await fs.writeFile(path.join(skillRoot, "SKILL.md"), "# Skill", "utf8");
    const realSkillRoot = await fs.realpath(skillRoot);
    const manager = createHostLocalManager();
    await manager.createContext("session_1", {
      adapterId: "host-local",
      workdir,
    });
    const lease = await manager.acquire("session_1");
    await lease.trustPath({ kind: "active-skill", path: skillRoot });

    expect(
      lease.containsTrustedPath(
        await fs.realpath(path.join(skillRoot, "SKILL.md")),
      ),
    ).toBe(true);
    await expect(
      lease.resolvePathForExisting(path.join(skillRoot, "SKILL.md")),
    ).resolves.toBe(await fs.realpath(path.join(skillRoot, "SKILL.md")));
    await expect(
      lease.resolvePathForWrite(path.join(skillRoot, "notes", "out.txt")),
    ).resolves.toBe(path.join(realSkillRoot, "notes", "out.txt"));
  });

  it("returns a host-local command context", async () => {
    const workdir = path.join(tempRoot, "workspace");
    await fs.mkdir(workdir);
    const manager = createHostLocalManager();
    await manager.createContext("session_1", {
      adapterId: "host-local",
      workdir,
    });
    const lease = await manager.acquire("session_1");

    expect(lease.resolveCommandContext()).toMatchObject({
      cwd: await fs.realpath(workdir),
      kind: "host-local",
    });
    expect(lease.capabilities).toEqual({
      canExecCommands: true,
      isolation: "none",
      readOnly: false,
      supportsGit: true,
    });
  });
});
