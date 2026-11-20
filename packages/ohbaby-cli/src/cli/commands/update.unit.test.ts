import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import yargs from "yargs/yargs";
import { runInstallerCommand } from "../../install/child-command.js";
import { detectInstallMethod } from "../../install/install-method.js";
import { getCliPackageVersion } from "../../package-version.js";
import { readAutoUpdate } from "../../update/settings.js";
import * as versionCheck from "../../update/version-check.js";
import type { CliCommandRuntime } from "./types.js";
import { createUpdateCommand, runAutomaticUpdate } from "./update.js";

vi.mock("../../install/child-command.js");
vi.mock("../../install/install-method.js");
vi.mock("../../package-version.js");

let home: string;
let installDir: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ohbaby-update-command-"));
  installDir = join(home, "install");
  await mkdir(installDir);
  await writeFile(join(installDir, "current"), "0.1.18\n");
  vi.mocked(detectInstallMethod).mockReturnValue({
    kind: "script",
    installDir,
  });
  vi.mocked(getCliPackageVersion).mockReturnValue("0.1.18");
});

afterEach(async () => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  await rm(home, { recursive: true, force: true });
});

function createRuntime() {
  const stdout = { write: vi.fn() };
  const stderr = { write: vi.fn() };
  return {
    stdout,
    stderr,
    resolveOhbabyHome: () => home,
    runUpgradePreflight: vi
      .fn<NonNullable<CliCommandRuntime["runUpgradePreflight"]>>()
      .mockResolvedValue({ ok: true, stoppedDaemon: false }),
    initializeProxy: vi.fn(() => Promise.resolve()),
    setExitCode: vi.fn(),
    failUsage(message): never {
      throw new Error(message);
    },
    isStdinTTY: () => false,
  } satisfies Partial<CliCommandRuntime>;
}

async function command(
  args: string[],
  runtime: ReturnType<typeof createRuntime>,
): Promise<void> {
  await yargs(args)
    .command(
      createUpdateCommand(
        runtime as unknown as CliCommandRuntime,
        new PassThrough(),
      ),
    )
    .exitProcess(false)
    .fail((message, error: Error | undefined) => {
      throw error ?? new Error(message);
    })
    .parseAsync();
}

it("changes the automatic update setting independently of install detection, registry or preflight", async () => {
  const runtime = createRuntime();
  await command(["update", "--auto", "on"], runtime);
  expect(readAutoUpdate(home)).toBe(true);
  await command(["update", "--auto", "off"], runtime);
  expect(readAutoUpdate(home)).toBe(false);
  expect(detectInstallMethod).not.toHaveBeenCalled();
  expect(runtime.initializeProxy).not.toHaveBeenCalled();
  expect(runtime.runUpgradePreflight).not.toHaveBeenCalled();
});

it("rejects duplicate auto flags and invalid or conflicting versions without changing settings", async () => {
  const runtime = createRuntime();
  await expect(
    command(["update", "--auto", "on", "--auto", "off"], runtime),
  ).rejects.toThrow(/--auto/);
  await expect(
    command(["update", "0.1.19", "--auto", "on"], runtime),
  ).rejects.toThrow("--auto cannot be used with a target version");
  await expect(command(["update", "^0.1.19"], runtime)).rejects.toThrow(
    "Specify an exact version",
  );
  expect(readAutoUpdate(home)).toBe(false);
  expect(runtime.runUpgradePreflight).not.toHaveBeenCalled();
});

it("accepts the actual version and requires confirmation for a different one", async () => {
  const runtime = createRuntime();
  await command(["update", "0.1.18"], runtime);
  expect(runtime.stdout.write).toHaveBeenCalledWith(
    "ohbaby 0.1.18 is already installed.\n",
  );
  await command(["update", "0.1.19"], runtime);
  expect(runtime.stderr.write).toHaveBeenCalledWith(
    "Pass -y to update in a non-interactive terminal.\n",
  );
  expect(runtime.setExitCode).toHaveBeenCalledWith(1);
  expect(runtime.runUpgradePreflight).not.toHaveBeenCalled();
  expect(runInstallerCommand).not.toHaveBeenCalled();
});

