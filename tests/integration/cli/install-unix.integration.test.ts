import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const installScript = resolve("packages/ohbaby-cli/install.sh");
const first = "0.0.0-install.1";
const second = "0.0.0-install.2";
const bad = "0.0.0-install.bad";
const missing = "0.0.0-install.missing";
const deadPid = 2147483647;
const nodeVersion = "24.22.3";
const pathMarker = "# >>> ohbaby installer >>>";
const daemonLock = join("server", "daemon.pid");
const systemPath = "/usr/bin:/bin";
const platformLabel = `${process.platform === "darwin" ? "darwin" : "linux"}-${
  process.arch === "arm64" ? "arm64" : "x64"
}`;
const sshNote =
  "For non-login SSH commands without the updated PATH, use the launcher path directly.";

function expectInOrder(text: string, parts: string[]): void {
  let from = 0;
  for (const part of parts) {
    const at = text.indexOf(part, from);
    expect(
      at,
      `${JSON.stringify(part)} after offset ${String(from)} in:\n${text}`,
    ).toBeGreaterThanOrEqual(0);
    from = at + part.length;
  }
}

function summaryRow(stdout: string, name: string): string | undefined {
  return stdout
    .split("\n")
    .find((line) => line.startsWith(`  ${name.padEnd(8)}  `))
    ?.slice(12);
}

