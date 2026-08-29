import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
  chmod,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveOhbabyHome } from "../paths/index.js";
import { diagnosticsStarted, loggerEventsDropped } from "./events.js";
import {
  encodeDiagnosticEvent,
  LOG_LEVEL_PRIORITY,
  NOOP_LOGGER,
  type DiagnosticEventDefinition,
  type DiagnosticRoots,
  type EncodedDiagnosticEvent,
  type LogLevel,
  type Logger,
} from "./logger.js";

export type DiagnosticsRole = "cli" | "serve" | "tui";

export interface CreateProcessLoggerOptions {
  readonly homeDirectory?: string;
  readonly level?: string;
  readonly logDirectory?: string;
  readonly ohbabyHome?: string;
  readonly onUnavailable?: (reason: "initialize" | "write" | "flush") => void;
  readonly role: DiagnosticsRole;
  readonly tmpDirectory?: string;
  readonly workspaceRoot?: string;
}

export interface ProcessLoggerHandle {
  readonly logFilePath: string;
  readonly logger: Logger;
  dispose(): Promise<void>;
  flush(): Promise<void>;
}

interface ProcessLoggerLimits {
  readonly disposeTimeoutMs: number;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly maxLineBytes: number;
  readonly maxQueue: number;
  readonly retentionMs: number;
}

const DEFAULT_LIMITS: ProcessLoggerLimits = {
  disposeTimeoutMs: 2_000,
  maxBytes: 8 * 1024 * 1024,
  maxFiles: 3,
  maxLineBytes: 16 * 1024,
  maxQueue: 1_024,
  retentionMs: 14 * 24 * 60 * 60 * 1_000,
};

const LOG_FILE_PATTERN =
  /^(?<instance>\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-(?<pid>\d+)-[a-f0-9]{8})(?:\.(?<segment>[12]))?\.jsonl$/;

export class DiagnosticsConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiagnosticsConfigurationError";
  }
}

function parseLevel(value: string | undefined): LogLevel {
  const resolved = value ?? "info";
  if (
    resolved === "error" ||
    resolved === "warn" ||
    resolved === "info" ||
    resolved === "debug" ||
    resolved === "trace"
  ) {
    return resolved;
  }
  throw new DiagnosticsConfigurationError(
    "OHBABY_LOG_LEVEL must be error, warn, info, debug, or trace",
  );
}

function resolveLogRoot(options: CreateProcessLoggerOptions): {
  readonly explicit: boolean;
  readonly root: string;
} {
  const configured = options.logDirectory ?? process.env.OHBABY_LOG_DIR;
  if (configured !== undefined) {
    if (!path.isAbsolute(configured)) {
      throw new DiagnosticsConfigurationError(
        "OHBABY_LOG_DIR must be an absolute path",
      );
    }
    return { explicit: true, root: path.resolve(configured) };
  }
  const ohbabyHome =
    options.ohbabyHome ??
    resolveOhbabyHome({ homeDirectory: options.homeDirectory });
  return { explicit: false, root: path.join(ohbabyHome, "logs") };
}

function resolveLevel(options: CreateProcessLoggerOptions): LogLevel {
  return parseLevel(options.level ?? process.env.OHBABY_LOG_LEVEL);
}

function notifyOnce(
  callback: CreateProcessLoggerOptions["onUnavailable"],
): (reason: "initialize" | "write" | "flush") => void {
  let notified = false;
  return (reason): void => {
    if (notified) {
      return;
    }
    notified = true;
    try {
      callback?.(reason);
    } catch {
      // Diagnostics failure callbacks are deliberately fail-open.
    }
  };
}

function timestampForFilename(date: Date): string {
  return date.toISOString().replaceAll(":", "-").replace(".", "-");
}

function processIsDefinitelyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    );
  }
}

async function cleanExpiredLogs(
  directory: string,
  currentInstance: string,
  limits: ProcessLoggerLimits,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return;
  }
  const cutoff = Date.now() - limits.retentionMs;
  await Promise.all(
    entries.map(async (entry) => {
      const match = LOG_FILE_PATTERN.exec(entry);
      if (!match?.groups || match.groups.instance === currentInstance) {
        return;
      }
      const pid = Number(match.groups.pid);
      if (!processIsDefinitelyDead(pid)) {
        return;
      }
      const candidate = path.join(directory, entry);
      try {
        const details = await stat(candidate);
        if (details.isFile() && details.mtimeMs < cutoff) {
          await rm(candidate);
        }
      } catch {
        // Retention is best-effort and never blocks startup.
      }
    }),
  );
}

