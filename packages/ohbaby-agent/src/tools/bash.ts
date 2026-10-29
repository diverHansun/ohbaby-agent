import { mergeChildProxyEnvironment } from "../utils/network-proxy/child-environment.js";
import { withToolAdmission } from "../core/tool-scheduler/tool-admission.js";
import type {
  ChildProcess,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import type {
  Tool,
  ToolExecutionResult,
  ToolExecutionContext,
} from "../core/tool-scheduler/index.js";
import {
  detectShellKind,
  preflightShellCommand,
  shellArgs,
  Shell,
} from "../shell/index.js";
import { analyzeShellCommand } from "../shell/analysis/index.js";
import type { BashPreparation } from "../shell/execution.js";
import { preflightSandboxShellAnalysis } from "../sandbox/preflight.js";
import { resolveCommandContext } from "./utils/context.js";
import {
  DEFAULT_SHELL_JOB_TIMEOUT_MS,
  MAX_SHELL_JOB_TIMEOUT_MS,
  ShellJobRegistry,
  type ShellJobRegistryOptions,
  type ShellJobSnapshot,
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
  killTree(
    process: ChildProcess,
  ): ReturnType<ShellJobRegistryOptions["killTree"]>;
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
    ...mergeChildProxyEnvironment(
      {
        ...process.env,
        GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT ?? "0",
        NO_COLOR: "1",
        SHELL: input.shellPath,
        TERM: "dumb",
      },
      input.env,
    ),
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
      terminationManagesObservation: shell === Shell,
      killTree: (child): ReturnType<ShellJobRegistryOptions["killTree"]> =>
        shell.killTree(child),
    });

  function commandContextFor(
    context: ToolExecutionContext,
  ): ReturnType<typeof resolveCommandContext> {
    if (!context.environment && !("resolveCommandContext" in context))
      return { cwd: process.cwd(), kind: "host-local" };
    return resolveCommandContext(context);
  }
  async function prepareShell(
    params: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<BashPreparation> {
    throwIfCancelled(context.signal);
    const command = getStringParam(params, "command");
    const commandContext = commandContextFor(context);
    const shellPath = shell.acceptable();
    const shellAnalysis = await analyzeShellCommand(
      command,
      detectShellKind(shellPath),
    );
    const shellPreflight = await runPreflight({
      command,
      cwd: commandContext.cwd,
      shellAnalysis,
    });
    const sandboxPreflight = await preflightSandboxShellAnalysis({
      shellAnalysis,
      workdir: commandContext.cwd,
      trustedRoots: context.environment
        ?.trustedRoots?.()
        .map((root) => root.path),
    });
    throwIfCancelled(context.signal);
    return {
      shellAnalysis,
      shellPreflight,
      sandboxPreflight,
      shellExecution: {
        command,
        shell: shellPath,
        args: shellArgs(shellPath, command),
        cwd: commandContext.cwd,
        commandPrefix: [...(commandContext.commandPrefix ?? [])],
        metadata: {
          cdTargets: shellPreflight.cdTargets,
          resolvedPaths: shellPreflight.resolvedPaths,
          paths: shellAnalysis.commands.flatMap((item) => item.pathArgs),
          roots: shellAnalysis.commands.map((item) => item.root),
        },
      },
    };
  }
  let interpreterDescription: string;
  try {
    interpreterDescription = `${shell.acceptable()} (${process.platform})`;
  } catch (error) {
    interpreterDescription = `unavailable (${error instanceof Error ? error.message : String(error)})`;
  }

  return withToolAdmission(
    {
      name: "bash",
      description: `Run a shell command using ${interpreterDescription} in the execution workspace. Commands execute unchanged; no interpreter fallback occurs after preparation. On Windows, select Git Bash only with a usable native full SHELL path; WSL launchers are unsupported. Set run_in_background=true to return a job_id immediately. timeout is the maximum lifetime of the shell job for both foreground and background commands; the default is 120000ms and the maximum is 600000ms.`,
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
        throwIfCancelled(context.signal);

        if (
          !context.owner &&
          (context.runId !== undefined || context.contextScopeId !== undefined)
        ) {
          throw new Error(
            "Bash requires a trusted execution owner for interactive or scoped execution.",
          );
        }
        const prepared = context.shellExecution
          ? { shellExecution: context.shellExecution }
          : await prepareShell(params, context);
        const binding = prepared.shellExecution;
        if (binding.command !== command)
          throw new Error(
            "Bash command differs from its prepared original command.",
          );
        const commandContext = commandContextFor(context);
        const shellPath = binding.shell;
        const shellKind = detectShellKind(shellPath);
        const args = binding.args;
        const commandPrefix = binding.commandPrefix;
        const spawnFile = commandPrefix[0] ?? shellPath;
        const spawnArgs =
          commandPrefix.length > 0
            ? [...commandPrefix.slice(1), shellPath, ...args]
            : args;
        const release = context.environment?.retain?.();
        let snapshot: ShellJobSnapshot;
        try {
          throwIfCancelled(context.signal);
          const env = stateEnvironment({
            callId: context.callId,
            cwd: binding.cwd,
            env: commandContext.env,
            messageId: context.messageId,
            sessionId: context.sessionId,
            shellPath,
          });
          snapshot = registry.start({
            background: runInBackground,
            owner: context.owner ?? {
              sessionId: context.sessionId,
              rootSessionId: context.sessionId,
              workspaceKey: binding.cwd,
              scopeKey: context.environment?.scopeKey,
              runId: context.runId,
              messageId: context.messageId,
              callId: context.callId,
              contextScopeId: context.contextScopeId,
            },
            release,
            reportCleanup: context.reportCleanup,
            reportCleanupError: context.reportCleanupError,
            captureMode: runInBackground ? "tail" : "head",
            child: (): ChildProcess => {
              throwIfCancelled(context.signal);
              return spawn(spawnFile, spawnArgs, {
                cwd: binding.cwd,
                detached: shouldDetach(),
                env,
                windowsHide: true,
              });
            },
            contextScopeId: context.contextScopeId,
            metadata: {
              ...binding.metadata,
              cwd: binding.cwd,
              shell: shellPath,
              shellKind,
            },
            sessionId: context.sessionId,
            timeoutMs: timeout,
          });
        } catch (error) {
          await release?.();
          throw error;
        }
        // Cancellation may have happened synchronously during registration/spawn.
        if (context.signal.aborted) {
          await registry.kill(
            snapshot.jobId,
            context.sessionId,
            context.contextScopeId,
          );
        }
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
          return {
            metadata: result.metadata,
            output: result.output,
            executionOutcome:
              result.status === "timed_out"
                ? "timed-out"
                : result.status === "cancelled"
                  ? "cancelled"
                  : result.status === "failed"
                    ? "error"
                    : "success",
          };
        } finally {
          context.signal.removeEventListener("abort", abortHandler);
        }
      },
    },
    { cleanupOwner: "tool", prepareShell },
  );
}
