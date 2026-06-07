import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

interface CommandResult {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

interface NpmPackEntry {
  readonly filename: string;
  readonly files?: readonly { readonly path: string }[];
  readonly name: string;
}

const repoRoot = process.cwd();
const cleanupDirectories: string[] = [];

afterEach(async () => {
  for (const directory of cleanupDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
}, 120_000);

async function tempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanupDirectories.push(directory);
  return directory;
}

async function runCommand(input: {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}): Promise<CommandResult> {
  const processInput = commandProcessInput(input.command, input.args);
  const child = spawn(processInput.command, processInput.args, {
    cwd: input.cwd ?? repoRoot,
    env: input.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let stderr = "";
  let stdout = "";
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });

  return new Promise((resolveResult, reject) => {
    const timeout = setTimeout(() => {
      killProcessTree(child.pid);
      reject(
        new Error(
          `${input.command} ${input.args.join(" ")} timed out after ${String(
            input.timeoutMs,
          )}ms`,
        ),
      );
    }, input.timeoutMs ?? 30_000);

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolveResult({ code, stderr, stdout });
    });
  });
}

function killProcessTree(pid: number | undefined): void {
  if (!pid) {
    return;
  }

  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process may already have exited between timeout and cleanup.
  }
}

function commandProcessInput(
  command: string,
  args: readonly string[],
): { readonly args: readonly string[]; readonly command: string } {
  if (process.platform !== "win32") {
    return { args, command };
  }

  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: [
      "/d",
      "/s",
      "/c",
      [command, ...args].map(quoteWindowsCommandArgument).join(" "),
    ],
  };
}

