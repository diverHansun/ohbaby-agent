import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliCommandRuntime } from "./cli/commands/types.js";

const NEWER_VERSION = "999.0.0";

interface Harness {
  readonly home: string;
  readonly order: string[];
  readonly stderr: string[];
  readonly installSystemProxy: ReturnType<typeof vi.fn>;
  readonly renderTerminalUi: ReturnType<typeof vi.fn>;
  readonly runAutomaticUpdate: ReturnType<typeof vi.fn>;
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ohbaby-startup-update-"));
  vi.stubEnv("OHBABY_NO_UPDATE_CHECK", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("./cli/commands/update.js");
  vi.doUnmock("./tui/index.js");
  vi.resetModules();
  rmSync(home, { recursive: true, force: true });
});

function writeCache(options: { readonly autoUpdate?: boolean } = {}): void {
  mkdirSync(join(home, "update"), { recursive: true });
  // A fresh timestamp keeps the background refresh from touching the network.
  writeFileSync(
    join(home, "update", "check.json"),
    JSON.stringify({ checkedAt: Date.now(), latestVersion: NEWER_VERSION }),
  );
  if (options.autoUpdate !== undefined) {
    writeFileSync(
      join(home, "update", "settings.json"),
      JSON.stringify({ autoUpdate: options.autoUpdate }),
    );
  }
}

async function run(
  argv: readonly string[],
  decision: "continue" | "exit" = "continue",
): Promise<Harness & { readonly code: number }> {
  const order: string[] = [];
  const stderr: string[] = [];
  const runAutomaticUpdate = vi.fn(
    (request: { readonly runtime: CliCommandRuntime }) => {
      order.push("auto-update");
      request.runtime.stderr.write("Preflight blocked: daemon is busy.\n");
      if (decision === "exit") request.runtime.setExitCode(0);
      return Promise.resolve(decision);
    },
  );
  const renderTerminalUi = vi.fn(() => {
    order.push("render");
    return { waitUntilExit: (): Promise<void> => Promise.resolve() };
  });
  vi.resetModules();
  vi.doMock("./cli/commands/update.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./cli/commands/update.js")>()),
    runAutomaticUpdate,
  }));
  vi.doMock("./tui/index.js", () => ({ renderTerminalUi }));
  const installSystemProxy = vi.fn(() => {
    order.push("proxy");
    return Promise.resolve({ dispose: (): Promise<void> => Promise.resolve() });
  });
  const { runOhbabyCli } = await import("./bin.js");
  // The fake core has no prompt methods; `run` may reject after routing.
  const code = await runOhbabyCli(
    ["node", "ohbaby", ...argv],
    {
      stdout: { write: () => undefined },
      stderr: { write: (chunk: string) => stderr.push(chunk) },
    },
    {
      createCoreHost: () => {
        order.push("host");
        return {
          callbacks: {
            subscribeEvents: (): (() => void) => () => undefined,
          },
          core: {} as never,
          dispose: (): Promise<void> => Promise.resolve(),
        };
      },
      installSystemProxy,
      loadRuntimeEnvIntoProcessEnv: () => undefined,
      readServeCoexistenceNotice: () => Promise.resolve(undefined),
      resolveOhbabyHome: () => home,
      readDaemonStatus: () => Promise.resolve(undefined),
      listDaemonConnections: () => Promise.resolve([]),
      stopDaemonFromState: () =>
        Promise.resolve({ processExit: "not-running", cleanup: "confirmed" }),
      startDaemonServer: async (options) => {
        await options.beforeBackendStart?.();
        order.push("server");
        return {
          host: "127.0.0.1",
          port: 4096,
          reused: false,
          scopeRoot: "/repo",
          stop: (): Promise<void> => Promise.resolve(),
          url: "http://127.0.0.1:4096",
        };
      },
    },
  ).catch(() => -1);
  return {
    code,
    home,
    installSystemProxy,
    order,
    renderTerminalUi,
    runAutomaticUpdate,
    stderr,
  };
}

function initialNotices(harness: Harness): readonly string[] {
  const call = harness.renderTerminalUi.mock.calls[0] as
    | [{ readonly initialNotices?: readonly string[] }]
    | undefined;
  return call?.[0].initialNotices ?? [];
}

