import { spawn, spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { acquireCliPackageBuildLock } from "./package-build-lock";

interface CommandResult {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

interface RegistryDiagnostic {
  readonly path: string;
  readonly status: number | "aborted" | "error" | "pending";
  readonly durationMs: number;
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

const pinnedRuntimeDependencies = ["ink", "ink-gradient", "react"] as const;
const repoRoot = process.cwd();
const cleanupDirectories: string[] = [];
const closeRegistries: (() => Promise<void>)[] = [];
let releasePackageBuildLock: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const lock = await acquireCliPackageBuildLock();
  releasePackageBuildLock = lock.release;
}, 420_000);

afterAll(async () => {
  await releasePackageBuildLock?.();
  releasePackageBuildLock = undefined;
}, 30_000);

afterEach(async () => {
  await Promise.all(closeRegistries.splice(0).map((close) => close()));
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
          )}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`,
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
  // Native executables accept argv directly; routing a spaced node.exe path
  // through cmd adds an extra quoting layer and breaks the installed smoke.
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/iu.test(command)) {
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
): Promise<{
  readonly close: () => Promise<void>;
  readonly diagnostics: () => readonly RegistryDiagnostic[];
  readonly url: string;
}> {
  const packageMap = new Map<string, PackedWorkspacePackage[]>();
  const tarballs = new Map<string, string>();
  for (const packedPackage of packages) {
    const name = packedPackage.packageJson.name;
    const versions = packageMap.get(name) ?? [];
    versions.push(packedPackage);
    packageMap.set(name, versions);
    tarballs.set(packedPackage.entry.filename, packedPackage.tarballPath);
  }

  const activeRequests = new Set<AbortController>();
  const pendingRequests = new Map<
    AbortController,
    { readonly path: string; readonly startedAt: number }
  >();
  const completedRequests: RegistryDiagnostic[] = [];
  const server = createServer((request, response) => {
    void handleRegistryRequest({
      activeRequests,
      completedRequests,
      pendingRequests,
      packageMap,
      tarballs,
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
    close: async () => {
      for (const controller of activeRequests) controller.abort();
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolveClose();
        });
        setTimeout(() => server.closeAllConnections(), 5_000).unref();
      });
    },
    diagnostics: () => [
      ...completedRequests,
      ...[...pendingRequests.values()].map(({ path, startedAt }) => ({
        durationMs: Date.now() - startedAt,
        path,
        status: "pending" as const,
      })),
    ],
    url,
  };
}

async function handleRegistryRequest(input: {
  readonly activeRequests: Set<AbortController>;
  readonly completedRequests: RegistryDiagnostic[];
  readonly pendingRequests: Map<
    AbortController,
    { readonly path: string; readonly startedAt: number }
  >;
  readonly packageMap: ReadonlyMap<string, readonly PackedWorkspacePackage[]>;
  readonly tarballs: ReadonlyMap<string, string>;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly server: Server;
}): Promise<void> {
  try {
    const requestUrl = new URL(input.request.url ?? "/", "http://localhost");
    const pathname = requestUrl.pathname;

    if (pathname.startsWith("/tarballs/")) {
      const filename = decodeURIComponent(pathname.slice("/tarballs/".length));
      const tarball = input.tarballs.get(filename);
      if (tarball) {
        streamFile(input.response, tarball);
      } else {
        sendJson(input.response, 404, { error: "tarball not found" });
      }
      return;
    }

    const localPackageRequest = parseLocalPackageRequest(pathname);
    if (localPackageRequest) {
      const localPackages = input.packageMap.get(localPackageRequest.name);
      const latest = localPackages?.at(-1);
      if (localPackages && latest) {
        const baseUrl = registryBaseUrl(input.server);
        const manifests = localPackages.map(({ entry, packageJson }) =>
          createPackageManifest({ baseUrl, entry, packageJson }),
        );
        const version = localPackageRequest.version;
        if (version) {
          const requested =
            version === "latest"
              ? manifests.at(-1)
              : manifests.find((manifest) => manifest.version === version);
          if (requested) sendJson(input.response, 200, requested);
          else sendJson(input.response, 404, { error: "version not found" });
          return;
        }

        sendJson(input.response, 200, {
          _id: latest.packageJson.name,
          "dist-tags": { latest: latest.packageJson.version },
          name: latest.packageJson.name,
          versions: Object.fromEntries(
            manifests.map((manifest) => [manifest.version, manifest]),
          ),
        });
        return;
      }
      if (localPackageRequest.name.startsWith("ohbaby-")) {
        sendJson(input.response, 404, { error: "local package not found" });
        return;
      }
    }

    await proxyRegistryRequest(input);
  } catch (error) {
    if (!input.response.destroyed && !input.response.headersSent) {
      sendJson(input.response, 502, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
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

async function proxyRegistryRequest(input: {
  readonly activeRequests: Set<AbortController>;
  readonly completedRequests: RegistryDiagnostic[];
  readonly pendingRequests: Map<
    AbortController,
    { readonly path: string; readonly startedAt: number }
  >;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
}): Promise<void> {
  if (input.request.method !== "GET") {
    sendJson(input.response, 405, { error: "method not allowed" });
    return;
  }

  const upstreamUrl = new URL(
    input.request.url ?? "/",
    "https://registry.npmjs.org/",
  );
  const path = upstreamUrl.pathname;
  const controller = new AbortController();
  const startedAt = Date.now();
  let status: RegistryDiagnostic["status"] = "error";
  input.activeRequests.add(controller);
  input.pendingRequests.set(controller, { path, startedAt });
  const timeout = setTimeout(() => controller.abort(), 120_000);
  const onClose = (): void => controller.abort();
  input.response.once("close", onClose);
  try {
    const upstream = await fetch(upstreamUrl, {
      headers: input.request.headers.accept
        ? { accept: String(input.request.headers.accept) }
        : undefined,
      signal: controller.signal,
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    if (!input.response.destroyed) {
      input.response.writeHead(upstream.status, {
        "content-type":
          upstream.headers.get("content-type") ?? "application/json",
      });
      input.response.end(body);
    }
    status = upstream.status;
  } catch (error) {
    status = controller.signal.aborted ? "aborted" : "error";
    throw new Error(
      `registry upstream ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
    input.response.off("close", onClose);
    input.activeRequests.delete(controller);
    input.pendingRequests.delete(controller);
    input.completedRequests.push({
      durationMs: Date.now() - startedAt,
      path,
      status,
    });
  }
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