function quoteWindowsCommandArgument(argument: string): string {
  if (argument.length > 0 && !/[\s"&|<>^]/.test(argument)) {
    return argument;
  }
  return `"${argument.replaceAll('"', '\\"')}"`;
}

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function nodeCommand(): string {
  return process.platform === "win32" ? "node.exe" : process.execPath;
}

function pnpmCommand(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function installedOhbabyPath(prefix: string): string {
  if (process.platform === "win32") {
    return join(prefix, "ohbaby.cmd");
  }
  return join(prefix, "bin", "ohbaby");
}

function installedGlobalPackagePath(
  prefix: string,
  packageName: string,
): string {
  if (process.platform === "win32") {
    return join(prefix, "node_modules", packageName);
  }
  return join(prefix, "lib", "node_modules", packageName);
}

function expectSuccess(result: CommandResult, label: string): void {
  expect(
    result.code,
    `${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(0);
}

function parsePackEntry(stdout: string): NpmPackEntry {
  const parsed = JSON.parse(stdout) as NpmPackEntry | NpmPackEntry[];
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

async function packWorkspacePackage(input: {
  readonly packDestination: string;
  readonly packageDirectory: string;
}): Promise<NpmPackEntry> {
  const result = await runCommand({
    command: pnpmCommand(),
    args: ["pack", "--json", "--pack-destination", input.packDestination],
    cwd: input.packageDirectory,
    timeoutMs: 60_000,
  });
  expectSuccess(result, `pnpm pack ${input.packageDirectory}`);

  const entry = parsePackEntry(result.stdout);
  expect(entry.files ?? []).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: expect.stringMatching(/(^|[/\\])node_modules([/\\]|$)/),
      }),
    ]),
  );
  expect(entry.files ?? []).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: expect.stringMatching(/^\.\./) }),
    ]),
  );
  expect(entry.files ?? []).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: expect.stringMatching(
          /(^|[/\\])(?:\.tsbuildinfo|.*(?:test|unit|contract|integration)\.d\.ts(?:\.map)?)$/u,
        ),
      }),
    ]),
  );
  return entry;
}

describe("npm packed CLI smoke", () => {
  it("installs the packed ohbaby-cli tarball globally and exposes ohbaby help and version", async () => {
    const tempRoot = await tempDirectory("ohbaby-packaging-smoke-");
    const packDestination = join(tempRoot, "pack");
    const npmCache = join(tempRoot, "npm-cache");
    const npmTmp = join(tempRoot, "npm-tmp");
    const prefix = join(tempRoot, "prefix");
    const npm = npmCommand();
    await mkdir(packDestination, { recursive: true });
    await mkdir(npmCache, { recursive: true });
    await mkdir(npmTmp, { recursive: true });

    const buildResult = await runCommand({
      command: pnpmCommand(),
      args: [
        "-r",
        "--filter",
        "ohbaby-sdk",
        "--filter",
        "ohbaby-cli",
        "--filter",
        "ohbaby-agent",
        "--sort",
        "build",
      ],
      timeoutMs: 120_000,
    });
    expectSuccess(buildResult, "pnpm package build");

    const sdkPack = await packWorkspacePackage({
      packDestination,
      packageDirectory: join(repoRoot, "packages", "ohbaby-sdk"),
    });
    const agentPack = await packWorkspacePackage({
      packDestination,
      packageDirectory: join(repoRoot, "packages", "ohbaby-agent"),
    });
    const cliPack = await packWorkspacePackage({
      packDestination,
      packageDirectory: join(repoRoot, "packages", "ohbaby-cli"),
    });

    const installResult = await runCommand({
      command: npm,
      args: [
        "install",
        "-g",
        "--prefix",
        prefix,
        "--no-audit",
        "--no-fund",
        "--ignore-scripts",
        "--loglevel=error",
        "--prefer-offline",
        resolve(packDestination, sdkPack.filename),
        resolve(packDestination, cliPack.filename),
        resolve(packDestination, agentPack.filename),
      ],
      env: {
        ...process.env,
        npm_config_cache: npmCache,
        npm_config_tmp: npmTmp,
      },
      timeoutMs: 180_000,
    });
    expectSuccess(installResult, "npm install global packed ohbaby-cli");

    const installedCliPackage = installedGlobalPackagePath(
      prefix,
      "ohbaby-cli",
    );
    const cliImportSmokePath = join(
      installedCliPackage,
      "import-ohbaby-packages.mjs",
    );
    await writeFile(
      cliImportSmokePath,
      [
        'const mod = await import("ohbaby-cli");',
        'const agent = await import("ohbaby-agent");',
        'if (typeof mod.renderTerminalUi !== "function") throw new Error("missing renderTerminalUi export");',
        'if (typeof mod.OhbabyTerminalApp !== "function") throw new Error("missing OhbabyTerminalApp export");',
        'if (typeof agent.buildCoreAPIImpl !== "function") throw new Error("missing buildCoreAPIImpl export");',
        'if (typeof mod.TerminalUiOptions !== "undefined") throw new Error("TerminalUiOptions should be type-only");',
      ].join("\n"),
      "utf8",
    );

    const cliImportResult = await runCommand({
      command: nodeCommand(),
      args: [cliImportSmokePath],
      cwd: installedCliPackage,
      timeoutMs: 30_000,
    });
    expectSuccess(cliImportResult, "import installed ohbaby packages");
    expect(cliImportResult.stdout).toBe("");
    expect(cliImportResult.stderr).toBe("");

    const ohbaby = installedOhbabyPath(prefix);
    const helpResult = await runCommand({
      command: ohbaby,
      args: ["--help"],
      timeoutMs: 30_000,
    });
    expectSuccess(helpResult, "ohbaby --help");
    expect(helpResult.stdout).toContain("ohbaby run [prompt..]");
    expect(helpResult.stdout).toContain("ohbaby serve");
    expect(helpResult.stdout).not.toContain("-p, --prompt");
    expect(helpResult.stderr).toBe("");

    const packageJson = JSON.parse(
      await readFile(
        join(repoRoot, "packages", "ohbaby-cli", "package.json"),
        "utf8",
      ),
    ) as { readonly version: string };
    const versionResult = await runCommand({
      command: ohbaby,
      args: ["--version"],
      timeoutMs: 30_000,
    });
    expectSuccess(versionResult, "ohbaby --version");
    expect(versionResult.stdout).toBe(`${packageJson.version}\n`);
    expect(versionResult.stderr).toBe("");
  }, 240_000);
});
