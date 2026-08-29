import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineDiagnosticEvent, diagnosticField } from "./logger.js";
import {
  createProcessLogger,
  createProcessLoggerWithLimits,
  DiagnosticsConfigurationError,
  type ProcessLoggerHandle,
} from "./process-logger.js";

const temporaryDirectories: string[] = [];

function requireLogFilePath(handle: ProcessLoggerHandle): string {
  if (handle.logFilePath === undefined) {
    throw new Error("expected the process logger to create a log file");
  }
  return handle.logFilePath;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ohbaby-log-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function runLoggerChild(input: {
  readonly environment: Readonly<Record<string, string>>;
  readonly script: string;
  readonly timeoutMs?: number;
}): Promise<{ readonly code: number | null; readonly stderr: string }> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--eval", input.script],
    {
      env: { ...process.env, ...input.environment },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("logger child did not exit before the test timeout"));
    }, input.timeoutMs ?? 5_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve({ code, stderr });
    });
  });
}

const processLoggerModuleUrl = pathToFileURL(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "process-logger.ts",
  ),
).href;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      const { rm } = await import("node:fs/promises");
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

const infoEvent = defineDiagnosticEvent({
  component: "diagnostics",
  event: "diagnostics.integration",
  fields: { count: diagnosticField.integer() },
  level: "info",
});

const debugEvent = defineDiagnosticEvent({
  component: "diagnostics",
  event: "diagnostics.integration_debug",
  fields: { count: diagnosticField.integer() },
  level: "debug",
});

const truncationEvent = defineDiagnosticEvent({
  component: "diagnostics",
  event: "diagnostics.truncation",
  fields: {
    count: diagnosticField.integer(),
    firstPath: diagnosticField.optional(diagnosticField.path()),
    secondPath: diagnosticField.optional(diagnosticField.path()),
  },
  level: "info",
});

