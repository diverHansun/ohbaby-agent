import { spawn, spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

interface CommandResult {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

interface NpmPackEntry {
  readonly filename: string;
  readonly files?: readonly { readonly path: string }[];
  readonly integrity?: string;
  readonly name: string;
  readonly shasum?: string;
  readonly version?: string;
}

interface PackageJson {
  readonly bin?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly description?: string;
  readonly engines?: Readonly<Record<string, string>>;
  readonly exports?: unknown;
  readonly license?: string;
  readonly main?: string;
  readonly name: string;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly type?: string;
  readonly version: string;
}

interface PackedWorkspacePackage {
  readonly entry: NpmPackEntry;
  readonly packageJson: PackageJson;
  readonly tarballPath: string;
}

interface LocalRegistryPackage {
  readonly entry: NpmPackEntry;
  readonly manifest: PackageJson;
  readonly tarballPath: string;
}

const pinnedRuntimeDependencies = ["ink", "ink-gradient", "react"] as const;
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

function tarCommand(): string {
  return process.platform === "win32" ? "tar.exe" : "tar";
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

async function readInstalledDependencyVersion(
  installedPackage: string,
  dependencyName: string,
): Promise<string> {
  const dependencyPackageJson = JSON.parse(
    await readFile(
      join(installedPackage, "node_modules", dependencyName, "package.json"),
      "utf8",
    ),
  ) as { readonly version?: unknown };

  expect(typeof dependencyPackageJson.version).toBe("string");
  return dependencyPackageJson.version as string;
}

function createPackageManifest(input: {
  readonly baseUrl: string;
  readonly entry: NpmPackEntry;
  readonly packageJson: PackageJson;
}): PackageJson & {
  readonly dist: {
    readonly integrity?: string;
    readonly shasum?: string;
    readonly tarball: string;
  };
} {
  const tarballUrl = new URL(
    `/tarballs/${encodeURIComponent(input.entry.filename)}`,
    input.baseUrl,
  );

  return {
    ...input.packageJson,
    dist: {
      ...(input.entry.integrity ? { integrity: input.entry.integrity } : {}),
      ...(input.entry.shasum ? { shasum: input.entry.shasum } : {}),
      tarball: tarballUrl.toString(),
    },
  };
}

async function startLocalNpmRegistry(
  packages: readonly PackedWorkspacePackage[],
): Promise<{ readonly close: () => Promise<void>; readonly url: string }> {
  const packageMap = new Map<string, LocalRegistryPackage>();
  for (const packedPackage of packages) {
    packageMap.set(packedPackage.packageJson.name, {
      entry: packedPackage.entry,
      manifest: packedPackage.packageJson,
      tarballPath: packedPackage.tarballPath,
    });
  }

  const server = createServer((request, response) => {
    void handleRegistryRequest({
      packageMap,
      request,
      response,
      server,
    });
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });

  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${String(address.port)}/`;
  return {
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolveClose();
        });
      }),
    url,
  };
}

async function handleRegistryRequest(input: {
  readonly packageMap: ReadonlyMap<string, LocalRegistryPackage>;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly server: Server;
}): Promise<void> {
  try {
    const requestUrl = new URL(input.request.url ?? "/", "http://localhost");
    const pathname = requestUrl.pathname;

    if (pathname.startsWith("/tarballs/")) {
      const filename = decodeURIComponent(pathname.slice("/tarballs/".length));
      for (const localPackage of input.packageMap.values()) {
        if (localPackage.tarballPath.endsWith(filename)) {
          streamFile(input.response, localPackage.tarballPath);
          return;
        }
      }
      sendJson(input.response, 404, { error: "tarball not found" });
      return;
    }

    const localPackageRequest = parseLocalPackageRequest(pathname);
    if (localPackageRequest) {
      const localPackage = input.packageMap.get(localPackageRequest.name);
      if (localPackage) {
        if (
          localPackageRequest.version !== undefined &&
          localPackageRequest.version !== localPackage.manifest.version
        ) {
          sendJson(input.response, 404, { error: "version not found" });
          return;
        }
        const baseUrl = registryBaseUrl(input.server);
        const manifest = createPackageManifest({
          baseUrl,
          entry: localPackage.entry,
          packageJson: localPackage.manifest,
        });

        if (localPackageRequest.version) {
          sendJson(input.response, 200, manifest);
          return;
        }

        sendJson(input.response, 200, {
          _id: localPackage.manifest.name,
          "dist-tags": { latest: localPackage.manifest.version },
          name: localPackage.manifest.name,
          versions: {
            [localPackage.manifest.version]: manifest,
          },
        });
        return;
      }
      if (localPackageRequest.name.startsWith("ohbaby-")) {
        sendJson(input.response, 404, { error: "local package not found" });
        return;
      }
    }

    await proxyRegistryRequest(input.request, input.response);
  } catch (error) {
    sendJson(input.response, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseLocalPackageRequest(
  pathname: string,
): { readonly name: string; readonly version?: string } | undefined {
  const parts = pathname
    .split("/")
    .filter((part) => part.length > 0)
    .map(decodeURIComponent);
  if (parts.length === 1) {
    return { name: parts[0] };
  }
  if (parts.length === 2) {
    return { name: parts[0], version: parts[1] };
  }
  return undefined;
}

function registryBaseUrl(server: Server): string {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(address.port)}/`;
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function streamFile(response: ServerResponse, path: string): void {
  response.writeHead(200, { "content-type": "application/octet-stream" });
  createReadStream(path).pipe(response);
}

async function proxyRegistryRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "method not allowed" });
    return;
  }

  const upstream = await fetch(
    new URL(request.url ?? "/", "https://registry.npmjs.org/"),
    {
      headers: request.headers.accept
        ? { accept: String(request.headers.accept) }
        : undefined,
    },
  );
  response.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
  });
  response.end(Buffer.from(await upstream.arrayBuffer()));
}

