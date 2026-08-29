import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
});