describe("process logger", () => {
  it("creates a private per-process JSONL file and flushes tail records", async () => {
    const logRoot = await temporaryDirectory();
    const stdout = vi.spyOn(process.stdout, "write");
    const stderr = vi.spyOn(process.stderr, "write");
    const handle = await createProcessLogger({
      level: "info",
      logDirectory: logRoot,
      role: "tui",
      workspaceRoot: logRoot,
    });
    handle.logger.emit(debugEvent, { count: 1 });
    handle.logger.emit(infoEvent, { count: 2 });
    await handle.dispose();
    await handle.dispose();
    const logFilePath = requireLogFilePath(handle);

    const lines = (await readFile(logFilePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((line) => line.event)).toEqual([
      "diagnostics.started",
      "diagnostics.integration",
    ]);
    expect(lines[1]).toMatchObject({ count: 2, level: "info" });
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    if (process.platform !== "win32") {
      expect((await stat(path.dirname(logFilePath))).mode & 0o777).toBe(0o700);
      expect((await stat(logFilePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("joins concurrent dispose calls through the same bounded drain", async () => {
    const logRoot = await temporaryDirectory();
    const handle = await createProcessLogger({
      logDirectory: logRoot,
      role: "tui",
    });
    for (let count = 0; count < 20_000; count += 1) {
      handle.logger.emit(infoEvent, { count });
    }

    const first = handle.dispose();
    const second = handle.dispose();

    expect(second).toBe(first);
    await Promise.all([first, second]);
    const contents = await readFile(requireLogFilePath(handle), "utf8");
    expect(contents).toContain('"event":"diagnostics.integration"');
  });

  it("bounds the complete dispose lifecycle when writer close hangs", async () => {
    const logRoot = await temporaryDirectory();
    const onUnavailable = vi.fn();
    const writer = {
      close: vi.fn(() => new Promise<void>(() => undefined)),
      path: path.join(logRoot, "hanging.jsonl"),
      write: vi.fn(() => Promise.resolve()),
    };
    const handle = await createProcessLoggerWithLimits(
      { logDirectory: logRoot, onUnavailable, role: "tui" },
      {
        disposeTimeoutMs: 40,
        maxBytes: 8 * 1024 * 1024,
        maxFiles: 3,
        maxLineBytes: 16 * 1024,
        maxQueue: 64,
        retentionMs: 1_000,
      },
      { createWriter: () => Promise.resolve(writer) },
    );
    await handle.flush();

    const startedAt = Date.now();
    await handle.dispose();

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(writer.close).toHaveBeenCalledOnce();
    expect(onUnavailable).toHaveBeenCalledOnce();
    expect(onUnavailable).toHaveBeenCalledWith("flush");
  });

  it("writes one dropped-event summary even when the queue was full at exit", async () => {
    const logRoot = await temporaryDirectory();
    const handle = await createProcessLoggerWithLimits(
      { logDirectory: logRoot, role: "tui" },
      {
        disposeTimeoutMs: 2_000,
        maxBytes: 8 * 1024 * 1024,
        maxFiles: 3,
        maxLineBytes: 16 * 1024,
        maxQueue: 2,
        retentionMs: 1_000,
      },
    );
    for (let count = 0; count < 100; count += 1) {
      handle.logger.emit(infoEvent, { count });
    }

    await handle.dispose();
    const contents = await readFile(requireLogFilePath(handle), "utf8");
    const records = contents
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(
      records.some((record) => record.event === "logger.events_dropped"),
    ).toBe(true);
  });

  it("truncates only optional fields and preserves required event fields", async () => {
    const logRoot = await temporaryDirectory();
    const handle = await createProcessLoggerWithLimits(
      { logDirectory: logRoot, role: "tui", workspaceRoot: logRoot },
      {
        disposeTimeoutMs: 1_000,
        maxBytes: 8 * 1024 * 1024,
        maxFiles: 3,
        maxLineBytes: 600,
        maxQueue: 64,
        retentionMs: 1_000,
      },
    );
    handle.logger.emit(truncationEvent, {
      count: 7,
      firstPath: `${"first".repeat(100)}.txt`,
      secondPath: `${"second".repeat(100)}.txt`,
    });

    await handle.dispose();
    const records = (await readFile(requireLogFilePath(handle), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const record = records.find(
      (candidate) => candidate.event === "diagnostics.truncation",
    );
    expect(record).toMatchObject({ count: 7, truncated: true });
    expect(record).not.toHaveProperty("firstPath");
    expect(record).not.toHaveProperty("secondPath");
  });

  it("rotates only its own unique files", async () => {
    const logRoot = await temporaryDirectory();
    const handle = await createProcessLoggerWithLimits(
      { level: "trace", logDirectory: logRoot, role: "serve" },
      {
        disposeTimeoutMs: 1_000,
        maxBytes: 220,
        maxFiles: 3,
        maxLineBytes: 16 * 1024,
        maxQueue: 64,
        retentionMs: 1_000,
      },
    );
    for (let count = 0; count < 20; count += 1) {
      handle.logger.emit(infoEvent, { count });
    }
    await handle.dispose();
    const logFilePath = requireLogFilePath(handle);
    const logDirectory = path.dirname(logFilePath);
    const files = await readdir(logDirectory);
    expect(files.filter((file) => file.endsWith(".jsonl"))).toHaveLength(3);
    for (const file of files) {
      const contents = await readFile(path.join(logDirectory, file), "utf8");
      for (const line of contents.trim().split("\n")) {
        expect(() => {
          JSON.parse(line) as unknown;
        }).not.toThrow();
      }
    }
  });

  it("fails fast for explicit invalid configuration", async () => {
    await expect(
      createProcessLogger({ level: "verbose", role: "tui" }),
    ).rejects.toBeInstanceOf(DiagnosticsConfigurationError);
    await expect(
      createProcessLogger({ logDirectory: "relative/logs", role: "tui" }),
    ).rejects.toBeInstanceOf(DiagnosticsConfigurationError);

    const directory = await temporaryDirectory();
    const file = path.join(directory, "not-a-directory");
    await writeFile(file, "occupied");
    await expect(
      createProcessLogger({ logDirectory: file, role: "tui" }),
    ).rejects.toThrow("Could not initialize OHBABY_LOG_DIR");
  });

  it("fails open once when the default location is unavailable", async () => {
    const directory = await temporaryDirectory();
    const file = path.join(directory, "home-file");
    await writeFile(file, "occupied");
    await chmod(file, 0o600);
    const onUnavailable = vi.fn();
    const handle = await createProcessLogger({
      homeDirectory: file,
      onUnavailable,
      role: "tui",
    });
    handle.logger.emit(infoEvent, { count: 1 });
    await handle.flush();
    await handle.dispose();
    expect(onUnavailable).toHaveBeenCalledOnce();
    expect(onUnavailable).toHaveBeenCalledWith("initialize");
  });

  it("fails open once for a real runtime write failure and still disposes", async () => {
    const logRoot = await temporaryDirectory();
    const onUnavailable = vi.fn();
    const handle = await createProcessLoggerWithLimits(
      { logDirectory: logRoot, onUnavailable, role: "tui" },
      {
        disposeTimeoutMs: 1_000,
        maxBytes: 1,
        maxFiles: 3,
        maxLineBytes: 16 * 1024,
        maxQueue: 64,
        retentionMs: 1_000,
      },
    );
    await handle.flush();
    await rm(path.dirname(requireLogFilePath(handle)), {
      force: true,
      recursive: true,
    });

    handle.logger.emit(infoEvent, { count: 1 });
    await handle.flush();
    await handle.dispose();

    expect(onUnavailable).toHaveBeenCalledOnce();
    expect(onUnavailable).toHaveBeenCalledWith("write");
  });

  it("cleans expired files from dead processes without touching live files", async () => {
    const logRoot = await temporaryDirectory();
    const directory = path.join(logRoot, "serve");
    await mkdir(directory, { recursive: true });
    const expired = path.join(
      directory,
      "2000-01-01T00-00-00-000Z-99999999-deadbeef.jsonl",
    );
    const live = path.join(
      directory,
      `2000-01-01T00-00-00-000Z-${String(process.pid)}-feedface.jsonl`,
    );
    await writeFile(expired, "old\n");
    await writeFile(live, "live\n");
    const old = new Date("2000-01-01T00:00:00.000Z");
    await utimes(expired, old, old);
    await utimes(live, old, old);

    const handle = await createProcessLoggerWithLimits(
      { logDirectory: logRoot, role: "serve" },
      {
        disposeTimeoutMs: 1_000,
        maxBytes: 8 * 1024 * 1024,
        maxFiles: 3,
        maxLineBytes: 16 * 1024,
        maxQueue: 64,
        retentionMs: 1,
      },
    );
    await vi.waitFor(async () => {
      const files = await readdir(directory);
      expect(files).not.toContain(path.basename(expired));
    });
    expect(await readFile(live, "utf8")).toBe("live\n");
    await handle.dispose();
  });

  it("creates independent files for concurrent logger instances", async () => {
    const logRoot = await temporaryDirectory();
    const [first, second] = await Promise.all([
      createProcessLogger({ logDirectory: logRoot, role: "serve" }),
      createProcessLogger({ logDirectory: logRoot, role: "serve" }),
    ]);

    expect(requireLogFilePath(first)).not.toBe(requireLogFilePath(second));
    first.logger.emit(infoEvent, { count: 1 });
    second.logger.emit(infoEvent, { count: 2 });
    await Promise.all([first.dispose(), second.dispose()]);
    await expect(
      readFile(requireLogFilePath(first), "utf8"),
    ).resolves.toContain('"count":1');
    await expect(
      readFile(requireLogFilePath(second), "utf8"),
    ).resolves.toContain('"count":2');
  });

  it("keeps same-role files independent across two real child processes", async () => {
    const logRoot = await temporaryDirectory();
    const script = `
      import { createProcessLogger } from ${JSON.stringify(processLoggerModuleUrl)};
      import { defineDiagnosticEvent, diagnosticField } from ${JSON.stringify(
        new URL("./logger.ts", processLoggerModuleUrl).href,
      )};
      const event = defineDiagnosticEvent({
        component: "diagnostics",
        event: "diagnostics.child_process",
        fields: { pid: diagnosticField.integer() },
        level: "info",
      });
      const handle = await createProcessLogger({
        logDirectory: process.env.OHBABY_LOG_TEST_ROOT,
        role: "serve",
      });
      handle.logger.emit(event, { pid: process.pid });
      await handle.dispose();
    `;

    const results = await Promise.all([
      runLoggerChild({
        environment: { OHBABY_LOG_TEST_ROOT: logRoot },
        script,
      }),
      runLoggerChild({
        environment: { OHBABY_LOG_TEST_ROOT: logRoot },
        script,
      }),
    ]);
    expect(results).toEqual([
      { code: 0, stderr: "" },
      { code: 0, stderr: "" },
    ]);

    const files = (await readdir(path.join(logRoot, "serve"))).filter((file) =>
      file.endsWith(".jsonl"),
    );
    expect(files).toHaveLength(2);
    expect(new Set(files.map((file) => file.split("-").at(-2))).size).toBe(2);
    for (const file of files) {
      const contents = await readFile(
        path.join(logRoot, "serve", file),
        "utf8",
      );
      expect(contents).toContain('"event":"diagnostics.child_process"');
    }
  });

  it("preserves a real child exit code when writer close hangs", async () => {
    const logRoot = await temporaryDirectory();
    const script = `
      import { createProcessLoggerWithLimits } from ${JSON.stringify(
        processLoggerModuleUrl,
      )};
      const handle = await createProcessLoggerWithLimits(
        { logDirectory: process.env.OHBABY_LOG_TEST_ROOT, role: "tui" },
        {
          disposeTimeoutMs: 50,
          maxBytes: 1024,
          maxFiles: 3,
          maxLineBytes: 16384,
          maxQueue: 64,
          retentionMs: 1000,
        },
        {
          createWriter: () => Promise.resolve({
            close: () => new Promise(() => undefined),
            path: "/virtual/hanging.jsonl",
            write: () => Promise.resolve(),
          }),
        },
      );
      process.exitCode = 23;
      await handle.dispose();
    `;

    const result = await runLoggerChild({
      environment: { OHBABY_LOG_TEST_ROOT: logRoot },
      script,
      timeoutMs: 2_000,
    });

    expect(result).toEqual({ code: 23, stderr: "" });
  });
});
