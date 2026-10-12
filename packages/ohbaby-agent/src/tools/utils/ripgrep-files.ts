import { spawn } from "node:child_process";
import {
  killTree,
  probeProcessTree,
  type KillTreeResult,
} from "../../shell/process.js";
import {
  RIPGREP_RECORD_BYTES,
  RIPGREP_STDERR_BYTES,
  RIPGREP_STDOUT_BYTES,
  type SearchStopReason,
} from "./ripgrep-search.js";
import { ToolParameterError } from "./params.js";

export function normalizeGlobPattern(
  pattern: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (/^(?:[\\/]|[A-Za-z]:)/u.test(pattern))
    throw new ToolParameterError(
      "Glob pattern must be relative to the search root; absolute paths are unsupported.",
    );
  const normalized = (
    platform === "win32" ? pattern.replaceAll("\\", "/") : pattern
  ).replace(/^(?:\.\/)+/u, "");
  if (/^(?:[\\/]|[A-Za-z]:)/u.test(normalized))
    throw new ToolParameterError(
      "Glob pattern must be relative to the search root; absolute paths are unsupported.",
    );
  if (
    !normalized ||
    normalized.includes("\0") ||
    normalized.split("/").includes("..")
  )
    throw new ToolParameterError(
      "Glob pattern must stay within the search root and must not contain '..' or NUL.",
    );
  return normalized;
}
interface GlobProcessOptions {
  readonly executablePath: string;
  readonly cwd: string;
  readonly pattern: string;
  readonly signal: AbortSignal;
  readonly onPath: (relativePath: string) => SearchStopReason | undefined;
  readonly reportCleanup?: (
    state: "in-progress" | "unconfirmed" | "confirmed",
  ) => void;
  readonly reportCleanupError?: (error: unknown) => void;
}
export interface GlobProcessCompletion {
  readonly stopReason?: SearchStopReason;
  readonly processExited: true;
}
function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Glob cancelled.");
}
/** NUL-framed paths are independent from Grep's JSON match protocol. */
export async function listFilesWithRipgrep(
  options: GlobProcessOptions,
): Promise<GlobProcessCompletion> {
  if (options.signal.aborted) throw abortError(options.signal);
  const args = [
    "--no-config",
    "--files",
    "--no-ignore",
    "--hidden",
    "--null",
    "--sort=path",
    "--path-separator=/",
    "--glob",
    `/${options.pattern}`,
    "--glob",
    "!.git",
    "--glob",
    "!dist",
    "--glob",
    "!node_modules",
    "--glob",
    "!out",
    "--glob",
    "!target",
    "--",
    ".",
  ];
  return await new Promise((resolve, reject) => {
    const child = spawn(options.executablePath, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const frame = Buffer.allocUnsafe(RIPGREP_RECORD_BYTES);
    let frameBytes = 0;
    let stdoutBytes = 0;
    let stderr = Buffer.alloc(0);
    let failure: Error | undefined;
    let stopReason: SearchStopReason | undefined;
    let closed = false;
    let cleanup: Promise<KillTreeResult> | undefined;
    function terminate(): void {
      if (cleanup) return;
      options.reportCleanup?.("in-progress");
      cleanup = killTree(child, { exited: () => closed });
      void cleanup.then((result) => {
        options.reportCleanup?.(
          result.status === "confirmed" ? "confirmed" : "unconfirmed",
        );
        if (result.status !== "confirmed")
          options.reportCleanupError?.(
            new Error(`Glob cleanup unconfirmed: ${String(result.reason)}`),
          );
      });
    }
    function fail(error: Error): void {
      failure ??= error;
      terminate();
    }
    function stop(reason: SearchStopReason): void {
      stopReason ??= reason;
      terminate();
    }
    function stopped(): boolean {
      return failure !== undefined || stopReason !== undefined;
    }
    const onAbort = (): void => {
      fail(abortError(options.signal));
    };
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) onAbort();
    child.stdout.on("data", (chunk: Buffer) => {
      if (stopped()) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > RIPGREP_STDOUT_BYTES) {
        stop("stdout-limit");
        return;
      }
      let offset = 0;
      while (offset < chunk.length && !stopped()) {
        const nul = chunk.indexOf(0, offset);
        const end = nul < 0 ? chunk.length : nul;
        const length = end - offset;
        if (frameBytes + length > RIPGREP_RECORD_BYTES) {
          stop("record-limit");
          return;
        }
        chunk.copy(frame, frameBytes, offset, end);
        frameBytes += length;
        if (nul < 0) break;
        try {
          let relativePath = new TextDecoder("utf-8", { fatal: true }).decode(
            frame.subarray(0, frameBytes),
          );
          if (relativePath.startsWith("./"))
            relativePath = relativePath.slice(2);
          if (
            !relativePath ||
            relativePath.startsWith("/") ||
            relativePath.split("/").includes("..")
          )
            throw new Error("Invalid relative path frame.");
          const reason = options.onPath(relativePath);
          if (reason) stop(reason);
        } catch (cause) {
          fail(
            new Error(
              "Glob failed: a ripgrep path frame is invalid or not UTF-8; no reliable path can be delivered.",
              { cause },
            ),
          );
        }
        frameBytes = 0;
        offset = nul + 1;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = RIPGREP_STDERR_BYTES - stderr.length;
      if (remaining > 0)
        stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)]);
      if (chunk.length > remaining)
        fail(
          new Error(
            "Glob failed: ripgrep diagnostics exceeded the 64 KiB limit.",
          ),
        );
    });
    child.on("error", (error) => {
      failure = new Error(
        `Glob unavailable: bundled ripgrep could not start: ${error.message}`,
        { cause: error },
      );
    });
    child.stdout.on("error", (error) => {
      fail(new Error(`Glob failed: stdout: ${error.message}`));
    });
    child.stderr.on("error", (error) => {
      fail(new Error(`Glob failed: stderr: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      closed = true;
      options.signal.removeEventListener("abort", onAbort);
      void (async (): Promise<void> => {
        const cleaned = await cleanup;
        if (cleaned && cleaned.status !== "confirmed") {
          // A short-lived rg can exit between the initial cleanup probe and close.
          // Recheck the original group once; close alone never proves tree cleanup.
          if (
            probeProcessTree(child, {
              exited: () => closed,
              terminationSucceeded: cleaned.terminationSucceeded,
            }) === "stopped"
          )
            options.reportCleanup?.("confirmed");
          else
            throw new Error(
              `Glob failed: process cleanup is unconfirmed (${String(cleaned.reason)}).`,
            );
        }
        if (failure) throw failure;
        if (stderr.length)
          throw new Error(
            `Glob failed: ${stderr.toString("utf8").slice(0, 8000)}`,
          );
        if (!stopReason && code !== 0 && code !== 1)
          throw new Error(
            `Glob failed: ripgrep exited with ${code === null ? `signal ${String(signal)}` : `code ${String(code)}`}.`,
          );
        if (!stopReason && frameBytes)
          throw new Error(
            "Glob failed: ripgrep ended before a complete NUL path frame.",
          );
        resolve({ stopReason, processExited: true });
      })().catch(reject);
    });
  });
}
