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
import {
  DEFAULT_SHELL_JOB_TIMEOUT_MS,
  MAX_SHELL_JOB_TIMEOUT_MS,
  ShellJobRegistry,
} from "./shell-job-registry.js";
import {
  getNumberParam,
  getStringParam,
  ToolParameterError,
} from "./utils/params.js";

const DEFAULT_TIMEOUT_MS = DEFAULT_SHELL_JOB_TIMEOUT_MS;
const MAX_TIMEOUT_MS = MAX_SHELL_JOB_TIMEOUT_MS;

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
  readonly preflight?: typeof preflightShellCommand;
  readonly shell?: BashShell;
  readonly spawn?: SpawnCommand;
  readonly registry?: ShellJobRegistry;
}

function spawnProcess(
  file: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
): ChildProcess {
  return nodeSpawn(file, [...args], options);
}

function stateEnvironment(input: {
  readonly callId: string;
  readonly cwd: string;
  readonly env?: Record<string, string>;
  readonly messageId: string;
  readonly sessionId: string;
  readonly shellPath: string;
}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT ?? "0",
    NO_COLOR: "1",
    SHELL: input.shellPath,
    TERM: "dumb",
    ...input.env,
    OHBABY_CALL_ID: input.callId,
    OHBABY_MESSAGE_ID: input.messageId,
    OHBABY_SESSION_ID: input.sessionId,
    OHBABY_WORKDIR: input.cwd,
  };
}

function shouldDetach(): boolean {
  return process.platform !== "win32";
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("Command was cancelled.");
  }
}

export function createBashTool(options: BashToolOptions = {}): Tool {
  const runPreflight = options.preflight ?? preflightShellCommand;
  const shell = options.shell ?? Shell;
  const spawn = options.spawn ?? spawnProcess;
  const registry =
    options.registry ??
    new ShellJobRegistry({
      killTree: (child): Promise<void> | void => shell.killTree(child),
    });

  return {
    name: "bash",
    description:
      "Run a shell command in the execution workspace. Set run_in_background=true to return a job_id immediately. timeout is the maximum lifetime of the shell job for both foreground and background commands; the default is 120000ms and the maximum is 600000ms.",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        command: { type: "string" },
        timeout: {
          maximum: MAX_TIMEOUT_MS,
          minimum: 1,
          type: "integer",
        },
        run_in_background: { default: false, type: "boolean" },
      },
      required: ["command"],
      type: "object",
    },
    source: "builtin",
    category: "dangerous",
    timeoutOwner: "tool",
    async execute(params, context): Promise<ToolExecutionResult> {
      const command = getStringParam(params, "command");
      const timeout = getNumberParam(params, "timeout", {
        defaultValue: DEFAULT_TIMEOUT_MS,
        integer: true,
        max: MAX_TIMEOUT_MS,
        min: 1,
      });
      const runInBackground = params.run_in_background ?? false;
      if (typeof runInBackground !== "boolean") {
        throw new ToolParameterError(
          'Expected parameter "run_in_background" to be a boolean.',
        );
      }
      const parsed = parseCommand(command);
      if (parsed.hasError) {
        throw new ToolParameterError(
          "Unsupported shell syntax in bash command.",
        );
      }
      throwIfCancelled(context.signal);

      const commandContext = resolveCommandContext(context);
      const shellPath = shell.acceptable();
      const shellKind = detectShellKind(shellPath);
      const preflight = await runPreflight({
        command,
        cwd: commandContext.cwd,
        parsed,
        shellKind,
      });
      throwIfCancelled(context.signal);
      const args = shellArgs(shellPath, command);
      const commandPrefix = commandContext.commandPrefix ?? [];
      const spawnFile = commandPrefix[0] ?? shellPath;
      const spawnArgs =
        commandPrefix.length > 0
          ? [...commandPrefix.slice(1), shellPath, ...args]
          : args;
      const child = spawn(spawnFile, spawnArgs, {
        cwd: commandContext.cwd,
        detached: shouldDetach(),
        env: stateEnvironment({
          callId: context.callId,
          cwd: commandContext.cwd,
          env: commandContext.env,
          messageId: context.messageId,
          sessionId: context.sessionId,
          shellPath,
        }),
        windowsHide: true,
      });
      child.stdin?.end();

      const snapshot = registry.start({
        captureMode: runInBackground ? "tail" : "head",
        child,
        contextScopeId: context.contextScopeId,
        metadata: {
          cdTargets: preflight.cdTargets,
          cwd: commandContext.cwd,
          paths: parsed.details.flatMap((detail) => [...detail.paths]),
          pid: child.pid,
          resolvedPaths: preflight.resolvedPaths,
          roots: parsed.roots,
          shell: shellPath,
          shellKind,
        },
        sessionId: context.sessionId,
        timeoutMs: timeout,
      });
      if (runInBackground) {
        return { metadata: snapshot.metadata, output: snapshot.output };
      }

      const abortHandler = (): void => {
        void registry.kill(
          snapshot.jobId,
          context.sessionId,
          context.contextScopeId,
        );
      };
      context.signal.addEventListener("abort", abortHandler, { once: true });
      try {
        const result = await registry.waitForTerminal(
          snapshot.jobId,
          context.sessionId,
          context.contextScopeId,
        );
        return { metadata: result.metadata, output: result.output };
      } finally {
        context.signal.removeEventListener("abort", abortHandler);
      }
    },
  };
}
