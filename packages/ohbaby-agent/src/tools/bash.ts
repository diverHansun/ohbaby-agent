import type {
  ChildProcess,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import type {
  Tool,
  ToolExecutionResult,
} from "../core/tool-scheduler/index.js";
import {
  detectShellKind,
  preflightShellCommand,
  shellArgs,
  Shell,
} from "../shell/index.js";
import { parseCommand } from "../utils/index.js";
import { resolveCommandContext } from "./utils/context.js";
import { DEFAULT_OUTPUT_TOKEN_LIMIT, truncateOutput } from "./utils/output.js";
import {
  getNumberParam,
  getStringParam,
  ToolParameterError,
} from "./utils/params.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const OUTPUT_CAPTURE_CHAR_LIMIT = DEFAULT_OUTPUT_TOKEN_LIMIT * 4 + 1;

export interface BashShell {
  acceptable(): string;
  killTree(process: ChildProcess): Promise<void> | void;
}

export type SpawnCommand = (
  file: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcess;

export interface BashToolOptions {
  readonly shell?: BashShell;
  readonly spawn?: SpawnCommand;
}

function spawnProcess(
  file: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
): ChildProcess {
  return nodeSpawn(file, [...args], options);
}

function commandOutput(
  stdout: string,
  stderr: string,
  streamTruncated: boolean,
): { readonly output: string; readonly truncated: boolean } {
  const output = [stdout.trimEnd(), stderr.trimEnd()]
    .filter((part) => part.length > 0)
    .join("\n");
  const baseOutput = output || "Command completed with no output.";
  const rendered = truncateOutput(baseOutput);
  return {
    output: rendered,
    truncated: streamTruncated || rendered !== baseOutput,
  };
}

function chunkToString(chunk: unknown): string {
  return Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
}

function appendLimitedOutput(
  current: string,
  chunk: string,
): { readonly output: string; readonly truncated: boolean } {
  if (current.length >= OUTPUT_CAPTURE_CHAR_LIMIT) {
    return { output: current, truncated: true };
  }
  const next = current + chunk;
  if (next.length <= OUTPUT_CAPTURE_CHAR_LIMIT) {
    return { output: next, truncated: false };
  }

  return {
    output: next.slice(0, OUTPUT_CAPTURE_CHAR_LIMIT),
    truncated: true,
  };
}

function stateEnvironment(input: {
  readonly callId: string;
  readonly cwd: string;
  readonly env?: Record<string, string>;
  readonly messageId: string;
  readonly sessionId: string;
}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...input.env,
    OHBABY_CALL_ID: input.callId,
    OHBABY_MESSAGE_ID: input.messageId,
    OHBABY_SESSION_ID: input.sessionId,
    OHBABY_WORKDIR: input.cwd,
  };
}

function shouldDetach(shellKind: string): boolean {
  return !(process.platform === "win32" && shellKind === "powershell");
}

export function createBashTool(options: BashToolOptions = {}): Tool {
  const shell = options.shell ?? Shell;
  const spawn = options.spawn ?? spawnProcess;

  return {
    name: "bash",
    description: "Run a shell command in the execution workspace.",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        command: { type: "string" },
        timeout: {
          maximum: MAX_TIMEOUT_MS,
          minimum: 1,
          type: "integer",
        },
      },
      required: ["command"],
      type: "object",
    },
    source: "builtin",
    category: "dangerous",
    async execute(params, context): Promise<ToolExecutionResult> {
      const command = getStringParam(params, "command");
      const timeout = getNumberParam(params, "timeout", {
        defaultValue: DEFAULT_TIMEOUT_MS,
        integer: true,
        max: MAX_TIMEOUT_MS,
        min: 1,
      });
      const parsed = parseCommand(command);
      if (parsed.hasError) {
        throw new ToolParameterError(
          "Unsupported shell syntax in bash command.",
        );
      }
      if (context.signal.aborted) {
        throw new Error("Command was cancelled.");
      }

      const commandContext = resolveCommandContext(context);
      if ((commandContext.commandPrefix?.length ?? 0) > 0) {
        throw new Error(
          "ToolExecutionContext commandPrefix is not supported by builtin bash yet; wire a command context bridge with final cwd/env before running bash.",
        );
      }
      const shellPath = shell.acceptable();
      const shellKind = detectShellKind(shellPath);
      const preflight = await preflightShellCommand({
        command,
        cwd: commandContext.cwd,
        parsed,
        rootCwd: context.environment?.workdir ?? commandContext.cwd,
        shellKind,
      });
      const args = shellArgs(shellPath, command);
      const child = spawn(shellPath, args, {
        cwd: commandContext.cwd,
        detached: shouldDetach(shellKind),
        env: stateEnvironment({
          callId: context.callId,
          cwd: commandContext.cwd,
          env: commandContext.env,
          messageId: context.messageId,
          sessionId: context.sessionId,
        }),
        windowsHide: true,
      });

      return await new Promise<ToolExecutionResult>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        let streamTruncated = false;
        const timeoutId = setTimeout(() => {
          rejectAfterKill(
            new Error(`Command timed out after ${String(timeout)}ms.`),
          );
        }, timeout);

        function cleanup(): void {
          clearTimeout(timeoutId);
          context.signal.removeEventListener("abort", abortHandler);
        }

        function rejectAfterKill(error: Error): void {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          void Promise.resolve()
            .then(() => shell.killTree(child))
            .catch(() => undefined)
            .then(() => {
              reject(error);
            });
        }

        function abortHandler(): void {
          rejectAfterKill(new Error("Command was cancelled."));
        }

        child.stdout?.on("data", (chunk: unknown) => {
          const next = appendLimitedOutput(stdout, chunkToString(chunk));
          stdout = next.output;
          streamTruncated ||= next.truncated;
        });
        child.stderr?.on("data", (chunk: unknown) => {
          const next = appendLimitedOutput(stderr, chunkToString(chunk));
          stderr = next.output;
          streamTruncated ||= next.truncated;
        });
        child.once("error", (error) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          reject(error);
        });
        child.once("exit", (exitCode, signal) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          const rendered = commandOutput(stdout, stderr, streamTruncated);
          resolve({
            output: rendered.output,
            metadata: {
              cdTargets: preflight.cdTargets,
              cwd: commandContext.cwd,
              exitCode,
              paths: parsed.details.flatMap((detail) => [...detail.paths]),
              pid: child.pid,
              resolvedPaths: preflight.resolvedPaths,
              roots: parsed.roots,
              shell: shellPath,
              shellKind,
              signal,
              truncated: rendered.truncated,
            },
          });
        });

        context.signal.addEventListener("abort", abortHandler, { once: true });
      });
    },
  };
}
