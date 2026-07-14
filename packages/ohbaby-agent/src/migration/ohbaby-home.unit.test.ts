import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateOhbabyConfig, migrateOhbabyData } from "./ohbaby-home.js";

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

describe("ohbaby home migration", () => {
  let tempRoot: string;
  let homeDirectory: string;
  let projectDirectory: string;
  let xdgConfigHome: string;
  let xdgDataHome: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-migration-"));
    homeDirectory = path.join(tempRoot, "home");
    projectDirectory = path.join(tempRoot, "project");
    xdgConfigHome = path.join(tempRoot, "xdg-config");
    xdgDataHome = path.join(tempRoot, "xdg-data");
    await fs.mkdir(projectDirectory, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  it("migrates global and project config with additive env and MCP merges", async () => {
    const legacyHome = path.join(homeDirectory, ".ohbaby-agent");
    const targetHome = path.join(homeDirectory, ".ohbaby");
    const legacyProject = path.join(projectDirectory, ".ohbaby-agent");
    const targetProject = path.join(projectDirectory, ".ohbaby");
    const warnings: string[] = [];

    await writeFile(
      path.join(legacyHome, ".env"),
      "SHARED=legacy\nLEGACY_ONLY=legacy-value\n",
    );
    await writeFile(
      path.join(targetHome, ".env"),
      "SHARED=new\nNEW_ONLY=new-value\n",
    );
    await writeJson(path.join(legacyHome, "mcp", "settings.json"), {
      mcpServers: {
        legacyOnly: { command: "legacy-command" },
        shared: { command: "legacy-shared" },
      },
    });
    await writeJson(path.join(targetHome, "mcp", "settings.json"), {
      mcpServers: {
        shared: { command: "new-shared" },
      },
    });
    await writeJson(path.join(legacyHome, "model.json"), {
      source: "legacy",
    });
    await writeJson(path.join(targetHome, "model.json"), { source: "new" });
    await writeFile(
      path.join(xdgConfigHome, "ohbaby-agent", "OHBABY.md"),
      "legacy global memory\n",
    );
    await writeFile(
      path.join(legacyProject, ".env"),
      "PROJECT_LEGACY_ONLY=yes\n",
    );
    await writeJson(path.join(legacyProject, "mcp", "settings.json"), {
      mcpServers: { projectLegacy: { command: "project-command" } },
    });

    const report = await migrateOhbabyConfig({
      environment: { XDG_CONFIG_HOME: xdgConfigHome },
      homeDirectory,
      onWarning(message) {
        warnings.push(message);
      },
      platform: "linux",
      projectDirectory,
    });

    const env = await fs.readFile(path.join(targetHome, ".env"), "utf8");
    expect(env).toContain("SHARED=new");
    expect(env).toContain("NEW_ONLY=new-value");
    expect(env).toContain("LEGACY_ONLY=legacy-value");
    const mcp = JSON.parse(
      await fs.readFile(path.join(targetHome, "mcp", "settings.json"), "utf8"),
    ) as { readonly mcpServers: Record<string, { readonly command: string }> };
    expect(mcp.mcpServers.shared.command).toBe("new-shared");
    expect(mcp.mcpServers.legacyOnly.command).toBe("legacy-command");
    await expect(
      fs.readFile(
        path.join(targetHome, "model.migrated-from-ohbaby-agent.json"),
        "utf8",
      ),
    ).resolves.toContain('"source": "legacy"');
    await expect(
      fs.readFile(path.join(targetHome, "OHBABY.md"), "utf8"),
    ).resolves.toBe("legacy global memory\n");
    await expect(
      fs.readFile(path.join(targetProject, ".env"), "utf8"),
    ).resolves.toContain("PROJECT_LEGACY_ONLY=yes");
    await expect(
      fs.readFile(path.join(targetProject, "mcp", "settings.json"), "utf8"),
    ).resolves.toContain("projectLegacy");
    await expect(
      fs.access(path.join(targetHome, ".migrated-from-ohbaby-agent.json")),
    ).resolves.toBeUndefined();
    expect(report.conflicts).toContain(path.join(targetHome, "model.json"));
    expect(warnings).toHaveLength(1);
  });

  it("is idempotent and does not use the marker as the only completion gate", async () => {
    const legacyHome = path.join(homeDirectory, ".ohbaby-agent");
    const targetHome = path.join(homeDirectory, ".ohbaby");
    await writeFile(path.join(legacyHome, "first.txt"), "first\n");

    const first = await migrateOhbabyConfig({ homeDirectory });
    expect(first.copied).toContain(path.join(targetHome, "first.txt"));

    await writeFile(path.join(legacyHome, "second.txt"), "second\n");
    const second = await migrateOhbabyConfig({ homeDirectory });

    await expect(
      fs.readFile(path.join(targetHome, "second.txt"), "utf8"),
    ).resolves.toBe("second\n");
    expect(second.copied).toContain(path.join(targetHome, "second.txt"));
  });

  it("honors the automatic migration skip marker", async () => {
    const legacyHome = path.join(homeDirectory, ".ohbaby-agent");
    await writeFile(path.join(legacyHome, ".skip-auto-migrate"), "\n");
    await writeFile(path.join(legacyHome, "model.json"), "{}\n");

    const report = await migrateOhbabyConfig({ homeDirectory });

    expect(report.skipped).toContain(legacyHome);
    await expect(
      fs.access(path.join(homeDirectory, ".ohbaby", "model.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("migrates the database, WAL, SHM, and data tree as one retained-source copy", async () => {
    const legacyDataRoot = path.join(xdgDataHome, "ohbaby-agent");
    const targetDataRoot = path.join(xdgDataHome, "ohbaby");
    await writeFile(path.join(legacyDataRoot, "ohbaby-agent.db"), "database");
    await writeFile(
      path.join(legacyDataRoot, "ohbaby-agent.db-wal"),
      "write-ahead-log",
    );
    await writeFile(
      path.join(legacyDataRoot, "ohbaby-agent.db-shm"),
      "shared-memory",
    );
    await writeFile(path.join(legacyDataRoot, "storage", "blob"), "blob");

    const report = await migrateOhbabyData({
      environment: { XDG_DATA_HOME: xdgDataHome },
      homeDirectory,
      platform: "linux",
    });

    expect(report.copied).toContain(targetDataRoot);
    await expect(
      fs.readFile(path.join(targetDataRoot, "ohbaby.db"), "utf8"),
    ).resolves.toBe("database");
    await expect(
      fs.readFile(path.join(targetDataRoot, "ohbaby.db-wal"), "utf8"),
    ).resolves.toBe("write-ahead-log");
    await expect(
      fs.readFile(path.join(targetDataRoot, "ohbaby.db-shm"), "utf8"),
    ).resolves.toBe("shared-memory");
    await expect(
      fs.readFile(path.join(targetDataRoot, "storage", "blob"), "utf8"),
    ).resolves.toBe("blob");
    await expect(
      fs.access(path.join(legacyDataRoot, "ohbaby-agent.db")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(
        path.join(targetDataRoot, ".migrated-from-ohbaby-agent-data.json"),
      ),
    ).resolves.toBeUndefined();
  });

  it("refuses data migration while a live daemon owns the new home", async () => {
    const legacyDatabase = path.join(
      xdgDataHome,
      "ohbaby-agent",
      "ohbaby-agent.db",
    );
    const targetDataRoot = path.join(xdgDataHome, "ohbaby");
    await writeFile(legacyDatabase, "database");
    await writeJson(
      path.join(homeDirectory, ".ohbaby", "server", "daemon.pid"),
      { pid: process.pid },
    );

    await expect(
      migrateOhbabyData({
        environment: { XDG_DATA_HOME: xdgDataHome },
        homeDirectory,
        platform: "linux",
      }),
    ).rejects.toThrow(/daemon process.*is running/iu);
    await expect(fs.access(targetDataRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses data migration while the current project has a live legacy daemon", async () => {
    const legacyDatabase = path.join(
      xdgDataHome,
      "ohbaby-agent",
      "ohbaby-agent.db",
    );
    await writeFile(legacyDatabase, "database");
    await fs.mkdir(path.join(projectDirectory, ".git"), { recursive: true });
    await writeJson(
      path.join(projectDirectory, ".ohbaby", "server", "daemon-state.json"),
      { pid: process.pid, status: "running" },
    );

    await expect(
      migrateOhbabyData({
        environment: { XDG_DATA_HOME: xdgDataHome },
        homeDirectory,
        platform: "linux",
        projectDirectory,
      }),
    ).rejects.toThrow(/legacy project daemon process.*is running/iu);
  });

  it("refuses to choose between different legacy and new databases", async () => {
    await writeFile(
      path.join(xdgDataHome, "ohbaby-agent", "ohbaby-agent.db"),
      "legacy-database",
    );
    await writeFile(
      path.join(xdgDataHome, "ohbaby", "ohbaby.db"),
      "new-database",
    );

    await expect(
      migrateOhbabyData({
        environment: { XDG_DATA_HOME: xdgDataHome },
        homeDirectory,
        platform: "linux",
      }),
    ).rejects.toThrow(/both exist and differ.*refusing/iu);
  });

  it("completes missing WAL and SHM sidecars when database files already match", async () => {
    const legacyDataRoot = path.join(xdgDataHome, "ohbaby-agent");
    const targetDataRoot = path.join(xdgDataHome, "ohbaby");
    await writeFile(path.join(legacyDataRoot, "ohbaby-agent.db"), "database");
    await writeFile(path.join(legacyDataRoot, "ohbaby-agent.db-wal"), "wal");
    await writeFile(path.join(legacyDataRoot, "ohbaby-agent.db-shm"), "shm");
    await writeFile(path.join(targetDataRoot, "ohbaby.db"), "database");

    await migrateOhbabyData({
      environment: { XDG_DATA_HOME: xdgDataHome },
      homeDirectory,
      platform: "linux",
    });

    await expect(
      fs.readFile(path.join(targetDataRoot, "ohbaby.db-wal"), "utf8"),
    ).resolves.toBe("wal");
    await expect(
      fs.readFile(path.join(targetDataRoot, "ohbaby.db-shm"), "utf8"),
    ).resolves.toBe("shm");
  });

  it("serializes concurrent first starts and ignores an abandoned temp tree", async () => {
    const legacyDataRoot = path.join(xdgDataHome, "ohbaby-agent");
    const targetDataRoot = path.join(xdgDataHome, "ohbaby");
    await writeFile(path.join(legacyDataRoot, "ohbaby-agent.db"), "database");
    await writeFile(`${targetDataRoot}.migrating-abandoned/partial`, "partial");
    const options = {
      environment: { XDG_DATA_HOME: xdgDataHome },
      homeDirectory,
      platform: "linux" as const,
    };

    const reports = await Promise.all([
      migrateOhbabyData(options),
      migrateOhbabyData(options),
    ]);

    await expect(
      fs.readFile(path.join(targetDataRoot, "ohbaby.db"), "utf8"),
    ).resolves.toBe("database");
    expect(reports.flatMap((report) => report.copied)).toContain(
      targetDataRoot,
    );
    expect(reports.flatMap((report) => report.skipped)).toContain(
      legacyDataRoot,
    );
  });
});
