import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, posix } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import yargs from "yargs/yargs";
import { runInstallerCommand } from "../../install/child-command.js";
import { detectInstallMethod } from "../../install/install-method.js";
import { removeShellPathBlock } from "../../install/script-uninstall.js";
import type { CliCommandRuntime } from "./types.js";
import { createUninstallCommand } from "./uninstall.js";

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: vi.fn(),
}));
vi.mock("../../install/child-command.js");
vi.mock("../../install/install-method.js");
vi.mock("../../install/script-uninstall.js", () => ({
  acquireUninstallLock: vi.fn(() => Promise.resolve(() => Promise.resolve())),
  removeOwnedLauncher: vi.fn(() => Promise.resolve()),
  removeShellPathBlock: vi.fn(() => Promise.resolve()),
  removeWindowsUserPath: vi.fn(() => Promise.resolve()),
  validateUninstallDirectory: vi.fn(() => Promise.resolve()),
}));

const realPlatform = process.platform;
let home: string;
let installDir: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ohbaby-uninstall-command-"));
  installDir = join(home, "install");
  await mkdir(installDir);
  vi.stubEnv("NO_COLOR", "");
  vi.stubEnv("TERM", "xterm-256color");
  vi.stubEnv("COLORTERM", "");
});

afterEach(async () => {
  Object.defineProperty(process, "platform", { value: realPlatform });
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await rm(home, { recursive: true, force: true });
});

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform });
  // Mocking process.platform leaves node:path on the host's path semantics.
  const simulatedHome =
    realPlatform === "win32" && platform !== "win32"
      ? home.replaceAll("\\", "/")
      : home;
  vi.mocked(homedir).mockReturnValue(simulatedHome);
  vi.mocked(detectInstallMethod).mockReturnValue({
    kind: "script",
    installDir:
      platform === "win32" ? installDir : posix.join(simulatedHome, "install"),
  });
}

async function uninstall(
  options: { args?: string[]; stdoutTTY?: boolean; answer?: string } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  const runtime: Partial<CliCommandRuntime> = {
    stdout: { write: (chunk: string) => (stdout += chunk) },
    stderr: { write: (chunk: string) => (stderr += chunk) },
    resolveOhbabyHome: () => join(home, ".ohbaby"),
    resolveOhbabyDataPaths: () => ({
      dataRoot: join(home, ".ohbaby", "data"),
      databasePath: join(home, ".ohbaby", "data", "ohbaby.db"),
    }),
    runUpgradePreflight: () =>
      Promise.resolve({ ok: true as const, stoppedDaemon: false }),
    setExitCode: (code: number) => {
      exitCode = code;
    },
    isStdinTTY: () => options.answer !== undefined,
    isStdoutTTY: () => options.stdoutTTY ?? false,
  };
  const stdin = new PassThrough();
  if (options.answer !== undefined) stdin.end(options.answer + "\n");
  await yargs(["uninstall", ...(options.args ?? ["-y"])])
    .command(
      createUninstallCommand(runtime as unknown as CliCommandRuntime, stdin),
    )
    .exitProcess(false)
    .parseAsync();
  return { stdout, stderr, exitCode };
}

function stepLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => /^\[\d+\/\d+\] /u.test(line));
}

const kept = "Kept your configuration at ";

it("prints one aligned done line per macOS step and says it is uninstalled", async () => {
  setPlatform("darwin");
  const result = await uninstall();
  expect(result.exitCode).toBe(0);
  const steps = stepLines(result.stdout);
  const texts = [
    "Removing the PATH block from ~/.zshrc",
    "Removing the PATH block from ~/.bashrc",
    "Removing the PATH block from ~/.bash_profile",
    "Removing the PATH block from ~/.config/fish/conf.d/ohbaby.fish",
    "Removing the launcher at ~/.local/bin/ohbaby",
    "Removing ~/install",
  ];
  const width = Math.max(...texts.map((text) => text.length));
  expect(steps).toEqual(
    texts.map(
      (text, index) => `[${String(index + 1)}/6] ${text.padEnd(width)}  done`,
    ),
  );
  expect(result.stdout).toMatch(
    /done\n\nohbaby is uninstalled\.\nKept your configuration at /u,
  );
  await expect(stat(installDir)).rejects.toMatchObject({ code: "ENOENT" });
});

