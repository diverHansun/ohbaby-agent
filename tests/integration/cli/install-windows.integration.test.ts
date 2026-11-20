import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
const installer = resolve("packages/ohbaby-cli/install.ps1");
const initialVersion = "0.0.0-install.1";
const nextVersion = "0.0.0-install.2";
const thirdVersion = "0.0.0-install.3";
const brokenVersion = "0.0.0-install.4";

it("keeps the PowerShell installer and embedded launcher compatible with Windows PowerShell 5.1", async () => {
  const bytes = await readFile(installer);
  expect(bytes.every((byte) => byte < 128)).toBe(true);
  expect(bytes.toString()).toContain("rem ohbaby-launcher 1");
});

it.runIf(process.platform === "win32")(
  "checks downloads, stages upgrades, and preserves a usable launcher on Windows",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ohbaby-windows-install-"));
    const nodeVersion = process.versions.node;
    const bundle = ["node-v", nodeVersion, "-win-", process.arch].join("");
    const archive = bundle + ".zip";
    const runtimeFixture = join(root, bundle);
    const npmDir = join(runtimeFixture, "node_modules", "npm", "bin");
    const script = join(root, "install.ps1");
    const installDir = join(root, "ohbaby 安 装");
    const configHome = join(root, "home");
    const current = join(installDir, "current");
    const releases = join(installDir, "releases");
    const lock = installDir + ".lock";
    const launcher = join(installDir, "bin", "ohbaby.cmd");
    const env = {
      ...process.env,
      OHBABY_HOME: configHome,
      OHBABY_INSTALL_DIR: installDir,
      OHBABY_NON_INTERACTIVE: "1",
      OHBABY_NO_MODIFY_PATH: "1",
      OHBABY_INSTALL_VERSION: "",
      OHBABY_TEST_LAUNCHER: launcher,
      USERPROFILE: root,
    };
    let archiveBytes: Buffer;
    let checksums: string;
    let brokenDownload = true;
    const mirrorRequests: string[] = [];
    const mirror = createServer((request, response) => {
      const base = "/v" + nodeVersion + "/";
      mirrorRequests.push(request.url ?? "<missing URL>");
      if (request.url === base + archive) {
        response.end(brokenDownload ? "corrupt archive" : archiveBytes);
        return;
      }
      if (request.url === base + "SHASUMS256.txt") {
        response.end(checksums);
        return;
      }
      response.writeHead(404).end();
    });

    try {
      await mkdir(npmDir, { recursive: true });
      // Use the runner's Node executable and a local npm fixture. The production
      // installer still validates the archive and verifies both versions itself.
      await copyFile(process.execPath, join(runtimeFixture, "node.exe"));
      await writeFile(
        join(npmDir, "npm-cli.js"),
        [
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          "const assert = require('node:assert/strict');",
          "const args = process.argv.slice(2);",
          "let version = args.find(arg => arg.startsWith('ohbaby-cli@')).split('@')[1];",
          "if (version === 'latest') version = " +
            JSON.stringify(initialVersion) +
            ";",
          "if (args[0] === 'view') { console.log(version); process.exit(0); }",
          "assert.equal(args[0], 'install');",
          "assert.ok(args.includes('--ignore-scripts'));",
          "assert.ok(args.includes('--omit=dev'));",
          "const prefix = args[args.indexOf('--prefix') + 1];",
          "const cli = path.join(prefix, 'node_modules', 'ohbaby-cli', 'dist');",
          "fs.mkdirSync(cli, { recursive: true });",
          "const bin = version === " +
            JSON.stringify(brokenVersion) +
            " ? 'process.exit(2);' : 'console.log(' + JSON.stringify(version) + ');';",
          "fs.writeFileSync(path.join(cli, 'bin.js'), bin);",
        ].join("\n"),
      );
      await exec("tar.exe", ["-a", "-cf", archive, bundle], { cwd: root });
      archiveBytes = await readFile(join(root, archive));
      checksums =
        createHash("sha256").update(archiveBytes).digest("hex") +
        "  " +
        archive +
        "\n";
      const source = await readFile(installer, "utf8");
      await writeFile(
        script,
        source.replace(
          /\$nodeVersion = '\d+\.\d+\.\d+'/,
          "$nodeVersion = '" + nodeVersion + "'",
        ),
      );
      await new Promise<void>((started) =>
        mirror.listen(0, "127.0.0.1", started),
      );
      Object.assign(env, {
        OHBABY_NODE_MIRROR:
          "http://127.0.0.1:" + (mirror.address() as AddressInfo).port,
      });

      const install = async (
        version = "",
        environment: NodeJS.ProcessEnv = {},
      ) => {
        const firstRequest = mirrorRequests.length;
        const startedAt = Date.now();
        try {
          return await exec(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              script,
            ],
            {
              env: { ...env, OHBABY_INSTALL_VERSION: version, ...environment },
              timeout: 90_000,
              windowsHide: true,
            },
          );
        } catch (error) {
          if (error instanceof Error && "killed" in error && error.killed) {
            const requests = mirrorRequests.slice(firstRequest).join(", ");
            const stderr =
              "stderr" in error && typeof error.stderr === "string"
                ? error.stderr.trim()
                : "";
            throw new Error(
              "PowerShell installer timed out for " +
                (version || "latest") +
                " after " +
                (Date.now() - startedAt) +
                " ms. Loopback mirror received: " +
                (requests || "no requests") +
                ". Stderr: " +
                (stderr || "<empty>"),
              { cause: error },
            );
          }
          throw error;
        }
      };
      const installedVersion = async () =>
        (
          await exec(
            "cmd.exe",
            [
              "/d",
              "/v:off",
              "/c",
              'chcp 936 >nul && "%OHBABY_TEST_LAUNCHER%" --version',
            ],
            { env, windowsVerbatimArguments: true },
          )
        ).stdout.trim();

      await expect(
        install(initialVersion, { OHBABY_INSTALL_DIR: "relative" }),
      ).rejects.toThrow(/must be an absolute directory path/);
      await expect(
        install(initialVersion, { OHBABY_INSTALL_DIR: root }),
      ).rejects.toThrow(/Choose a separate installation directory/);
      const realHome = await realpath(root);
      if (realHome.toLowerCase() !== root.toLowerCase()) {
        await expect(
          install(initialVersion, { OHBABY_INSTALL_DIR: realHome }),
        ).rejects.toThrow(/Choose a separate installation directory/);
      }
      await expect(install()).rejects.toThrow(/SHA-256 verification failed/);
      await expect(access(current)).rejects.toThrow();
      await expect(access(lock)).rejects.toThrow();
      brokenDownload = false;
      await install();
      expect(await readFile(current, "utf8")).toBe(initialVersion + "\r\n");
      expect(
        await readFile(join(releases, initialVersion, "node-version"), "utf8"),
      ).toBe(nodeVersion + "\r\n");
      expect(await installedVersion()).toBe(initialVersion);
      const launcherStamp = (await stat(launcher)).mtimeMs;
      const releaseStamp = (await stat(join(releases, initialVersion))).mtimeMs;
      await install();
      expect((await stat(launcher)).mtimeMs).toBe(launcherStamp);
      expect((await stat(join(releases, initialVersion))).mtimeMs).toBe(
        releaseStamp,
      );

      const linked = join(root, "linked install");
      await symlink(installDir, linked, "junction");
      await expect(
        install(nextVersion, { OHBABY_INSTALL_DIR: linked }),
      ).rejects.toThrow(/junction or symbolic link/);
      await expect(access(linked + ".lock")).rejects.toThrow();

      await mkdir(join(configHome, "server"), { recursive: true });
      const daemonPid = join(configHome, "server", "daemon.pid");
      await writeFile(
        daemonPid,
        JSON.stringify(
          { pid: process.pid, startedAt: Date.now(), token: "test" },
          null,
          2,
        ),
      );
      await expect(install(nextVersion)).rejects.toThrow(/Daemon PID/);
      await rm(daemonPid);
      const daemonState = join(configHome, "server", "daemon-state.json");
      const writeDaemonState = (status: string): Promise<void> =>
        writeFile(
          daemonState,
          JSON.stringify(
            {
              status,
              pid: process.pid,
              pidToken: "test",
              updatedAt: Date.now(),
            },
            null,
            2,
          ),
        );
      await writeDaemonState("stopping");
      await expect(install(nextVersion)).rejects.toThrow(/Daemon PID/);
      // A stopped daemon keeps its old PID. Once the lock is gone, a reused PID
      // must not block the install below.
      await writeDaemonState("stopped");
      await mkdir(lock);
      await writeFile(join(lock, "pid"), String(process.pid));
      await expect(install(nextVersion)).rejects.toThrow(/already running/);
      await writeFile(join(lock, "pid"), "2147483647\n");
      await install(nextVersion);
      expect(await installedVersion()).toBe(nextVersion);
      await expect(access(lock)).rejects.toThrow();
      await expect(
        access(join(releases, initialVersion)),
      ).resolves.toBeUndefined();
      await expect(install(brokenVersion)).rejects.toThrow(
        /failed its version check/,
      );
      const partialRelease = join(releases, brokenVersion + ".partial");
      await expect(access(partialRelease)).resolves.toBeUndefined();
      expect(await installedVersion()).toBe(nextVersion);
      await install(thirdVersion);
      expect(await installedVersion()).toBe(thirdVersion);
      await expect(access(join(releases, initialVersion))).rejects.toThrow();
      await expect(access(partialRelease)).rejects.toThrow();
      await expect(
        access(join(releases, nextVersion)),
      ).resolves.toBeUndefined();

      const badPath = join(root, "cannot;add to PATH");
      await cp(join(installDir, "runtime"), join(badPath, "runtime"), {
        recursive: true,
      });
      await install(initialVersion, { OHBABY_INSTALL_DIR: badPath });
      await expect(
        install(nextVersion, {
          OHBABY_INSTALL_DIR: badPath,
          OHBABY_NO_MODIFY_PATH: "0",
        }),
      ).rejects.toThrow(/switched to.*could not update the user PATH/s);
      expect(await readFile(join(badPath, "current"), "utf8")).toBe(
        nextVersion + "\r\n",
      );
      await expect(
        access(join(badPath, "releases", initialVersion)),
      ).resolves.toBeUndefined();
    } finally {
      mirror.closeAllConnections();
      await new Promise<void>((closed) => mirror.close(() => closed()));
      await rm(root, { recursive: true, force: true });
    }
  },
  180_000,
);
