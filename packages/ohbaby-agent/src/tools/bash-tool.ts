import type {
  ChildProcess,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import type {
  Tool,
  ToolExecutionResult,
} from "../core/tool-scheduler/index.js";
import { Shell } from "../shell/index.js";
import { parseCommand } from "../utils/index.js";
import { resolveCommandContext } from "./utils/context.js";
import { truncateOutput } from "./utils/output.js";
import { getNumberParam, getStringParam, ToolParameterError } from "./utils/params.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

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

function shellArgs(shellPath: string, command: string): readonly string[] {
  const shellName = path.basename(shellPath).toLowerCase();
  if (shellName === "cmd.exe" || shellName === "cmd") {
    return ["/d", "/s", "/c", command];
  }

  return ["-lc", command];
}

function commandOutput(stdout: string, stderr: string): string {
  const output = [stdout.trimEnd(), stderr.trimEnd()]
    .filter((part) => part.length > 0)
    .join("\n");
  return truncateOutput(output || "Command completed with no output.");
}

function chunkToString(chunk: unknown): string {
  return Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
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
        throw new ToolParameterError("Unsupported shell syntax in bash command.");
      }
      if (context.signal.aborted) {
        throw new Error("Command was cancelled.");
      }

      const commandContext = resolveCommandContext(context);
      const shellPath = shell.acceptable();
      const args = shellArgs(shellPath, command);
      const prefix = commandContext.commandPrefix ?? [];
      const spawnFile = prefix[0] ?? shellPath;
      const spawnArgs = prefix.length > 0 ? [...prefix.slice(1), shellPath, ...args] : args;
      const child = spawn(spawnFile, spawnArgs, {
        cwd: commandContext.cwd,
        env: { ...process.env, ...commandContext.env },
        windowsHide: true,
      });

      return await new Promise<ToolExecutionResult>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        const timeoutId = setTimeout(() => {
          rejectAfterKill(new Error(`Command timed out after ${String(timeout)}ms.`));
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
          void Promise.resolve(shell.killTree(child)).finally(() => {
            reject(error);
          });
        }

        function abortHandler(): void {
          rejectAfterKill(new Error("Command was cancelled."));
        }

        child.stdout?.on("data", (chunk: unknown) => {
          stdout += chunkToString(chunk);
        });
        child.stderr?.on("data", (chunk: unknown) => {
          stderr += chunkToString(chunk);
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
          resolve({
            output: commandOutput(stdout, stderr),
            metadata: {
              exitCode,
              paths: parsed.details.flatMap((detail) => [...detail.paths]),
              roots: parsed.roots,
              signal,
            },
          });
        });

        context.signal.addEventListener("abort", abortHandler, { once: true });
      });
    },
  };
}
