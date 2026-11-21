import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { spawn, type IPty } from "@lydell/node-pty";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Display checks for install.sh on a pseudo-terminal. The non-TTY behaviour
// and the install result are covered by install-unix.integration.test.ts.
const exec = promisify(execFile);
const installScript = resolve("packages/ohbaby-cli/install.sh");
const nodeVersion = "24.22.3";
const version = "0.0.0-tty.1";
const systemPath = "/usr/bin:/bin";
const chunkSize = 64 * 1024;
const heavyBar = "━";

// /bin/sh is bash on macOS and dash on Linux CI. Run the signal cases under
// every distinct shell found here so both are covered on a developer machine.
const shells = [
  ...new Map(
    ["/bin/sh", "/bin/dash"]
      .filter((shell) => existsSync(shell))
      .map((shell) => [realpathSync(shell), shell]),
  ).values(),
];

type ArchiveMode =
  | "length"
  | "chunked"
  | "redirect-length"
  | "redirect-chunked"
  | "stall";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, "");
}

describe.skipIf(process.platform === "win32")(
  "POSIX installer on a terminal",
  () => {
    let root: string;
    let home: string;
    let installDir: string;
    let server: Server;
    let mirror: string;
    let archive: Buffer;
    let mode: ArchiveMode;
    let archiveClosed: Promise<void>;
    let markArchiveClosed: () => void;
    let running: IPty | undefined;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "ohbaby-install-tty-"));
      home = join(root, "home");
      installDir = join(root, "install");
      mode = "length";
      archiveClosed = new Promise((done) => {
        markArchiveClosed = done;
      });
      await mkdir(join(home, "config", "server"), { recursive: true });

      // Same layout as the official tarball. Random padding makes the archive
      // large enough for several progress frames.
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
  console.log("${version}");
} else if (action === "install") {
  const dist = join(args[args.indexOf("--prefix") + 1], "node_modules", "ohbaby-cli", "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "bin.js"), ${JSON.stringify(`console.log(${JSON.stringify(version)})`)});
} else {
  process.exit(1);
}
`,
      );
      await writeFile(
        join(distribution, "padding"),
        randomBytes(2 * 1024 * 1024),
      );
      const archivePath = join(root, "node.tar.gz");
      await exec("tar", ["-czf", archivePath, "-C", root, "node-fixture"]);
      archive = await readFile(archivePath);
      const checksum = createHash("sha256").update(archive).digest("hex");

      server = createServer((request, response) => {
        const url = request.url ?? "";
        if (url.endsWith("SHASUMS256.txt")) {
          const platform = process.platform === "darwin" ? "darwin" : "linux";
          response.end(
            ["arm64", "x64"]
              .flatMap((arch) => {
                const name = `node-v${nodeVersion}-${platform}-${arch}`;
                return [
                  `${checksum}  ${name}.tar.gz`,
                  `${checksum}  ${name}.tar.xz`,
                ];
              })
              .join("\n") + "\n",
          );
        } else if (mode.startsWith("redirect") && !url.startsWith("/final/")) {
          // Real mirrors send a short body with the redirect. Delaying the
          // final response leaves curl with only these headers for a while.
          const body = "Found".padEnd(154, ".");
          response.writeHead(302, {
            Location: "/final" + url,
            "Content-Length": String(body.length),
          });
          response.end(body);
        } else if (mode.startsWith("redirect")) {
          setTimeout(() => sendArchive(request, response), 600);
        } else {
          sendArchive(request, response);
        }
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No TCP port");
      mirror = `http://127.0.0.1:${String(address.port)}`;
    });

    afterEach(async () => {
      running?.kill("SIGKILL");
      running = undefined;
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(root, { recursive: true, force: true });
    });

    // Sends the archive in small delayed chunks. "stall" sends a few chunks and
    // then holds the connection open, so only the client can close it.
    function sendArchive(
      request: IncomingMessage,
      response: ServerResponse,
    ): void {
      response.on("close", () => markArchiveClosed());
      const headers: Record<string, string> = {};
      if (mode === "length" || mode === "redirect-length" || mode === "stall") {
        headers["Content-Length"] = String(archive.length);
      }
      response.writeHead(200, headers);
      let offset = 0;
      const timer = setInterval(() => {
        if (mode === "stall" && offset >= chunkSize * 4) return;
        response.write(archive.subarray(offset, offset + chunkSize));
        offset += chunkSize;
        if (offset >= archive.length) {
          clearInterval(timer);
          response.end();
        }
      }, 25);
      request.on("close", () => clearInterval(timer));
    }

    function runInstaller(
      env: NodeJS.ProcessEnv = {},
      options: { cols?: number; shell?: string } = {},
    ): { output: () => string; exit: Promise<number>; pty: IPty } {
      let output = "";
      const pty = spawn(options.shell ?? "/bin/sh", [installScript], {
        cols: options.cols ?? 80,
        rows: 24,
        cwd: root,
        env: {
          PATH: systemPath,
          HOME: home,
          SHELL: "/bin/zsh",
          TERM: "xterm-256color",
          LANG: "en_US.UTF-8",
          OHBABY_HOME: join(home, "config"),
          OHBABY_INSTALL_DIR: installDir,
          OHBABY_NODE_MIRROR: mirror,
          OHBABY_NON_INTERACTIVE: "1",
          TEST_REAL_NODE: process.execPath,
          ...env,
        } as Record<string, string>,
      });
      running = pty;
      pty.onData((data) => {
        output += data;
      });
      const exit = new Promise<number>((done) => {
        pty.onExit(({ exitCode }) => {
          running = undefined;
          done(exitCode);
        });
      });
      return { output: () => output, exit, pty };
    }

    async function waitFor(check: () => boolean, label: string): Promise<void> {
      const deadline = Date.now() + 8_000;
      while (!check()) {
        if (Date.now() > deadline)
          throw new Error(`Timed out waiting for ${label}`);
        await new Promise((done) => setTimeout(done, 20));
      }
    }

    async function install(
      env: NodeJS.ProcessEnv = {},
      cols?: number,
    ): Promise<string> {
      const run = runInstaller(env, { cols });
      const code = await run.exit;
      expect(code, run.output()).toBe(0);
      return run.output();
    }

    // Text that was drawn and then cleared by later output on the same line.
    function progressFrames(output: string): string[] {
      return stripAnsi(output)
        .split(/\r(?!\n)/u)
        .filter(
          (frame) => /^ {6} *\S/u.test(frame) && !frame.includes("verified"),
        );
    }

    // Frames drawn before curl has written the headers show megabytes only.
    function sizedFrames(output: string): string[] {
      return progressFrames(output).filter(
        (frame) => !/^ {6}\d+\.\d MB$/u.test(frame),
      );
    }

    it("draws a gold UTF-8 bar on stderr and clears it before the closing line", async () => {
      const output = await install({ COLORTERM: "truecolor" });
      const verified = output.indexOf(
        `Node.js ${nodeVersion}  2.0 MB  verified`,
      );
      expect(verified, output).toBeGreaterThan(0);
      const drawing = output.slice(0, verified);
      expect(drawing).toContain(heavyBar);
      expect(drawing).toContain("\x1b[38;2;212;162;79m");
      expect(drawing).toMatch(/ +\d+%  \d+\.\d \/ 2\.0 MB/u);
      expect(drawing).toContain("\x1b[?25l");
      expect(drawing).toContain("\r\x1b[K\x1b[?25h");
      expect(output.slice(verified)).not.toContain(heavyBar);
      expect(output).toContain(
        "\x1b[38;2;212;162;79m[1/4]\x1b[0m Checking the current installation",
      );
      expect(sizedFrames(output).length).toBeGreaterThan(0);
      for (const frame of sizedFrames(output)) {
        expect(frame).toMatch(/^ {6}[━─]{24} +\d+%  \d+\.\d \/ 2\.0 MB$/u);
      }
    });

    it("uses ASCII cells outside a UTF-8 locale and yellow without truecolor", async () => {
      const output = await install({ LANG: "C" });
      expect(output).not.toContain(heavyBar);
      expect(output).toContain("\x1b[33m");
      expect(sizedFrames(output).length).toBeGreaterThan(0);
      for (const frame of sizedFrames(output)) {
        expect(frame).toMatch(/^ {6}#*-* +\d+%  /u);
        expect(frame.slice(6, 30)).toMatch(/^#*-*$/u);
      }
    });

    it("drops colour with NO_COLOR but still hides and restores the cursor", async () => {
      const output = await install({ NO_COLOR: "1" });
      expect(output).not.toMatch(/\x1b\[[0-9;]*m/u);
      expect(output).toContain("\x1b[?25l");
      expect(output).toContain("\x1b[?25h");
      expect(output).toContain(heavyBar);
    });

    it("shows only megabytes without a content length", async () => {
      mode = "chunked";
      const output = await install();
      const frames = progressFrames(output);
      expect(frames.length).toBeGreaterThan(0);
      for (const frame of frames) expect(frame).toMatch(/^ {6}\d+\.\d MB$/u);
      expect(output).not.toContain(heavyBar);
    });

    it("shows text without the bar on a narrow terminal", async () => {
      const output = await install({}, 50);
      expect(output).not.toContain(heavyBar);
      const frames = sizedFrames(output);
      expect(frames.length).toBeGreaterThan(0);
      for (const frame of frames)
        expect(frame).toMatch(/^ {6} *\d+%  \d+\.\d \/ 2\.0 MB$/u);
    });

    it.each([
      [
        "redirect-length",
        /^ {6}([━─]{24} +\d+%  \d+\.\d \/ 2\.0 MB|\d+\.\d MB)$/u,
      ],
      ["redirect-chunked", /^ {6}\d+\.\d MB$/u],
    ] as const)(
      "ignores the Content-Length of a redirect (%s)",
      async (redirect, frame) => {
        mode = redirect;
        const output = await install();
        const frames = progressFrames(output);
        expect(frames.length).toBeGreaterThan(0);
        for (const text of frames) {
          expect(text).toMatch(frame);
          const percent = /(\d+)%/u.exec(text);
          if (percent) expect(Number(percent[1])).toBeLessThanOrEqual(100);
        }
        expect(output).toContain("verified");
      },
    );

    it("draws nothing on a dumb terminal", async () => {
      const output = await install({ TERM: "dumb" });
      expect(output).not.toContain(heavyBar);
      expect(output).not.toMatch(/\r(?!\n)/u);
      expect(output).not.toContain("\x1b");
      expect(output).toContain("verified");
    });

    it("skips the bar when the private Node is already present", async () => {
      await install();
      const output = await install();
      expect(output).toContain(
        `[2/4]\x1b[0m Node.js ${nodeVersion} is already present`,
      );
      expect(output).not.toContain(heavyBar);
      expect(output).not.toContain("\x1b[?25l");
    });

    describe.each(shells)("signals under %s", (shell) => {
      it.each([
        ["Ctrl-C", 130],
        ["SIGTERM", 143],
      ] as const)(
        "stops curl and cleans up on %s",
        async (signal, expected) => {
          mode = "stall";
          const run = runInstaller({}, { shell });
          await waitFor(() => /\d+%  /u.test(run.output()), "the progress bar");
          if (signal === "Ctrl-C") run.pty.write("\x03");
          else process.kill(run.pty.pid, "SIGTERM");
          expect(await run.exit, run.output()).toBe(expected);
          // The server never ends a stalled response, so a closed connection
          // means curl exited.
          await archiveClosed;
          expect(run.output()).toContain("\x1b[?25h");
          await expect(stat(`${installDir}.lock`)).rejects.toMatchObject({
            code: "ENOENT",
          });
          const runtime = await readdir(join(installDir, "runtime"));
          expect(
            runtime.filter((name) => name.startsWith(".download-")),
          ).toEqual([]);
        },
      );
    });
  },
);