it("has no .bash_profile step on Linux", async () => {
  setPlatform("linux");
  const steps = stepLines((await uninstall()).stdout);
  expect(steps).toHaveLength(5);
  expect(steps[0]).toMatch(/^\[1\/5\] /u);
  expect(steps.join("\n")).not.toContain(".bash_profile");
});

it("counts only the PATH step on Windows and ends with the delete commands", async () => {
  setPlatform("win32");
  const result = await uninstall();
  expect(result.exitCode).toBe(0);
  const bin = join(installDir, "bin").replaceAll("/", "\\");
  expect(stepLines(result.stdout)).toEqual([
    `[1/1] Removing ${bin} from your user PATH  done`,
  ]);
  const ending = result.stdout.slice(result.stdout.indexOf("  done\n") + 7);
  expect(ending).toBe(
    "\nohbaby is removed from your PATH. To finish, delete the installation directory after this command exits:\n" +
      `PowerShell: Remove-Item -LiteralPath '${installDir}' -Recurse -Force\n` +
      `cmd: rmdir /s /q "${installDir}"\n` +
      ending.slice(ending.indexOf(kept)),
  );
  expect(ending).toContain(kept);
  expect(result.stdout).not.toContain("ohbaby is uninstalled.");
});

it("leaves the npm line to npm's own output", async () => {
  setPlatform("darwin");
  const prefix = posix.join(homedir(), "npm-global");
  vi.mocked(detectInstallMethod).mockReturnValue({ kind: "npm", prefix });
  vi.mocked(runInstallerCommand).mockResolvedValue({ status: "0", output: "" });
  const result = await uninstall();
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(
    "[1/1] Uninstalling ohbaby-cli from ~/npm-global\n\nohbaby is uninstalled.\n",
  );
  expect(result.stdout).not.toContain("done");
});

it("marks the failed step, reports the error and does not claim success", async () => {
  setPlatform("linux");
  vi.mocked(removeShellPathBlock)
    .mockResolvedValueOnce()
    .mockRejectedValueOnce(new Error("Cannot rewrite ~/.bashrc."));
  const result = await uninstall();
  expect(result.exitCode).toBe(1);
  const steps = stepLines(result.stdout);
  expect(steps).toHaveLength(2);
  expect(steps[0]?.endsWith("  done")).toBe(true);
  expect(steps[1]).toMatch(
    /^\[2\/5\] Removing the PATH block from ~\/\.bashrc +failed$/u,
  );
  expect(result.stderr).toBe("Cannot rewrite ~/.bashrc.\n");
  expect(result.stdout).not.toContain("ohbaby is uninstalled.");
  expect(result.stdout).not.toContain(kept);
});

it("prints only the plan when the user declines", async () => {
  setPlatform("linux");
  const result = await uninstall({ args: [], answer: "n" });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Remove the installation directory at ");
  expect(stepLines(result.stdout)).toEqual([]);
  await expect(stat(installDir)).resolves.toBeDefined();
});

it("colours the step numbers only on a terminal without NO_COLOR", async () => {
  setPlatform("linux");
  expect((await uninstall({ stdoutTTY: false })).stdout).not.toContain("\x1b[");
  await mkdir(installDir);
  const coloured = (await uninstall({ stdoutTTY: true })).stdout;
  expect(coloured).toContain("\x1b[33m[1/5]\x1b[39m Removing ");
  await mkdir(installDir);
  vi.stubEnv("COLORTERM", "truecolor");
  expect((await uninstall({ stdoutTTY: true })).stdout).toContain(
    "\x1b[38;2;212;162;79m[1/5]",
  );
  await mkdir(installDir);
  vi.stubEnv("NO_COLOR", "1");
  expect((await uninstall({ stdoutTTY: true })).stdout).not.toContain("\x1b[");
});