async function packWorkspacePackage(input: {
  readonly packDestination: string;
  readonly packageDirectory: string;
}): Promise<PackedWorkspacePackage> {
  const result = await runCommand({
    command: pnpmCommand(),
    args: ["pack", "--json", "--pack-destination", input.packDestination],
    cwd: input.packageDirectory,
    timeoutMs: 60_000,
  });
  expectSuccess(result, `pnpm pack ${input.packageDirectory}`);

  const entry = parsePackEntry(result.stdout);
  const tarballPath = resolve(input.packDestination, entry.filename);
  const packageJson = await readPackedPackageJson({
    packDestination: input.packDestination,
    tarballPath,
  });
  expect(packageJson.name).toBe(entry.name);
  if (entry.version !== undefined) {
    expect(packageJson.version).toBe(entry.version);
  }
  expectNoWorkspaceDependencyRanges(packageJson);

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
  return {
    entry,
    packageJson,
    tarballPath,
  };
}

async function readPackedPackageJson(input: {
  readonly packDestination: string;
  readonly tarballPath: string;
}): Promise<PackageJson> {
  const extractDirectory = join(
    input.packDestination,
    `${basename(input.tarballPath)}-contents`,
  );
  await mkdir(extractDirectory, { recursive: true });

  const extractResult = await runCommand({
    command: tarCommand(),
    args: [
      "-xzf",
      input.tarballPath,
      "-C",
      extractDirectory,
      "package/package.json",
    ],
    timeoutMs: 30_000,
  });
  expectSuccess(extractResult, `extract ${input.tarballPath} package.json`);

  return JSON.parse(
    await readFile(join(extractDirectory, "package", "package.json"), "utf8"),
  ) as PackageJson;
}

function expectNoWorkspaceDependencyRanges(packageJson: PackageJson): void {
  const dependencyFields = {
    dependencies: packageJson.dependencies,
    optionalDependencies: packageJson.optionalDependencies,
    peerDependencies: packageJson.peerDependencies,
  };

  for (const [field, dependencies] of Object.entries(dependencyFields)) {
    for (const [name, version] of Object.entries(dependencies ?? {})) {
      expect(
        version,
        `${packageJson.name} ${field}.${name} must be npm-compatible`,
      ).not.toMatch(/^workspace:/u);
    }
  }
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
        "--filter",
        "ohbaby-server",
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
    const serverPack = await packWorkspacePackage({
      packDestination,
      packageDirectory: join(repoRoot, "packages", "ohbaby-server"),
    });
    const cliPack = await packWorkspacePackage({
      packDestination,
      packageDirectory: join(repoRoot, "packages", "ohbaby-cli"),
    });
    const cliPackageJson = cliPack.packageJson;

    const registry = await startLocalNpmRegistry([
      sdkPack,
      agentPack,
      serverPack,
      cliPack,
    ]);

    try {
      const installResult = await runCommand({
        command: npm,
        args: [
          "install",
          "-g",
          "--prefix",
          prefix,
          "--registry",
          registry.url,
          "--no-audit",
          "--no-fund",
          "--ignore-scripts",
          "--loglevel=error",
          `${cliPackageJson.name}@${cliPackageJson.version}`,
        ],
        env: {
          ...process.env,
          npm_config_cache: npmCache,
          npm_config_tmp: npmTmp,
        },
        timeoutMs: 180_000,
      });
      expectSuccess(installResult, "npm install global packed ohbaby-cli");
    } finally {
      await registry.close();
    }

    const installedCliPackage = installedGlobalPackagePath(
      prefix,
      "ohbaby-cli",
    );
    const packageJson = JSON.parse(
      await readFile(
        join(repoRoot, "packages", "ohbaby-cli", "package.json"),
        "utf8",
      ),
    ) as {
      readonly dependencies: Readonly<Record<string, string>>;
      readonly version: string;
    };
    for (const dependencyName of pinnedRuntimeDependencies) {
      const declaredVersion = packageJson.dependencies[dependencyName];
      expect(declaredVersion).toMatch(/^\d+\.\d+\.\d+$/u);
      await expect(
        readInstalledDependencyVersion(installedCliPackage, dependencyName),
      ).resolves.toBe(declaredVersion);
    }

    const cliImportSmokePath = join(
      installedCliPackage,
      "import-ohbaby-packages.mjs",
    );
    await writeFile(
      cliImportSmokePath,
      [
        'const mod = await import("ohbaby-cli");',
        'const agent = await import("ohbaby-agent");',
        'const server = await import("ohbaby-server");',
        'if (typeof mod.renderTerminalUi !== "function") throw new Error("missing renderTerminalUi export");',
        'if (typeof mod.OhbabyTerminalApp !== "function") throw new Error("missing OhbabyTerminalApp export");',
        'if (typeof agent.buildCoreAPIImpl !== "function") throw new Error("missing buildCoreAPIImpl export");',
        'if (typeof server.createRemoteCoreApiHost !== "function") throw new Error("missing createRemoteCoreApiHost export");',
        'if (typeof server.startDaemonServer !== "function") throw new Error("missing startDaemonServer export");',
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