class RotatingFileWriter {
  private activePath: string;
  private bytes = 0;
  private file: FileHandle;

  private constructor(
    private readonly directory: string,
    private readonly instance: string,
    file: FileHandle,
    private readonly limits: ProcessLoggerLimits,
  ) {
    this.activePath = path.join(directory, `${instance}.jsonl`);
    this.file = file;
  }

  static async create(
    directory: string,
    instance: string,
    limits: ProcessLoggerLimits,
  ): Promise<RotatingFileWriter> {
    await mkdir(directory, { mode: 0o700, recursive: true });
    if (process.platform !== "win32") {
      await chmod(directory, 0o700);
    }
    const activePath = path.join(directory, `${instance}.jsonl`);
    const file = await open(
      activePath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    if (process.platform !== "win32") {
      await file.chmod(0o600);
    }
    return new RotatingFileWriter(directory, instance, file, limits);
  }

  get path(): string {
    return this.activePath;
  }

  async close(): Promise<void> {
    await this.file.close();
  }

  async write(line: string): Promise<void> {
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (this.bytes > 0 && this.bytes + lineBytes > this.limits.maxBytes) {
      await this.rotate();
    }
    await this.file.write(line);
    this.bytes += lineBytes;
  }

  private async rotate(): Promise<void> {
    await this.file.close();
    for (let segment = this.limits.maxFiles - 1; segment >= 1; segment -= 1) {
      const source =
        segment === 1
          ? path.join(this.directory, `${this.instance}.jsonl`)
          : path.join(
              this.directory,
              `${this.instance}.${String(segment - 1)}.jsonl`,
            );
      const target = path.join(
        this.directory,
        `${this.instance}.${String(segment)}.jsonl`,
      );
      try {
        if (segment === this.limits.maxFiles - 1) {
          await rm(target, { force: true });
        }
        await rename(source, target);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          (error as NodeJS.ErrnoException).code !== "ENOENT"
        ) {
          throw error;
        }
      }
    }
    this.activePath = path.join(this.directory, `${this.instance}.jsonl`);
    this.file = await open(
      this.activePath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    this.bytes = 0;
  }
}

interface QueueEntry {
  readonly level: LogLevel;
  readonly line: string;
}

function withoutKey(
  record: Readonly<Record<string, unknown>>,
  omittedKey: string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== omittedKey),
  );
}

function encodeLine(
  event: EncodedDiagnosticEvent,
  maxLineBytes: number,
): string {
  let record = { ...event.record };
  let line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line, "utf8") <= maxLineBytes) {
    return line;
  }
  for (const key of Object.keys(record).reverse()) {
    if (key === "ts" || key === "level" || key === "event" || key === "component") {
      continue;
    }
    record = withoutKey(record, key);
    record.truncated = true;
    line = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line, "utf8") <= maxLineBytes) {
      return line;
    }
  }
  return `${JSON.stringify({
    component: record.component,
    event: record.event,
    level: record.level,
    truncated: true,
    ts: record.ts,
  })}\n`;
}

class ProcessFileLogger implements Logger {
  private accepting = true;
  private disabled = false;
  private drainPromise: Promise<void> | undefined;
  private readonly dropped: Record<LogLevel, number> = {
    debug: 0,
    error: 0,
    info: 0,
    trace: 0,
    warn: 0,
  };
  private queue: QueueEntry[] = [];

  constructor(
    private readonly writer: RotatingFileWriter,
    private readonly level: LogLevel,
    private readonly roots: DiagnosticRoots,
    private readonly limits: ProcessLoggerLimits,
    private readonly unavailable: (
      reason: "initialize" | "write" | "flush",
    ) => void,
  ) {}

  emit<Input>(
    definition: DiagnosticEventDefinition<Input>,
    input: Input,
  ): void {
    if (!this.accepting || this.disabled) {
      return;
    }
    try {
      const encoded = encodeDiagnosticEvent(
        definition,
        input,
        { roots: this.roots },
        new Date().toISOString(),
      );
      if (LOG_LEVEL_PRIORITY[encoded.level] > LOG_LEVEL_PRIORITY[this.level]) {
        return;
      }
      this.enqueueDropSummaryIfNeeded();
      this.enqueue({
        level: encoded.level,
        line: encodeLine(encoded, this.limits.maxLineBytes),
      });
    } catch {
      this.disable("write");
    }
  }

  async dispose(): Promise<void> {
    if (!this.accepting) {
      return;
    }
    this.enqueueDropSummaryIfNeeded();
    this.accepting = false;
    await this.waitForDrain();
    if (!this.disabled) {
      try {
        await this.writer.close();
      } catch {
        this.disable("flush");
      }
    }
  }