it("does not downgrade to the registry's latest version unless requested explicitly", async () => {
  const runtime = createRuntime();
  const latest = vi
    .spyOn(versionCheck, "fetchLatestVersion")
    .mockResolvedValue("0.1.17");
  try {
    await command(["update", "-y"], runtime);
    expect(runtime.stdout.write).toHaveBeenCalledWith(
      "ohbaby 0.1.18 is already installed.\n",
    );
    expect(runtime.runUpgradePreflight).not.toHaveBeenCalled();

    await command(["update", "0.1.17"], runtime);
    expect(runtime.stdout.write).toHaveBeenCalledWith(
      "Update ohbaby from 0.1.18 to 0.1.17 (script)?\n",
    );
  } finally {
    latest.mockRestore();
  }
});

it("skips automatic updates quietly for an unrecognized installation", async () => {
  const runtime = createRuntime();
  vi.mocked(detectInstallMethod).mockReturnValue({ kind: "other" });
  await expect(
    runAutomaticUpdate({
      ohbabyHome: home,
      currentVersion: "0.1.18",
      targetVersion: "0.1.19",
      runtime: runtime as unknown as CliCommandRuntime,
    }),
  ).resolves.toBe("continue");
  expect(runtime.stderr.write).not.toHaveBeenCalled();
  expect(runtime.runUpgradePreflight).not.toHaveBeenCalled();
});

it("downloads the pinned script before stopping the daemon and forwards its install parameters", async () => {
  const runtime = createRuntime();
  const fetch = vi.fn(() => Promise.resolve(new Response("test installer")));
  vi.stubGlobal("fetch", fetch);
  vi.mocked(runInstallerCommand).mockImplementation(
    async (executable, args, options) => {
      const windows = process.platform === "win32";
      expect(executable).toBe(windows ? "powershell.exe" : "sh");
      if (windows)
        expect(args.slice(0, -1)).toEqual([
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
        ]);
      const script = args.at(-1);
      if (script === undefined) throw new Error("Missing installer file");
      await expect(readFile(script, "utf8")).resolves.toBe("test installer");
      expect(options?.env).toMatchObject({
        OHBABY_INSTALL_VERSION: "0.1.19",
        OHBABY_INSTALL_DIR: installDir,
        OHBABY_NON_INTERACTIVE: "1",
      });
      await writeFile(join(installDir, "current"), "0.1.19\n");
      return { status: "0", output: "" };
    },
  );
  await command(["update", "0.1.19", "-y"], runtime);
  expect(fetch).toHaveBeenCalledWith(
    `https://cdn.jsdelivr.net/npm/ohbaby-cli@0.1.19/install.${process.platform === "win32" ? "ps1" : "sh"}`,
    expect.anything(),
  );
  expect(runtime.runUpgradePreflight).toHaveBeenCalledOnce();
  expect(runInstallerCommand).toHaveBeenCalledOnce();
  expect(runtime.stdout.write).toHaveBeenCalledWith(
    "Updated ohbaby to 0.1.19.\n",
  );
});

