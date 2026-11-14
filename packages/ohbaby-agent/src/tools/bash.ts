import { isShellTrustedRootKind } from "../sandbox/trusted-roots.js";
import { mergeChildProxyEnvironment } from "../utils/network-proxy/child-environment.js";
import { prepareToolOutputDirectory } from "../services/session-storage.js";
import { withToolAdmission } from "../core/tool-scheduler/tool-admission.js";
import {
  DEFAULT_AUTO_BACKGROUND,
  DEFAULT_FOREGROUND_WAIT_MS,
  MAX_FOREGROUND_WAIT_MS,
} from "../config/tools/shell/index.js";
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
  ShellJobRegistry,
  type ShellJobRegistryOptions,
  type ShellJobSnapshot,
} from "./shell-job-registry.js";
import {
  getNumberParam,
  getStringParam,
  ToolParameterError,
} from "./utils/params.js";

const DEFAULT_FOREGROUND_TIMEOUT_MS = 120_000;
const MAX_FOREGROUND_TIMEOUT_MS = 600_000;
const MAX_BACKGROUND_TIMEOUT_MS = 86_400_000;

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
  readonly autoBackground?: boolean;
  readonly defaultForegroundWaitMs?: number;
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
  const autoBackgroundEnabled =
    options.autoBackground ?? DEFAULT_AUTO_BACKGROUND;
  const defaultWaitMs =
    options.defaultForegroundWaitMs ?? DEFAULT_FOREGROUND_WAIT_MS;
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
      sessionRoots: context.environment?.trustedRoots?.(),
      trustedRoots: context.environment
        ?.trustedRoots?.()
        .filter((root) => isShellTrustedRootKind(root.kind))
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

  function describe(canManageBackground: boolean): string {
    const commandDescription = `Run a shell command using ${interpreterDescription} in the execution workspace. Commands execute unchanged with no interpreter fallback after preparation. On Windows, select Git Bash only with a usable native full SHELL path. WSL launchers are unsupported.`;
    const foregroundTimeout = `For pure foreground execution, timeout defaults to ${String(DEFAULT_FOREGROUND_TIMEOUT_MS)}ms and has a maximum of ${String(MAX_FOREGROUND_TIMEOUT_MS)}ms.`;
    if (!canManageBackground)
      return `${commandDescription} This role can only run foreground commands. Background task management is unavailable. Omit run_in_background, auto_background and wait_ms. ${foregroundTimeout}`;
    const backgroundDescription = `Set run_in_background=true to start a background job immediately. Completion is reported automatically. Do not poll or sleep for completion. Use task with action=list to find your jobs, action=output to read or wait for a result, and action=stop to stop one. Background jobs end when their managing service stops.`;
    const automaticDescription = autoBackgroundEnabled
      ? `By default, a foreground command still running after ${String(defaultWaitMs)}ms moves to the background and returns its job_id. Use wait_ms to set this wait for one call, or set auto_background=false for pure foreground execution. Omit both options when starting an explicit background job.`
      : "Automatic backgrounding is disabled. Omit wait_ms and leave auto_background unset or false.";
    return `${commandDescription} ${backgroundDescription} ${automaticDescription} timeout is the process lifetime in milliseconds and its deadline stays fixed if the command moves to the background. Jobs allowed to run in the background have no default timeout and accept up to ${String(MAX_BACKGROUND_TIMEOUT_MS)}ms. ${foregroundTimeout}`;
  }

  return withToolAdmission(
    {
      name: "bash",
      description: describe(true),
      parametersJsonSchema: {
        additionalProperties: false,
        properties: {
          auto_background: { type: "boolean" },
          command: { type: "string" },
          description: { type: "string" },
          timeout: {
            maximum: MAX_BACKGROUND_TIMEOUT_MS,
            minimum: 1,
            type: "integer",
          },
          run_in_background: { default: false, type: "boolean" },
          wait_ms: {
            maximum: MAX_FOREGROUND_WAIT_MS,
            minimum: 1,
            type: "integer",
          },
        },
        required: ["command"],
        type: "object",
      },
      source: "builtin",
      category: "dangerous",
      timeoutOwner: "tool",
      async execute(params, context): Promise<ToolExecutionResult> {
        const command = getStringParam(params, "command");
        const { run_in_background: runInBackground = false } = params;
        if (typeof runInBackground !== "boolean") {
          throw new ToolParameterError(
            'Expected parameter "run_in_background" to be a boolean.',
          );
        }
        const requestedAuto = params.auto_background;
        if (requestedAuto !== undefined && typeof requestedAuto !== "boolean")
          throw new ToolParameterError(
            'Expected parameter "auto_background" to be a boolean.',
          );
        const hasWait = params.wait_ms !== undefined;
        if (runInBackground && (requestedAuto !== undefined || hasWait))
          throw new ToolParameterError(
            'Parameters "auto_background" and "wait_ms" cannot be used with "run_in_background=true".',
          );
        const canManageBackground =
          context.canManageBackgroundShellJobs ?? true;
        if (
          !canManageBackground &&
          (runInBackground || requestedAuto === true || hasWait)
        )
          throw new ToolParameterError(
            "This role lacks background task management. Run Bash in the foreground.",
          );
        if (!autoBackgroundEnabled && (requestedAuto === true || hasWait))
          throw new ToolParameterError(
            'Automatic backgrounding is disabled in shell configuration. Omit "wait_ms" and leave "auto_background" unset or false.',
          );
        const canAutoBackground =
          !runInBackground &&
          canManageBackground &&
          autoBackgroundEnabled &&
          requestedAuto !== false;
        if (hasWait && !canAutoBackground)
          throw new ToolParameterError(
            'Parameter "wait_ms" requires automatic backgrounding.',
          );
        if (params.wait_ms === null)
          throw new ToolParameterError(
            'Expected parameter "wait_ms" to be an integer.',
          );
        if (params.timeout === null)
          throw new ToolParameterError(
            'Expected parameter "timeout" to be an integer.',
          );
        const waitMs = canAutoBackground
          ? getNumberParam(params, "wait_ms", {
              defaultValue: defaultWaitMs,
              integer: true,
              max: MAX_FOREGROUND_WAIT_MS,
              min: 1,
            })
          : undefined;
        const canRunInBackground = runInBackground || canAutoBackground;
        const timeout =
          canRunInBackground && params.timeout === undefined
            ? null
            : getNumberParam(params, "timeout", {
                defaultValue: DEFAULT_FOREGROUND_TIMEOUT_MS,
                integer: true,
                max: canRunInBackground
                  ? MAX_BACKGROUND_TIMEOUT_MS
                  : MAX_FOREGROUND_TIMEOUT_MS,
                min: 1,
              });
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
        const outputDirectory = await prepareToolOutputDirectory(
          context.environment,
        );
        const release = context.environment?.retain?.();
        let snapshot: ShellJobSnapshot;
        const releaseOwnership = { registry: false };
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
          snapshot = await registry.start({
            outputDirectory,
            background: runInBackground,
            signal: context.signal,
            onReserved: () => {
              releaseOwnership.registry = true;
              if (runInBackground) context.detachCleanupOwnership?.();
            },
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
              command,
              description:
                typeof params.description === "string"
                  ? params.description
                  : undefined,
              cwd: binding.cwd,
              shell: shellPath,
              shellKind,
            },
            sessionId: context.sessionId,
            timeoutMs: timeout,
          });
        } catch (error) {
          if (!releaseOwnership.registry) await release?.();
          throw error;
        }
        if (runInBackground) {
          return { metadata: snapshot.metadata, output: snapshot.output };
        }

        const { snapshot: result, promotion } =
          await registry.waitForForeground(
            snapshot.jobId,
            context.sessionId,
            {
              waitMs,
              signal: context.signal,
              onBackground: () => context.detachCleanupOwnership?.(),
            },
            context.contextScopeId,
          );
        const { outputBytes } = result.metadata;
        const outputSuffix =
          typeof outputBytes === "number" && outputBytes > 0
            ? `\n\n${result.output}`
            : "";
        if (promotion === "converted") {
          const summary = command.trim().replace(/\s+/gu, " ");
          const preview =
            summary.length > 120 ? `${summary.slice(0, 120)}…` : summary;
          const deadline = result.metadata.deadline;
          const timeLimit =
            typeof deadline === "number"
              ? ` Hard deadline ${new Date(deadline).toISOString()}.`
              : " No hard deadline.";
          const receipt = `Shell job ${result.jobId} moved to the background automatically. Command ${JSON.stringify(preview)}. Status ${result.status}.${timeLimit} Completion is reported separately.`;
          return {
            metadata: result.metadata,
            output: `${receipt}${outputSuffix}`,
          };
        }
        const { cleanup, error } = result.metadata;
        const stopMessage =
          promotion === "capacity_rejected"
            ? "Cancellation requested because the background job limit was reached."
            : promotion === "persistence_error"
              ? `Cancellation requested because the move to the background could not be saved.${typeof error === "string" ? ` ${error}` : ""}`
              : undefined;
        return {
          metadata: result.metadata,
          output: stopMessage
            ? `${stopMessage} Process cleanup ${typeof cleanup === "string" ? cleanup : "unconfirmed"}.${outputSuffix}`
            : result.output,
          executionOutcome:
            result.status === "timed_out"
              ? "timed-out"
              : result.status === "cancelled"
                ? "cancelled"
                : result.status === "failed"
                  ? "error"
                  : "success",
        };
      },
    },
    {
      cleanupOwner: "tool",
      bashBackground: { registry, describe },
      prepareShell,
    },
  );
}