describe.skipIf(process.platform === "win32")("POSIX CLI installer", () => {
  let root: string;
  let home: string;
  let installDir: string;
  let ohbabyHome: string;
  let launcher: string;
  let lock: string;
  let mirror: string;
  let archiveServer: Server;
  let corruptArchive: boolean;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ohbaby-install-unix-"));
    home = join(root, "home");
    ohbabyHome = join(home, "config");
    installDir = join(root, "安 装'cli");
    launcher = join(home, ".local", "bin", "ohbaby");
    lock = `${installDir}.lock`;
    corruptArchive = false;
    await mkdir(join(ohbabyHome, "server"), { recursive: true });

    // Tiny distribution with the same layout as the official Node tarball.
    // The npm CLI fixture makes failure points deterministic without a network.
    const distribution = join(root, "node-fixture");
    const npmBin = join(distribution, "lib", "node_modules", "npm", "bin");
    await mkdir(join(distribution, "bin"), { recursive: true });
    await mkdir(npmBin, { recursive: true });
    await writeFile(
      join(distribution, "bin", "node"),
      `#!/bin/sh
if [ "$1" = --version ]; then printf '%s\\n' v${nodeVersion}; exit 0; fi
exec "$TEST_REAL_NODE" "$@"
`,
      { mode: 0o755 },
    );
    await writeFile(
      join(npmBin, "npm-cli.js"),
      `
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const [action, ...args] = process.argv.slice(2);
if (action === "view") {
  const version = args[0].split("@")[1];
  if (version === "${missing}") process.exit(1);
  const showVersion = () => console.log(version === "latest" ? "${first}" : version);
  if (process.env.TEST_PAUSE_VIEW === "1") setTimeout(showVersion, 1000);
  else showVersion();
} else if (action === "install") {
  if (!args.includes("--ignore-scripts") || !args.includes("--omit=dev")) process.exit(1);
  const prefix = args[args.indexOf("--prefix") + 1];
  const version = args.at(-1).split("@")[1];
  const dist = join(prefix, "node_modules", "ohbaby-cli", "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "bin.js"), version === "${bad}" ?
    "process.exit(1)" : "console.log(" + JSON.stringify(version) + ")");
  if (process.env.TEST_DAEMON_RECORD) {
    writeFileSync(join(process.env.OHBABY_HOME, "server", "daemon.pid"), process.env.TEST_DAEMON_RECORD);
  }
} else {
  process.exit(1);
}
`,
    );
    const archivePath = join(root, "node.tar.gz");
    await exec("tar", ["-czf", archivePath, "-C", root, "node-fixture"]);
    const archive = await readFile(archivePath);
    const checksum = createHash("sha256").update(archive).digest("hex");
    archiveServer = createServer((request, response) => {
      if (request.url?.endsWith("SHASUMS256.txt")) {
        const platform = process.platform === "darwin" ? "darwin" : "linux";
        const archiveChecksums = ["arm64", "x64"].flatMap((arch) => {
          const expected = `node-v${nodeVersion}-${platform}-${arch}`;
          return [
            `${checksum}  ${expected}.tar.gz`,
            `${checksum}  ${expected}.tar.xz`,
          ];
        });
        response.end(archiveChecksums.join("\n") + "\n");
      } else {
        response.end(corruptArchive ? "damaged archive" : archive);
      }
    });
    await new Promise<void>((done) =>
      archiveServer.listen(0, "127.0.0.1", done),
    );
    const address = archiveServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Node mirror did not open a TCP port");
    }
    mirror = `http://127.0.0.1:${String(address.port)}`;
  });

  afterEach(async () => {
    if (archiveServer) {
      await new Promise<void>((done) => archiveServer.close(() => done()));
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  function installerEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return {
      PATH: systemPath,
      HOME: home,
      SHELL: "/bin/zsh",
      OHBABY_HOME: ohbabyHome,
      OHBABY_INSTALL_DIR: installDir,
      OHBABY_NODE_MIRROR: mirror,
      OHBABY_NON_INTERACTIVE: "1",
      TEST_REAL_NODE: process.execPath,
      ...overrides,
    };
  }

  async function install(overrides: NodeJS.ProcessEnv = {}) {
    try {
      const result = await exec("sh", [installScript], {
        env: installerEnv(overrides),
        timeout: 8_000,
      });
      return { code: 0, ...result };
    } catch (error) {
      const result = error as {
        code?: number;
        stderr?: string;
        stdout?: string;
      };
      return {
        code: result.code,
        stderr: result.stderr,
        stdout: result.stdout,
      };
    }
  }

  function daemonPidRecord(pid: number): string {
    return JSON.stringify(
      { pid, token: "daemon-instance", startedAt: 1 },
      null,
      2,
    );
  }

  async function currentVersion(): Promise<string> {
    return (await readFile(join(installDir, "current"), "utf8")).trimEnd();
  }

  async function runLauncher(): Promise<string> {
    const { stdout } = await exec(launcher, ["--version"], {
      env: installerEnv({ OHBABY_INSTALL_DIR: undefined }),
      timeout: 5_000,
    });
    return stdout.trimEnd();
  }

  it("installs and reruns without rewriting the launcher or release", async () => {
    const initial = await install();
    expect(initial).toMatchObject({ code: 0, stderr: "" });
    const stdout = initial.stdout ?? "";
    expectInOrder(stdout, [
      "[1/4] Checking the current installation\n",
      `[2/4] Downloading Node.js ${nodeVersion} for ${platformLabel}\n`,
      `      Node.js ${nodeVersion}  `,
      " MB  verified\n",
      `[3/4] Installing ohbaby ${first}\n`,
      `[4/4] Activating ohbaby ${first}\n`,
      `\nInstalled ohbaby ${first}.\n`,
      "  Launcher  ~/.local/bin/ohbaby\n",
      '  PATH      Added to ~/.zshrc. For this terminal, run: export PATH="$HOME/.local/bin:$PATH"\n',
      "  Start     ~/.local/bin/ohbaby\n",
    ]);
    expect(stdout).not.toMatch(/[\x1b\r]/u);
    for (const removed of ["Activated ohbaby", "Launcher: ", installDir]) {
      expect(stdout).not.toContain(removed);
    }
    if (process.platform === "linux") {
      expect(stdout.trimEnd().split("\n").at(-1)).toBe(sshNote);
    } else {
      expect(stdout).not.toContain(sshNote);
    }
    expect(await currentVersion()).toBe(first);
    expect(await readFile(join(installDir, "current"))).toEqual(
      Buffer.from(first + "\n"),
    );
    expect(
      await readFile(
        join(installDir, "releases", first, "node-version"),
        "utf8",
      ),
    ).toBe(nodeVersion + "\n");
    expect(await runLauncher()).toBe(first);
    expect(await readFile(launcher, "utf8")).toMatch(
      /^#!\/bin\/sh\n# ohbaby-launcher 1\n[\x00-\x7f]+$/u,
    );
    await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });

    const launcherBefore = await stat(launcher);
    const release = join(installDir, "releases", first);
    const releaseBefore = await stat(release);
    const rerun = await install();
    expect(rerun).toMatchObject({ code: 0, stderr: "" });
    expectInOrder(rerun.stdout ?? "", [
      "[1/4] Checking the current installation\n",
      `[2/4] Node.js ${nodeVersion} is already present\n`,
      `[3/4] ohbaby ${first} is already installed\n`,
      `[4/4] Activating ohbaby ${first}\n`,
      `\nohbaby ${first} is already installed.\n`,
    ]);
    expect(rerun.stdout).not.toContain("verified");
    expect((await stat(launcher)).ino).toBe(launcherBefore.ino);
    expect((await stat(release)).mtimeMs).toBe(releaseBefore.mtimeMs);
    expect(
      (await readFile(join(home, ".zshrc"), "utf8")).split(pathMarker),
    ).toHaveLength(2);
  });

  it("keeps the previous release and removes unused versions after switching", async () => {
    expect((await install({ OHBABY_NO_MODIFY_PATH: "1" })).code).toBe(0);
    const releases = join(installDir, "releases");
    const unusedRelease = join(releases, "0.0.0-install.old");
    const partialRelease = join(releases, "0.0.1.partial");
    const unusedNode = join(installDir, "runtime", "node-v24.0.0");
    const trash = join(releases, ".trash-leftover");
    await Promise.all(
      [unusedRelease, partialRelease, unusedNode, trash].map((path) =>
        mkdir(path),
      ),
    );
    const result = await install({
      OHBABY_INSTALL_VERSION: second,
      OHBABY_NO_MODIFY_PATH: "1",
    });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain(
      `\nUpdated ohbaby from ${first} to ${second}.\n`,
    );
    expect(summaryRow(result.stdout ?? "", "PATH")).toBe(
      "Not changed. Add ~/.local/bin to PATH, or run the launcher directly.",
    );
    expect(await currentVersion()).toBe(second);
    expect(await runLauncher()).toBe(second);
    expect((await stat(join(releases, first))).isDirectory()).toBe(true);
    for (const removed of [
      unusedRelease,
      partialRelease,
      unusedNode,
      trash,
      join(home, ".zshrc"),
    ]) {
      await expect(stat(removed)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("keeps the old version when the registry, smoke test or final daemon check fails", async () => {
    expect((await install()).code).toBe(0);
    expect(await install({ OHBABY_INSTALL_VERSION: missing })).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("may not have synced"),
    });
    expect(await install({ OHBABY_INSTALL_VERSION: bad })).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("did not pass the version check"),
    });
    expect(
      await install({
        OHBABY_INSTALL_VERSION: second,
        TEST_DAEMON_RECORD: daemonPidRecord(process.pid),
      }),
    ).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("ohbaby serve stop"),
    });
    // The daemon record left by the last run stops this one at the first check.
    const earlyFailure = await install();
    await rm(join(ohbabyHome, daemonLock));
    expect(earlyFailure.code).toBe(1);
    expect(earlyFailure.stderr).toMatch(/^ohbaby installer: [^\n]*\n$/u);
    expect(earlyFailure.stdout).toBe(
      "[1/4] Checking the current installation\n",
    );
    expect(await currentVersion()).toBe(first);
    expect(await runLauncher()).toBe(first);
    await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes a custom-directory launcher only after the new install is usable", async () => {
    expect((await install()).code).toBe(0);
    const otherDir = join(root, "other");
    expect(
      await install({
        OHBABY_INSTALL_DIR: otherDir,
        OHBABY_INSTALL_VERSION: second,
        TEST_DAEMON_RECORD: daemonPidRecord(process.pid),
      }),
    ).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("ohbaby serve stop"),
    });
    await expect(stat(join(otherDir, "current"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await runLauncher()).toBe(first);
    await rm(join(ohbabyHome, daemonLock));
    expect(
      await install({
        OHBABY_INSTALL_DIR: otherDir,
        OHBABY_INSTALL_VERSION: second,
      }),
    ).toMatchObject({ code: 0, stderr: "" });
    expect(await runLauncher()).toBe(second);
  });

  it("edits the supported shell configurations once and skips when PATH already contains the launcher", async () => {
    const inPath = await install({
      SHELL: "/bin/bash",
      PATH: join(home, ".local", "bin") + ":" + systemPath,
    });
    expect(inPath).toMatchObject({
      code: 0,
      stdout: expect.stringContaining("is already in PATH"),
    });
    expect(summaryRow(inPath.stdout ?? "", "PATH")).toBe(
      "~/.local/bin is already in PATH.",
    );
    expect(summaryRow(inPath.stdout ?? "", "Start")).toBe("ohbaby");
    // A trailing slash makes command -v print ".../bin//ohbaby".
    const slashed = await install({
      SHELL: "/bin/bash",
      PATH: join(home, ".local", "bin") + "/:" + systemPath,
    });
    expect(summaryRow(slashed.stdout ?? "", "Start")).toBe("ohbaby");
    const unknownShell = await install({ SHELL: "/bin/tcsh" });
    expect(summaryRow(unknownShell.stdout ?? "", "PATH")).toBe(
      "Not changed. Add ~/.local/bin to PATH, or run the launcher directly.",
    );
    expect(summaryRow(unknownShell.stdout ?? "", "Start")).toBe(
      "~/.local/bin/ohbaby",
    );
    await expect(stat(join(home, ".bashrc"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const notes = new Map<string, string | undefined>();
    for (const shell of ["bash", "fish", "bash", "fish"]) {
      const result = await install({ SHELL: "/bin/" + shell });
      expect(result.code).toBe(0);
      notes.set(shell, summaryRow(result.stdout ?? "", "PATH"));
    }
    expect(notes.get("bash")).toBe(
      `Added to ~/.bashrc${
        process.platform === "darwin" ? " and ~/.bash_profile" : ""
      }. For this terminal, run: export PATH="$HOME/.local/bin:$PATH"`,
    );
    expect(notes.get("fish")).toBe(
      'Added to ~/.config/fish/conf.d/ohbaby.fish. For this terminal, run: set -gx PATH "$HOME/.local/bin" $PATH',
    );
    const files = [
      join(home, ".bashrc"),
      join(home, ".config", "fish", "conf.d", "ohbaby.fish"),
    ];
    if (process.platform === "darwin") files.push(join(home, ".bash_profile"));
    for (const file of files) {
      const content = await readFile(file, "utf8");
      expect(content.startsWith(pathMarker)).toBe(true);
      expect(content.split(pathMarker)).toHaveLength(2);
    }
  });

  it("blocks live, malformed and recovering installations and serializes stale takeover", async () => {
    await mkdir(lock);
    const lockPid = join(lock, "pid");
    for (const pid of [String(process.pid), ""]) {
      await writeFile(lockPid, pid + "\n");
      const result = await install();
      expect(result).toMatchObject({
        code: 1,
        stderr: expect.stringContaining(
          "Install lock is active or cannot be verified",
        ),
      });
      // The exit trap is already set here. Under set -u, any cleanup variable
      // that is not initialized yet would add a second error line.
      expect(result.stderr).toMatch(/^ohbaby installer: [^\n]*\n$/u);
      expect(await readFile(lockPid, "utf8")).toBe(pid + "\n");
    }
    await writeFile(lockPid, String(deadPid) + "\n");
    await mkdir(lock + ".reclaim");
    expect(await install()).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Install recovery lock exists"),
    });
    await rm(lock + ".reclaim", { recursive: true });

    const results = await Promise.all([
      install({ TEST_PAUSE_VIEW: "1" }),
      install({ TEST_PAUSE_VIEW: "1" }),
    ]);
    expect(
      results.map((result) => result.code).sort(),
      JSON.stringify(results),
    ).toEqual([0, 1]);
    expect(await currentVersion()).toBe(first);
    await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(lock + ".reclaim")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["install", "recovery"] as const)(
    "rejects a silent mkdir success for a contested %s lock",
    async (kind) => {
      const fakeBin = join(root, "fake-bin");
      await mkdir(fakeBin);
      await writeFile(
        join(fakeBin, "mkdir"),
        `#!/bin/sh
for arg do target=$arg; done
if [ "$target" = "$TEST_CONTESTED_LOCK" ]; then
  if [ ! -d "$target" ]; then /bin/mkdir "$target" || exit 1; fi
  exit 0
fi
exec /bin/mkdir "$@"
`,
        { mode: 0o755 },
      );
      await mkdir(lock);
      const owner = kind === "install" ? process.pid : deadPid;
      const pidFile = join(lock, "pid");
      await writeFile(pidFile, String(owner) + "\n");
      const canonicalLock = await realpath(lock);
      const contested =
        kind === "install" ? canonicalLock : canonicalLock + ".reclaim";

      const result = await install({
        PATH: fakeBin + ":" + systemPath,
        TEST_CONTESTED_LOCK: contested,
      });
      expect(result).toMatchObject({
        code: 1,
        stderr: expect.stringContaining(
          kind === "install"
            ? "Install lock is active or cannot be verified"
            : "Install recovery lock is in use",
        ),
      });
      expect(await readFile(pidFile, "utf8")).toBe(String(owner) + "\n");
      expect((await stat(contested)).isDirectory()).toBe(true);
    },
  );

  it("reads real multi-line daemon lock and state, and refuses ambiguous records", async () => {
    const pidPath = join(ohbabyHome, daemonLock);
    const state = join(ohbabyHome, "server", "daemon-state.json");
    await writeFile(pidPath, daemonPidRecord(process.pid));
    expect((await install()).stderr).toContain("ohbaby serve stop");
    await writeFile(
      state,
      JSON.stringify({ status: "stopped", updatedAt: 2 }, null, 2),
    );
    expect((await install()).stderr).toContain("ohbaby serve stop");
    await writeFile(pidPath, '{"pid":');
    expect((await install()).stderr).toContain("Cannot parse daemon metadata");
    await writeFile(pidPath, daemonPidRecord(deadPid));
    await writeFile(
      state,
      JSON.stringify(
        {
          status: "running",
          pid: deadPid,
          pidToken: "daemon-instance",
          host: "127.0.0.1",
          port: 80,
          authToken: "not-a-real-secret",
          updatedAt: 2,
        },
        null,
        2,
      ),
    );
    expect(await install()).toMatchObject({ code: 0, stderr: "" });
  });

  it("ignores a reused PID in a stopped or crashed state once the lock is gone", async () => {
    const state = join(ohbabyHome, "server", "daemon-state.json");
    const writeState = (status: string): Promise<void> =>
      writeFile(
        state,
        JSON.stringify(
          { status, pid: process.pid, pidToken: "old", updatedAt: 2 },
          null,
          2,
        ),
      );
    await writeState("stopping");
    expect((await install()).stderr).toContain("ohbaby serve stop");
    for (const status of ["stopped", "crashed"]) {
      await writeState(status);
      expect(await install()).toMatchObject({ code: 0, stderr: "" });
    }
    await writeFile(join(ohbabyHome, daemonLock), daemonPidRecord(process.pid));
    expect((await install()).stderr).toContain("ohbaby serve stop");
  });

  it("uses the installed private Node to inspect daemon metadata without system JSON readers", async () => {
    expect((await install()).code).toBe(0);
    const bin = join(root, "tools");
    await mkdir(bin);
    const utilities = [
      "awk",
      "basename",
      "cat",
      "chmod",
      "curl",
      "dirname",
      "grep",
      "ldd",
      "ls",
      "mkdir",
      "mktemp",
      "mv",
      "od",
      "rm",
      "rmdir",
      "sed",
      "sh",
      "uname",
    ];
    for (const utility of utilities) {
      const systemUtility = ["/usr/bin", "/bin"]
        .map((directory) => join(directory, utility))
        .find(existsSync);
      if (systemUtility) await symlink(systemUtility, join(bin, utility));
    }
    await writeFile(join(ohbabyHome, daemonLock), daemonPidRecord(deadPid));
    expect(await install({ PATH: bin })).toMatchObject({ code: 0, stderr: "" });
    await writeFile(join(ohbabyHome, daemonLock), daemonPidRecord(process.pid));
    expect(await install({ PATH: bin })).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("ohbaby serve stop"),
    });
  });

  it("refuses a damaged Node download before publishing a runtime", async () => {
    corruptArchive = true;
    expect(await install()).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("SHA-256 verification failed"),
    });
    await expect(
      stat(join(installDir, "runtime", "node-v" + nodeVersion)),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a failed PATH step after switching and keeps both versions", async () => {
    expect((await install({ OHBABY_NO_MODIFY_PATH: "1" })).code).toBe(0);
    await mkdir(join(home, ".zshrc"));
    const result = await install({ OHBABY_INSTALL_VERSION: second });
    expect(result).toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        `ohbaby ${second} is active, but PATH setup failed`,
      ),
    });
    expect(result.stdout).toContain(
      `\nUpdated ohbaby from ${first} to ${second}.\n`,
    );
    expect(summaryRow(result.stdout ?? "", "PATH")).toMatch(/^Not changed\./u);
    expect(await currentVersion()).toBe(second);
    expect(await runLauncher()).toBe(second);
    expect(
      (await stat(join(installDir, "releases", first))).isDirectory(),
    ).toBe(true);
  });
});