it("lets automatic startup continue on download/preflight failure, and exits if a failed installer switched versions", async () => {
  const runtime = createRuntime();
  const update = (): ReturnType<typeof runAutomaticUpdate> =>
    runAutomaticUpdate({
      ohbabyHome: home,
      currentVersion: "0.1.18",
      targetVersion: "0.1.19",
      runtime: runtime as unknown as CliCommandRuntime,
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(null, { status: 503 }))),
  );
  await expect(update()).resolves.toBe("continue");
  expect(runtime.runUpgradePreflight).not.toHaveBeenCalled();

  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("test installer"))),
  );
  vi.mocked(runtime.runUpgradePreflight).mockResolvedValueOnce({
    ok: false,
    reasons: ["there is active work"],
  });
  await expect(update()).resolves.toBe("continue");
  expect(runInstallerCommand).not.toHaveBeenCalled();
  expect(runtime.stderr.write).toHaveBeenCalledWith("there is active work\n");
  runtime.runUpgradePreflight.mockRejectedValueOnce(new Error("unavailable"));
  await expect(update()).resolves.toBe("continue");
  expect(runtime.stderr.write).toHaveBeenCalledWith(
    "Could not check the installation: unavailable\n",
  );

  vi.mocked(runInstallerCommand).mockResolvedValue({ status: "1", output: "" });
  await expect(update()).resolves.toBe("continue");
  expect(runtime.setExitCode).not.toHaveBeenCalled();

  await writeFile(join(installDir, "current"), "0.1.19\n");
  await expect(update()).resolves.toBe("exit");
  expect(runtime.setExitCode).toHaveBeenCalledWith(1);
  expect(runtime.stderr.write).toHaveBeenCalledWith(
    expect.stringContaining("Switched to ohbaby 0.1.19"),
  );
  expect(runtime.stderr.write).toHaveBeenCalledWith(
    expect.stringContaining("ohbaby update --auto off"),
  );
});

it("exits automatic startup once npm has run and failed, but continues if npm never started", async () => {
  const runtime = createRuntime();
  const prefix = join(home, "npm-prefix");
  await mkdir(
    join(
      prefix,
      process.platform === "win32" ? "node_modules" : "lib/node_modules",
    ),
    { recursive: true },
  );
  vi.mocked(detectInstallMethod).mockReturnValue({ kind: "npm", prefix });
  const update = (): ReturnType<typeof runAutomaticUpdate> =>
    runAutomaticUpdate({
      ohbabyHome: home,
      currentVersion: "0.1.18",
      targetVersion: "0.1.19",
      runtime: runtime as unknown as CliCommandRuntime,
    });

  vi.mocked(runInstallerCommand).mockRejectedValueOnce(new Error("ENOENT"));
  await expect(update()).resolves.toBe("continue");
  expect(runtime.setExitCode).not.toHaveBeenCalled();

  vi.mocked(runInstallerCommand).mockResolvedValueOnce({
    status: "1",
    output: "",
  });
  await expect(update()).resolves.toBe("exit");
  expect(runtime.setExitCode).toHaveBeenCalledWith(1);
  expect(runtime.stderr.write).toHaveBeenCalledWith(
    expect.stringContaining("npm install failed (1)"),
  );
  expect(runtime.stderr.write).toHaveBeenCalledWith(
    expect.stringContaining("ohbaby update --auto off"),
  );

  runtime.setExitCode.mockClear();
  vi.mocked(runInstallerCommand)
    .mockResolvedValueOnce({ status: "0", output: "" })
    .mockResolvedValueOnce({ status: "0", output: "0.1.18" });
  await expect(update()).resolves.toBe("exit");
  expect(runtime.setExitCode).toHaveBeenCalledWith(1);
  expect(runtime.stderr.write).toHaveBeenCalledWith(
    expect.stringContaining("Version verification failed"),
  );
});

it("exits automatic startup when a failed script install leaves current unreadable", async () => {
  const runtime = createRuntime();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("test installer"))),
  );
  vi.mocked(runInstallerCommand).mockImplementation(async () => {
    await rm(join(installDir, "current"));
    return { status: "1", output: "" };
  });
  await expect(
    runAutomaticUpdate({
      ohbabyHome: home,
      currentVersion: "0.1.18",
      targetVersion: "0.1.19",
      runtime: runtime as unknown as CliCommandRuntime,
    }),
  ).resolves.toBe("exit");
  expect(runtime.setExitCode).toHaveBeenCalledWith(1);
  expect(runtime.stderr.write).toHaveBeenCalledWith(
    expect.stringContaining("Active version: unknown"),
  );
  expect(runtime.stderr.write).toHaveBeenCalledWith(
    expect.stringContaining("ohbaby update --auto off"),
  );
});