function expectCliPackIncludesWebAssets(entry: NpmPackEntry): void {
  const packedFiles = entry.files?.map((file) => file.path) ?? [];
  expect(packedFiles).toContain("dist/web/index.html");
  expect(packedFiles).toContain("install.sh");
  expect(packedFiles).toContain("install.ps1");
  expect(
    packedFiles.some((path) => path.startsWith("dist/web/assets/")),
    "ohbaby-cli package must include built ohbaby-web assets",
  ).toBe(true);
  expect(
    packedFiles.some((path) => path.startsWith("dist/web/types/")),
    "browser assets should not include TypeScript declaration output",
  ).toBe(false);
}

describe("npm packed CLI smoke", () => {
  it("installs the packed ohbaby-cli tarball globally and exposes ohbaby help and version", async () => {
    const tempRoot = await tempDirectory("ohbaby-packaging-smoke-");
    try {
      await runPackedCliSmoke(tempRoot);
    } catch (error) {
      const index = cleanupDirectories.indexOf(tempRoot);
      if (index !== -1) cleanupDirectories.splice(index, 1);
      throw new Error(
        `Packed CLI smoke failed; diagnostic files retained at ${tempRoot}`,
        {
          cause: error,
        },
      );
    }
  }, 600_000);
});

async function runPackedCliSmoke(tempRoot: string): Promise<void> {
  const packDestination = join(tempRoot, "pack");
  // Opt-in reuse avoids re-downloading large registry dependencies on retries.
  // The install prefix and locally packed workspace artifacts remain fresh.
  const npmCache = process.env.OHBABY_PACKAGING_NPM_CACHE
    ? resolve(process.env.OHBABY_PACKAGING_NPM_CACHE)
    : join(tempRoot, "npm-cache");
  const npmTmp = join(tempRoot, "npm-tmp");
  const prefix = join(tempRoot, "prefix");
  const npm = npmCommand();
  const ohbabyHome = join(tempRoot, "ohbaby-home");
  const xdgDataHome = join(tempRoot, "xdg-data");
  const cliCwd = join(tempRoot, "cli-cwd");
  const isolatedEnv = {
    ...process.env,
    // pnpm's Vitest launcher exposes workspace dependencies through NODE_PATH.
    // Installed-package checks must resolve only their installed dependency tree.
    NODE_PATH: "",
    OHBABY_HOME: ohbabyHome,
    OHBABY_DB_PATH: join(xdgDataHome, "ohbaby-test.db"),
    OHBABY_NO_UPDATE_CHECK: "1",
    XDG_DATA_HOME: xdgDataHome,
  };
  await mkdir(packDestination, { recursive: true });
  await mkdir(npmCache, { recursive: true });
  await mkdir(npmTmp, { recursive: true });
  await mkdir(ohbabyHome, { recursive: true });
  await mkdir(xdgDataHome, { recursive: true });
  await mkdir(cliCwd, { recursive: true });

  if (process.env.OHBABY_TEST_SKIP_PACKAGE_BUILD !== "1") {
    const buildResult = await runCommand({
      command: pnpmCommand(),
      args: [
        "-r",
        "--filter",
        "ohbaby-sdk",
        "--filter",
        "ohbaby-llm",
        "--filter",
        "ohbaby-cli",
        "--filter",
        "ohbaby-agent",
        "--filter",
        "ohbaby-server",
        "--sort",
        "build",
      ],
      timeoutMs: 180_000,
    });
    expectSuccess(buildResult, "pnpm package build");
  }

  const sdkPack = await packWorkspacePackage({
    packDestination,
    packageDirectory: join(repoRoot, "packages", "ohbaby-sdk"),
  });
  const llmPack = await packWorkspacePackage({
    packDestination,
    packageDirectory: join(repoRoot, "packages", "ohbaby-llm"),
  });
  const agentPack = await packWorkspacePackage({
    packDestination,
    packageDirectory: join(repoRoot, "packages", "ohbaby-agent"),
  });
  expect(agentPack.packageJson.dependencies).not.toHaveProperty(
    "tree-sitter-bash",
  );
  expect(agentPack.packageJson.dependencies).not.toHaveProperty(
    "tree-sitter-powershell",
  );
  const serverPack = await packWorkspacePackage({
    packDestination,
    packageDirectory: join(repoRoot, "packages", "ohbaby-server"),
  });
  const cliPack = await packWorkspacePackage({
    packDestination,
    packageDirectory: join(repoRoot, "packages", "ohbaby-cli"),
  });
  expectCliPackIncludesWebAssets(cliPack.entry);
  const cliPackageJson = cliPack.packageJson;
  const target = await repackCliVersion(cliPack, packDestination);

  // Both versions share one registry URL so npm can reuse the first install's
  // cached dependency metadata and artifacts during the upgrade.
  const registry = await startLocalNpmRegistry([
    sdkPack,
    llmPack,
    agentPack,
    serverPack,
    cliPack,
    target,
  ]);
  closeRegistries.push(registry.close);

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
        ...isolatedEnv,
        npm_config_cache: npmCache,
        npm_config_tmp: npmTmp,
      },
      cwd: cliCwd,
      // A clean cache downloads every transitive/platform manifest and tarball.
      // Keep this network-install budget separate from runtime search deadlines.
      timeoutMs: 360_000,
    });
    expectSuccess(installResult, "npm install global packed ohbaby-cli");
  } catch (error) {
    await writeFile(
      join(tempRoot, "registry-diagnostics.json"),
      JSON.stringify(registry.diagnostics(), null, 2),
      "utf8",
    );
    throw error;
  }

  const installedCliPackage = installedGlobalPackagePath(prefix, "ohbaby-cli");
  await expect(
    readFile(join(installedCliPackage, "dist", "web", "index.html"), "utf8"),
  ).resolves.toContain("<!doctype html>");
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
    env: isolatedEnv,
    timeoutMs: 30_000,
  });
  expectSuccess(cliImportResult, "import installed ohbaby packages");
  expect(cliImportResult.stdout).toBe("");
  expect(cliImportResult.stderr).toBe("");

  if (process.platform === "win32") {
    const jobSmokePath = join(
      installedCliPackage,
      "installed-windows-job-smoke.mjs",
    );
    await writeFile(
      jobSmokePath,
      await readFile(
        join(
          repoRoot,
          "tests/integration/cli/fixtures/installed-windows-job-smoke.mjs",
        ),
      ),
    );
    const jobResult = await runCommand({
      command: process.execPath,
      args: [jobSmokePath],
      cwd: cliCwd,
      env: isolatedEnv,
      timeoutMs: 45_000,
    });
    expectSuccess(
      jobResult,
      "installed Windows shell cleanup and next-turn read",
    );
    expect(JSON.parse(jobResult.stdout)).toEqual({
      bash: true,
      nextTurnRead: true,
      disposed: true,
    });
  }

  // The package must supply rg even when lifecycle scripts and system rg are
  // unavailable. Probe the actual installed tool, not the development PATH.
  const grepSmokePath = join(installedCliPackage, "installed-grep-smoke.mjs");
  await writeFile(
    grepSmokePath,
    await readFile(
      join(repoRoot, "tests/integration/cli/fixtures/installed-grep-smoke.mjs"),
    ),
  );
  const grepResult = await runCommand({
    command: process.execPath,
    args: [grepSmokePath],
    cwd: cliCwd,
    env: {
      ...isolatedEnv,
      PATH: "",
      Path: "",
      RIPGREP_CONFIG_PATH: "nonexistent-config",
    },
    timeoutMs: 30_000,
  });
  expectSuccess(grepResult, "search from installed package without system rg");
  const installedSearch = JSON.parse(grepResult.stdout) as {
    searched: boolean;
    binary: string;
    parsed: boolean;
    globbed: boolean;
    grammarAssets: string;
  };
  expect(installedSearch.searched).toBe(true);
  expect(installedSearch.parsed).toBe(true);
  expect(installedSearch.globbed).toBe(true);
  for (const grammar of ["bash", "powershell"] as const) {
    const asset = join(
      installedSearch.grammarAssets,
      `tree-sitter-${grammar}.wasm`,
    );
    const hiddenAsset = `${asset}.missing-test`;
    await rename(asset, hiddenAsset);
    try {
      const parserMissing = await runCommand({
        command: process.execPath,
        args: [
          grepSmokePath,
          "--expect-parser-unavailable",
          ...(grammar === "powershell" ? ["--powershell"] : []),
        ],
        cwd: cliCwd,
        env: isolatedEnv,
        timeoutMs: 30_000,
      });
      expectSuccess(
        parserMissing,
        "start installed runtime with missing grammar asset",
      );
      expect(JSON.parse(parserMissing.stdout).parserUnavailable).toBe(true);
    } finally {
      await rename(hiddenAsset, asset);
    }
  }
  const platformPackage = await realpath(
    dirname(dirname(installedSearch.binary)),
  );
  expect(platformPackage.startsWith(await realpath(installedCliPackage))).toBe(
    true,
  );
  const hiddenPlatformPackage = platformPackage + ".missing-test";
  await rename(platformPackage, hiddenPlatformPackage);
  try {
    const missingResult = await runCommand({
      command: process.execPath,
      args: [grepSmokePath, "--expect-unavailable"],
      cwd: cliCwd,
      env: { ...isolatedEnv, PATH: "", Path: "" },
      timeoutMs: 30_000,
    });
    expectSuccess(
      missingResult,
      "start installed runtime with missing optional rg platform package",
    );
    expect(JSON.parse(missingResult.stdout).unavailable).toBe(true);
  } finally {
    await rename(hiddenPlatformPackage, platformPackage);
  }

  const ohbaby = installedOhbabyPath(prefix);
  const helpResult = await runCommand({
    command: ohbaby,
    args: ["--help"],
    cwd: cliCwd,
    env: isolatedEnv,
    timeoutMs: 30_000,
  });
  expectSuccess(helpResult, "ohbaby --help");
  expect(helpResult.stdout).toContain("ohbaby run [prompt..]");
  expect(helpResult.stdout).toContain("ohbaby serve");
  expect(helpResult.stdout).toContain("ohbaby update [targetVersion]");
  expect(helpResult.stdout).toContain("ohbaby uninstall");
  expect(helpResult.stdout).not.toContain("-p, --prompt");
  expect(helpResult.stderr).toBe("");

  const versionResult = await runCommand({
    command: ohbaby,
    args: ["--version"],
    cwd: cliCwd,
    env: isolatedEnv,
    timeoutMs: 30_000,
  });
  expectSuccess(versionResult, "ohbaby --version");
  expect(versionResult.stdout).toBe(`${packageJson.version}\n`);
  expect(versionResult.stderr).toBe("");

  try {
    const updateEnv = {
      ...isolatedEnv,
      npm_config_registry: registry.url,
      npm_config_prefer_offline: "true",
      npm_config_loglevel: "verbose",
      npm_config_cache: npmCache,
      npm_config_tmp: npmTmp,
      npm_config_ignore_scripts: "true",
      npm_config_audit: "false",
      npm_config_fund: "false",
    };
    const updateInvocation = {
      command: ohbaby,
      cwd: cliCwd,
      env: updateEnv,
      timeoutMs: 180_000,
    };
    const probe = join(tempRoot, "check-update-native-load.cjs");
    await writeFile(
      probe,
      [
        'if (process.argv[2] === "update") {',
        '  process.dlopen = () => { throw new Error("update loaded a native addon"); };',
        "}",
      ].join("\n"),
    );
    const verifyUpdate = {
      ...updateInvocation,
      command: process.execPath,
      env: { ...updateEnv, NODE_OPTIONS: "" },
    };
    const entrypoint = join(installedCliPackage, "dist", "bin.js");
    expectSuccess(
      await runCommand({
        ...verifyUpdate,
        args: ["-r", probe, entrypoint, "update", "--help"],
      }),
      "ohbaby update --help without native addons",
    );
    const updateResult = await runCommand({
      ...verifyUpdate,
      args: ["-r", probe, entrypoint, "update", "-y"],
    });
    expectSuccess(updateResult, "ohbaby update from local registry");
    expect(updateResult.stdout).toContain(
      `Updated ohbaby to ${target.packageJson.version}.`,
    );
    const installedVersion = await runCommand({
      ...updateInvocation,
      args: ["--version"],
    });
    expectSuccess(installedVersion, "ohbaby --version after update");
    expect(installedVersion.stdout.trim()).toBe(target.packageJson.version);
    const futureDatabase = new (process.getBuiltinModule(
      "node:sqlite",
    ).DatabaseSync)(isolatedEnv.OHBABY_DB_PATH);
    try {
      futureDatabase.exec(
        "CREATE TABLE IF NOT EXISTS migration (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);" +
          "INSERT INTO migration VALUES ('999_future', 0);",
      );
    } finally {
      futureDatabase.close();
    }
    for (const args of [
      ["run", "test"],
      ["serve", "--port", "0", "--no-open"],
    ]) {
      const incompatible = await runCommand({
        ...updateInvocation,
        args,
        timeoutMs: 30_000,
      });
      expect(incompatible.code).toBe(1);
      expect(incompatible.stderr).toContain("unknown migrations: 999_future");
      expect(incompatible.stderr).toContain("Run ohbaby update");
      expect(incompatible.stderr).not.toContain(
        "DatabaseNewerThanProgramError",
      );
    }
    expectSuccess(
      await runCommand({
        ...updateInvocation,
        args: ["update", target.packageJson.version, "-y"],
      }),
      "update remains available against a newer database",
    );

    const retained = join(ohbabyHome, "keep-configuration.txt");
    await writeFile(retained, "keep this");
    expectSuccess(
      await runCommand({ ...updateInvocation, args: ["uninstall", "-y"] }),
      "ohbaby uninstall",
    );
    await expect(readFile(retained, "utf8")).resolves.toBe("keep this");
    await expect(
      readFile(join(installedCliPackage, "package.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } catch (error) {
    const requests = registry.diagnostics();
    await writeFile(
      join(tempRoot, "registry-diagnostics.json"),
      JSON.stringify(requests, null, 2),
      "utf8",
    );
    const incomplete = requests.filter(
      ({ status }) => typeof status !== "number" || status >= 500,
    );
    throw new Error(
      `Packaged CLI maintenance failed. Incomplete registry requests: ${JSON.stringify(incomplete.slice(-12))}`,
      { cause: error },
    );
  }
}

async function repackCliVersion(
  pack: PackedWorkspacePackage,
  directory: string,
): Promise<PackedWorkspacePackage> {
  // Reuse the real compiled CLI and its dependency graph in both versions.
  const source = join(directory, "second-version");
  await mkdir(source);
  expectSuccess(
    await runCommand({
      command: tarCommand(),
      args: ["-xzf", pack.tarballPath, "-C", source],
    }),
    "extract CLI fixture for its second version",
  );
  const version = "999.0.0";
  const packageJson = { ...pack.packageJson, version };
  await writeFile(
    join(source, "package", "package.json"),
    JSON.stringify(packageJson),
  );
  const filename = `ohbaby-cli-${version}.tgz`;
  const tarballPath = join(directory, filename);
  expectSuccess(
    await runCommand({
      command: tarCommand(),
      args: ["-czf", tarballPath, "-C", source, "package"],
    }),
    "pack CLI fixture for its second version",
  );
  const tarball = await readFile(tarballPath);
  return {
    entry: {
      name: "ohbaby-cli",
      version,
      filename,
      integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
      shasum: createHash("sha1").update(tarball).digest("hex"),
    },
    packageJson,
    tarballPath,
  };
}