describe("startup update wiring", () => {
  it("shows the cached notice with the auto-update hint in the TUI", async () => {
    writeCache();

    const harness = await run([]);

    expect(harness.code).toBe(0);
    expect(harness.runAutomaticUpdate).not.toHaveBeenCalled();
    const notices = initialNotices(harness);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(NEWER_VERSION);
    expect(notices[0]).toContain("ohbaby update --auto on");
  });

  it("drops the switch hint once automatic updates are enabled", async () => {
    writeCache({ autoUpdate: true });

    const harness = await run([]);

    expect(initialNotices(harness).join("\n")).not.toContain("--auto on");
  });

  it("initializes the proxy, then updates before the host, and exits", async () => {
    writeCache({ autoUpdate: true });

    const harness = await run([], "exit");

    expect(harness.code).toBe(0);
    expect(harness.order).toEqual(["proxy", "auto-update"]);
    expect(harness.runAutomaticUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        ohbabyHome: home,
        targetVersion: NEWER_VERSION,
      }),
    );
    expect(harness.renderTerminalUi).not.toHaveBeenCalled();
  });

  it("repeats the continue reason inside the TUI because it clears the screen", async () => {
    writeCache({ autoUpdate: true });

    const harness = await run([], "continue");

    expect(harness.order).toEqual(["proxy", "auto-update", "host", "render"]);
    expect(harness.stderr.join("")).toContain("Preflight blocked");
    expect(initialNotices(harness)).toContain(
      "Preflight blocked: daemon is busy.",
    );
  });

  it("honors OHBABY_NO_UPDATE_CHECK for notices and automatic updates", async () => {
    writeCache({ autoUpdate: true });
    vi.stubEnv("OHBABY_NO_UPDATE_CHECK", "1");

    const harness = await run([]);

    expect(harness.runAutomaticUpdate).not.toHaveBeenCalled();
    expect(harness.order).toEqual(["proxy", "host", "render"]);
    expect(initialNotices(harness)).toEqual([]);
  });

  it("prints the notice for serve start and never auto-updates", async () => {
    writeCache({ autoUpdate: true });

    const harness = await run(["serve", "--no-open"]);

    expect(harness.runAutomaticUpdate).not.toHaveBeenCalled();
    expect(harness.stderr.join("")).toContain(NEWER_VERSION);
  });

  it.each([
    ["run", "hello"],
    ["--help"],
    ["--version"],
    ["serve", "status"],
    ["serve", "stop"],
    ["serve", "ps"],
    ["update", "--help"],
    ["uninstall", "--help"],
  ])("does not print a cached notice for %s", async (...argv) => {
    writeCache({ autoUpdate: true });

    const harness = await run(argv);

    expect(harness.runAutomaticUpdate).not.toHaveBeenCalled();
    expect(harness.stderr.join("")).not.toContain(NEWER_VERSION);
  });

  it("does not initialize the proxy for a plain cached notice", async () => {
    writeCache();

    const harness = await run(["serve", "status"]);

    expect(harness.installSystemProxy).not.toHaveBeenCalled();
  });
});

describe("DATABASE_NEWER_THAN_PROGRAM", () => {
  it.each(["run hello", ""])(
    "prints only the message and exits 1 (%s)",
    async (command) => {
      vi.resetModules();
      const { runOhbabyCli } = await import("./bin.js");
      const stderr: string[] = [];
      const error = Object.assign(
        new Error(
          "This database was used by a newer ohbaby. Run ohbaby update.",
        ),
        { code: "DATABASE_NEWER_THAN_PROGRAM" },
      );

      const code = await runOhbabyCli(
        ["node", "ohbaby", ...command.split(" ").filter(Boolean)],
        {
          stdout: { write: () => undefined },
          stderr: { write: (chunk: string) => stderr.push(chunk) },
        },
        {
          createCoreHost: () => {
            throw new Error("core host failed", { cause: error });
          },
          loadRuntimeEnvIntoProcessEnv: () => undefined,
        },
      );

      expect(code).toBe(1);
      expect(stderr.join("")).toBe(`${error.message}\n`);
    },
  );
});
