import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { killTree } from "../../shell/process.js";

// Bound the wire protocol before decoding/JSON parsing, not just the final output.
export const RIPGREP_RECORD_BYTES = 4 * 1024 * 1024;
export const RIPGREP_STDOUT_BYTES = 16 * 1024 * 1024;
export const RIPGREP_STDERR_BYTES = 64 * 1024;

export type SearchStopReason =
  | "match-limit"
  | "output-limit"
  | "record-limit"
  | "stdout-limit";

interface EncodedText {
  text?: string;
  bytes?: string;
}

export interface RipgrepMatch {
  readonly path: string;
  readonly line: number;
  readonly text?: string;
  readonly matchStart: number;
  readonly matchCount: number;
}

interface SearchOptions {
  readonly executablePath: string;
  readonly target: string;
  readonly cwd: string;
  readonly pattern: string;
  readonly include?: string;
  readonly signal: AbortSignal;
  readonly onMatch: (match: RipgrepMatch) => SearchStopReason | undefined;
}

export interface SearchCompletion {
  readonly stopReason?: SearchStopReason;
  readonly binaryFileCount: number;
  readonly processExited: true;
}

export function resolveBundledRipgrepPath(): string {
  try {
    // Keep platform package resolution lazy: a missing optional package must not
    // prevent importing tools or starting the application.
    const require = createRequire(import.meta.url);
    return (require("@vscode/ripgrep") as { rgPath: string }).rgPath;
  } catch (error) {
    throw new Error(
      "Search unavailable: the bundled ripgrep platform package is missing or damaged. Reinstall application dependencies including optional packages.",
      { cause: error },
    );
  }
}

function decodePath(value: EncodedText): string {
  if (typeof value.text === "string") return value.text;
  if (typeof value.bytes === "string") {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(value.bytes, "base64"),
      );
    } catch {
      throw new Error(
        "Search failed: a matched path is not valid UTF-8; its location cannot be delivered reliably.",
      );
    }
  }
  throw new Error("Search failed: missing match path in ripgrep output.");
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Search cancelled.");
}

export async function searchWithRipgrep(
  options: SearchOptions,
): Promise<SearchCompletion> {
  if (options.signal.aborted) throw abortError(options.signal);
  const args = [
    "--no-config",
    "--engine=default",
    "--json",
    "--hidden",
    "--no-ignore-global",
    "--no-ignore-parent",
    "--no-require-git",
    "--threads=1",
  ];
  if (options.include !== undefined) args.push("--glob", options.include);
  // Last glob wins. This excludes .git during traversal, but rg still honors an
  // explicit file target (including one inside .git).
  args.push(
    "--glob",
    "!.git",
    "--regexp",
    options.pattern,
    "--",
    options.target,
  );

  return await new Promise<SearchCompletion>((resolve, reject) => {
    const child = spawn(options.executablePath, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const recordBuffer = Buffer.allocUnsafe(RIPGREP_RECORD_BYTES);
    let recordBytes = 0;
    let stdoutBytes = 0;
    let stderr = Buffer.alloc(0);
    let failure: Error | undefined;
    let stopReason: SearchStopReason | undefined;
    let binaryFileCount = 0;
    let summarySeen = false;
    let openFiles = 0;
    let closed = false;
    let cleanup: ReturnType<typeof killTree> | undefined;

    const terminate = (): void => {
      cleanup ??= killTree(child, { exited: () => closed });
    };
    const fail = (error: Error): void => {
      failure ??= error;
      terminate();
    };
    const stop = (reason: SearchStopReason): void => {
      stopReason ??= reason;
      terminate();
    };
    const onAbort = (): void => {
      fail(abortError(options.signal));
    };
    const isStopped = (): boolean =>
      failure !== undefined || stopReason !== undefined;
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) onAbort();

    const acceptRecord = (record: Buffer): void => {
      try {
        const event = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(record),
        ) as {
          type: string;
          data: {
            path: EncodedText;
            lines: EncodedText;
            line_number: number;
            submatches: { start: number }[];
            binary_offset?: number | null;
          };
        };
        if (summarySeen) throw new Error("Records after summary");
        if (event.type === "begin") openFiles += 1;
        else if (event.type === "end") {
          if (openFiles === 0) throw new Error("Unpaired end record");
          openFiles -= 1;
          if (
            event.data.binary_offset !== null &&
            event.data.binary_offset !== undefined
          )
            binaryFileCount += 1;
        } else if (event.type === "summary") summarySeen = true;
        else if (event.type === "match") {
          const data = event.data;
          if (
            !Number.isSafeInteger(data.line_number) ||
            data.line_number < 1 ||
            !Array.isArray(data.submatches) ||
            !data.submatches.length
          )
            throw new Error("Invalid match location");
          const matchStart = data.submatches[0].start;
          if (!Number.isSafeInteger(matchStart) || matchStart < 0)
            throw new Error("Invalid match offset");
          const reason = options.onMatch({
            path: decodePath(data.path),
            line: data.line_number,
            text:
              typeof data.lines.text === "string" ? data.lines.text : undefined,
            matchStart,
            matchCount: data.submatches.length,
          });
          if (reason) stop(reason);
        } else throw new Error("Unexpected record type");
      } catch (error) {
        fail(
          new Error(
            `Search failed: invalid ripgrep output: ${error instanceof Error ? error.message : "invalid record"}`,
          ),
        );
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (isStopped()) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > RIPGREP_STDOUT_BYTES) {
        stop("stdout-limit");
        return;
      }
      let offset = 0;
      while (offset < chunk.length && !isStopped()) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        const length = end - offset;
        if (recordBytes + length > RIPGREP_RECORD_BYTES) {
          stop("record-limit");
          return;
        }
        chunk.copy(recordBuffer, recordBytes, offset, end);
        recordBytes += length;
        if (newline < 0) break;
        acceptRecord(recordBuffer.subarray(0, recordBytes));
        recordBytes = 0;
        offset = newline + 1;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = RIPGREP_STDERR_BYTES - stderr.length;
      if (remaining > 0)
        stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)]);
      if (chunk.length > remaining)
        fail(
          new Error(
            "Search failed: ripgrep diagnostics exceeded the 64 KiB stderr limit.",
          ),
        );
    });
    child.on("error", (error) => {
      failure = new Error(
        `Search unavailable: bundled ripgrep could not start: ${error.message}`,
        { cause: error },
      );
    });
    child.stdout.on("error", (error) => {
      fail(new Error(`Search failed: stdout: ${error.message}`));
    });
    child.stderr.on("error", (error) => {
      fail(new Error(`Search failed: stderr: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      closed = true;
      options.signal.removeEventListener("abort", onAbort);
      // close proves stdio and the child exited; also await shared tree cleanup.
      void (async (): Promise<void> => {
        await cleanup;
        if (failure) throw failure;
        if (stderr.length)
          throw new Error(
            `Search failed: ${stderr.toString("utf8").slice(0, 8000)}`,
          );
        if (!stopReason && code !== 0 && code !== 1)
          throw new Error(
            `Search failed: ripgrep exited with ${code === null ? `signal ${String(signal)}` : `code ${String(code)}`}.`,
          );
        if (
          !stopReason &&
          (!summarySeen || openFiles !== 0 || recordBytes !== 0)
        )
          throw new Error(
            "Search failed: ripgrep output ended before a complete search summary.",
          );
        resolve({ stopReason, binaryFileCount, processExited: true });
      })().catch(reject);
    });
  });
}
