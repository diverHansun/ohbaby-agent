import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { preflightSandboxCommand } from "./preflight.js";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-sandbox-"));
});

afterEach(async () => {
  await fs.rm(tempRoot, { force: true, recursive: true });
});

describe("sandbox preflight facts", () => {
  it("classifies relative escapes as external paths without throwing", async () => {
    const workdir = path.join(tempRoot, "workspace");
    await fs.mkdir(workdir);

    const result = await preflightSandboxCommand({
      command: "cat ../outside.txt",
      shellKind: "bash",
      workdir,
    });

    const outside = path.join(tempRoot, "outside.txt");
    expect(result.externalPaths).toEqual([
      {
        absolutePath: outside,
        askPattern: path.join(path.dirname(outside), "**"),
        original: "../outside.txt",
      },
    ]);
    expect(result.internalPaths).toEqual([]);
    expect(result.denylistHits).toEqual([]);
  });

  it("classifies absolute paths outside the workspace as external paths", async () => {
    const workdir = path.join(tempRoot, "workspace");
    const outside = path.join(tempRoot, "outside.txt");
    await fs.mkdir(workdir);

    const result = await preflightSandboxCommand({
      command: `cat "${outside}"`,
      shellKind: "bash",
      workdir,
    });

    expect(result.externalPaths).toEqual([
      {
        absolutePath: outside,
        askPattern: path.join(path.dirname(outside), "**"),
        original: outside,
      },
    ]);
  });

  it("classifies workspace paths as internal facts", async () => {
    const workdir = path.join(tempRoot, "workspace");
    await fs.mkdir(path.join(workdir, "src"), { recursive: true });

    const result = await preflightSandboxCommand({
      command: "cat src/app.ts",
      shellKind: "bash",
      workdir,
    });

    expect(result.internalPaths).toEqual([
      {
        absolutePath: path.join(workdir, "src", "app.ts"),
        original: "src/app.ts",
      },
    ]);
    expect(result.externalPaths).toEqual([]);
  });

  it("reports denylist hits without also reporting them as normal paths", async () => {
    const workdir = path.join(tempRoot, "workspace");
    await fs.mkdir(workdir);

    const result = await preflightSandboxCommand({
      command: "cat .env secret.pem",
      shellKind: "bash",
      workdir,
    });

    expect(result.denylistHits).toEqual([
      {
        absolutePath: path.join(workdir, ".env"),
        original: ".env",
        reason: "env-file",
      },
      {
        absolutePath: path.join(workdir, "secret.pem"),
        original: "secret.pem",
        reason: "private-key",
      },
    ]);
    expect(result.internalPaths).toEqual([]);
    expect(result.externalPaths).toEqual([]);
  });

  it("passes shell command facts through to permission consumers", async () => {
    const workdir = path.join(tempRoot, "workspace");
    await fs.mkdir(workdir);

    const result = await preflightSandboxCommand({
      command: "git push origin main && rm -rf build",
      shellKind: "bash",
      workdir,
    });

    expect(result.commands.map((command) => command.arityKey)).toEqual([
      "git push *",
      "rm *",
    ]);
    expect(result.commands.map((command) => command.danger)).toEqual([
      "mutating",
      "dangerous",
    ]);
    expect(result.overallDanger).toBe("dangerous");
  });
});
