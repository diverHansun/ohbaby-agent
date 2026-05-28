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

    const outside = path.join(await fs.realpath(tempRoot), "outside.txt");
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
    const realOutside = path.join(await fs.realpath(tempRoot), "outside.txt");
    await fs.mkdir(workdir);

    const result = await preflightSandboxCommand({
      command: `cat "${outside}"`,
      shellKind: "bash",
      workdir,
    });

    expect(result.externalPaths).toEqual([
      {
        absolutePath: realOutside,
        askPattern: path.join(path.dirname(realOutside), "**"),
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

    const realSrc = await fs.realpath(path.join(workdir, "src"));
    expect(result.internalPaths).toEqual([
      {
        absolutePath: path.join(realSrc, "app.ts"),
        original: "src/app.ts",
      },
    ]);
    expect(result.externalPaths).toEqual([]);
  });

  it("classifies executed scripts under trusted roots as internal facts", async () => {
    const workdir = path.join(tempRoot, "workspace");
    const skillRoot = path.join(tempRoot, "skills", "crawl");
    await fs.mkdir(path.join(workdir), { recursive: true });
    await fs.mkdir(path.join(skillRoot, "scripts"), { recursive: true });
    const script = path.join(skillRoot, "scripts", "run.py");
    await fs.writeFile(script, "print(1)", "utf8");

    const result = await preflightSandboxCommand({
      command: `python "${script}" --output-dir ../outside`,
      shellKind: "bash",
      trustedRoots: [skillRoot],
      workdir,
    });

    expect(result.internalPaths).toEqual([
      {
        absolutePath: await fs.realpath(script),
        original: script,
      },
    ]);
    expect(result.externalPaths).toEqual([
      {
        absolutePath: path.join(await fs.realpath(tempRoot), "outside"),
        askPattern: path.join(await fs.realpath(tempRoot), "**"),
        original: "../outside",
      },
    ]);
  });

  it("classifies cd targets against trusted roots instead of only the workspace", async () => {
    const workdir = path.join(tempRoot, "workspace");
    const skillRoot = path.join(tempRoot, "skills", "crawl");
    const outside = path.join(tempRoot, "outside");
    await fs.mkdir(workdir, { recursive: true });
    await fs.mkdir(skillRoot, { recursive: true });
    await fs.mkdir(outside);

    const trusted = await preflightSandboxCommand({
      command: `cd "${skillRoot}"`,
      shellKind: "bash",
      trustedRoots: [skillRoot],
      workdir,
    });
    expect(trusted.internalPaths).toEqual([
      {
        absolutePath: await fs.realpath(skillRoot),
        original: skillRoot,
      },
    ]);
    expect(trusted.externalPaths).toEqual([]);

    const untrusted = await preflightSandboxCommand({
      command: `cd "${outside}"`,
      shellKind: "bash",
      trustedRoots: [skillRoot],
      workdir,
    });
    expect(untrusted.externalPaths).toEqual([
      {
        absolutePath: await fs.realpath(outside),
        askPattern: path.join(await fs.realpath(tempRoot), "**"),
        original: outside,
      },
    ]);
  });

  it("classifies workspace symlink targets outside the workspace as external paths", async () => {
    const workdir = path.join(tempRoot, "workspace");
    const outside = path.join(tempRoot, "outside");
    const externalFile = path.join(outside, "secret.txt");
    await fs.mkdir(workdir);
    await fs.mkdir(outside);
    await fs.writeFile(externalFile, "external\n", "utf8");
    await fs.symlink(outside, path.join(workdir, "linked-outside"), "junction");

    const result = await preflightSandboxCommand({
      command: "cat linked-outside/secret.txt",
      shellKind: "bash",
      workdir,
    });
    const realExternalFile = await fs.realpath(externalFile);

    expect(result.externalPaths).toEqual([
      {
        absolutePath: realExternalFile,
        askPattern: path.join(path.dirname(realExternalFile), "**"),
        original: "linked-outside/secret.txt",
      },
    ]);
    expect(result.internalPaths).toEqual([]);
    expect(result.denylistHits).toEqual([]);
  });

  it("hard denies symlink targets that resolve to sensitive directories", async () => {
    const workdir = path.join(tempRoot, "workspace");
    const fakeHomeSsh = path.join(
      tempRoot,
      path.basename(os.homedir()),
      ".ssh",
    );
    const keyFile = path.join(fakeHomeSsh, "id_rsa");
    await fs.mkdir(workdir);
    await fs.mkdir(fakeHomeSsh, { recursive: true });
    await fs.writeFile(keyFile, "private\n", "utf8");
    await fs.symlink(fakeHomeSsh, path.join(workdir, "linked-ssh"), "junction");

    const result = await preflightSandboxCommand({
      command: "cat linked-ssh/id_rsa",
      shellKind: "bash",
      workdir,
    });

    expect(result.denylistHits).toEqual([
      {
        absolutePath: await fs.realpath(keyFile),
        original: "linked-ssh/id_rsa",
        reason: "ssh-key-dir",
      },
    ]);
    expect(result.internalPaths).toEqual([]);
    expect(result.externalPaths).toEqual([]);
  });

  it("reports sensitive symlink names without suppressing external facts", async () => {
    const workdir = path.join(tempRoot, "workspace");
    const outside = path.join(tempRoot, "outside");
    await fs.mkdir(workdir);
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(workdir, ".env"), "junction");

    const result = await preflightSandboxCommand({
      command: "cat .env",
      shellKind: "bash",
      workdir,
    });

    expect(result.denylistHits).toEqual([]);
    expect(result.sensitivePaths).toEqual([
      {
        absolutePath: await fs.realpath(outside),
        askPattern: await fs.realpath(outside),
        original: ".env",
        reason: "env-file",
      },
    ]);
    expect(result.externalPaths).toEqual([
      {
        absolutePath: await fs.realpath(outside),
        askPattern: path.join(path.dirname(await fs.realpath(outside)), "**"),
        original: ".env",
      },
    ]);
    expect(result.internalPaths).toEqual([]);
  });

  it("reports sensitive files without hard denying normal project fixtures", async () => {
    const workdir = path.join(tempRoot, "workspace");
    await fs.mkdir(path.join(workdir, "fixtures"), { recursive: true });
    await fs.mkdir(path.join(workdir, "certs"));

    const result = await preflightSandboxCommand({
      command: "cat .env secret.pem fixtures/test.key .env.example",
      shellKind: "bash",
      workdir,
    });

    const realWorkdir = await fs.realpath(workdir);
    expect(result.denylistHits).toEqual([]);
    expect(result.sensitivePaths).toEqual([
      {
        absolutePath: path.join(realWorkdir, ".env"),
        askPattern: path.join(realWorkdir, ".env"),
        original: ".env",
        reason: "env-file",
      },
      {
        absolutePath: path.join(realWorkdir, "secret.pem"),
        askPattern: path.join(realWorkdir, "secret.pem"),
        original: "secret.pem",
        reason: "private-key",
      },
      {
        absolutePath: path.join(realWorkdir, "fixtures", "test.key"),
        askPattern: path.join(realWorkdir, "fixtures", "test.key"),
        original: "fixtures/test.key",
        reason: "private-key",
      },
    ]);
    expect(result.internalPaths).toEqual([
      {
        absolutePath: path.join(realWorkdir, ".env"),
        original: ".env",
      },
      {
        absolutePath: path.join(realWorkdir, "secret.pem"),
        original: "secret.pem",
      },
      {
        absolutePath: path.join(realWorkdir, "fixtures", "test.key"),
        original: "fixtures/test.key",
      },
      {
        absolutePath: path.join(realWorkdir, ".env.example"),
        original: ".env.example",
      },
    ]);
    expect(result.externalPaths).toEqual([]);
  });

  it("reports both external and sensitive facts for external sensitive paths", async () => {
    const workdir = path.join(tempRoot, "workspace");
    const outside = path.join(tempRoot, "outside");
    await fs.mkdir(workdir);
    await fs.mkdir(outside);

    const result = await preflightSandboxCommand({
      command: "cat ../outside/.env",
      shellKind: "bash",
      workdir,
    });

    const realOutsideEnv = path.join(await fs.realpath(outside), ".env");
    expect(result.denylistHits).toEqual([]);
    expect(result.externalPaths).toEqual([
      {
        absolutePath: realOutsideEnv,
        askPattern: path.join(path.dirname(realOutsideEnv), "**"),
        original: "../outside/.env",
      },
    ]);
    expect(result.sensitivePaths).toEqual([
      {
        absolutePath: realOutsideEnv,
        askPattern: realOutsideEnv,
        original: "../outside/.env",
        reason: "env-file",
      },
    ]);
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