  async flush(): Promise<void> {
    await this.waitForDrain();
  }

  private disable(reason: "write" | "flush"): void {
    this.disabled = true;
    this.queue = [];
    this.unavailable(reason);
  }

  private enqueue(entry: QueueEntry): void {
    if (this.queue.length >= this.limits.maxQueue) {
      const replacement = this.queue.findIndex(
        (queued) =>
          LOG_LEVEL_PRIORITY[queued.level] > LOG_LEVEL_PRIORITY[entry.level],
      );
      if (replacement >= 0) {
        const [removed] = this.queue.splice(replacement, 1, entry);
        this.dropped[removed.level] += 1;
      } else {
        this.dropped[entry.level] += 1;
      }
      return;
    }
    this.queue.push(entry);
    this.startDrain();
  }

  private enqueueDropSummaryIfNeeded(): void {
    if (
      this.queue.length >= this.limits.maxQueue ||
      Object.values(this.dropped).every((count) => count === 0)
    ) {
      return;
    }
    const counts = { ...this.dropped };
    for (const level of Object.keys(this.dropped) as LogLevel[]) {
      this.dropped[level] = 0;
    }
    const encoded = encodeDiagnosticEvent(
      loggerEventsDropped,
      counts,
      { roots: this.roots },
      new Date().toISOString(),
    );
    this.queue.push({
      level: encoded.level,
      line: encodeLine(encoded, this.limits.maxLineBytes),
    });
    this.startDrain();
  }

  private startDrain(): void {
    if (this.drainPromise !== undefined || this.disabled) {
      return;
    }
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = undefined;
      if (this.queue.length > 0 && !this.disabled) {
        this.startDrain();
      }
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0 && !this.disabled) {
      const entry = this.queue.shift();
      if (!entry) {
        continue;
      }
      try {
        await this.writer.write(entry.line);
      } catch {
        this.disable("write");
      }
    }
  }

  private async waitForDrain(): Promise<void> {
    this.startDrain();
    const drain = this.drainPromise ?? Promise.resolve();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        drain,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => {
              reject(new Error("diagnostics drain timed out"));
            },
            this.limits.disposeTimeoutMs,
          );
          timer.unref();
        }),
      ]);
    } catch {
      this.disable("flush");
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}

function disabledHandle(logFilePath: string): ProcessLoggerHandle {
  return {
    dispose(): Promise<void> {
      return Promise.resolve();
    },
    flush(): Promise<void> {
      return Promise.resolve();
    },
    logFilePath,
    logger: NOOP_LOGGER,
  };
}

export async function createProcessLogger(
  options: CreateProcessLoggerOptions,
): Promise<ProcessLoggerHandle> {
  return createProcessLoggerWithLimits(options, DEFAULT_LIMITS);
}

export async function createProcessLoggerWithLimits(
  options: CreateProcessLoggerOptions,
  limits: ProcessLoggerLimits,
): Promise<ProcessLoggerHandle> {
  const level = resolveLevel(options);
  const logRoot = resolveLogRoot(options);
  const directory = path.join(logRoot.root, options.role);
  const instance = `${timestampForFilename(new Date())}-${String(process.pid)}-${randomUUID().slice(0, 8)}`;
  const logFilePath = path.join(directory, `${instance}.jsonl`);
  const unavailable = notifyOnce(options.onUnavailable);
  let writer: RotatingFileWriter;
  try {
    writer = await RotatingFileWriter.create(directory, instance, limits);
  } catch (error) {
    if (logRoot.explicit) {
      throw new DiagnosticsConfigurationError(
        `Could not initialize OHBABY_LOG_DIR: ${
          error instanceof Error ? error.message : "unknown filesystem error"
        }`,
      );
    }
    unavailable("initialize");
    return disabledHandle(logFilePath);
  }
  void cleanExpiredLogs(directory, instance, limits);
  const logger = new ProcessFileLogger(
    writer,
    level,
    {
      home: options.homeDirectory ?? os.homedir(),
      ohbabyHome:
        options.ohbabyHome ??
        resolveOhbabyHome({ homeDirectory: options.homeDirectory }),
      tmp: options.tmpDirectory ?? os.tmpdir(),
      workspace: options.workspaceRoot,
    },
    limits,
    unavailable,
  );
  logger.emit(diagnosticsStarted, { role: options.role });
  return {
    dispose: () => logger.dispose(),
    flush: () => logger.flush(),
    logFilePath: writer.path,
    logger,
  };
}
