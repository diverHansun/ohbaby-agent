import type {
  LifecycleEvent,
  LifecycleResult,
  LifecycleSessionParams,
} from "../../core/lifecycle/index.js";
import { SnapshotHookExecutionError } from "../../snapshot/types.js";
import type {
  ToolCallResult,
  ToolExecutionEnvironment,
} from "../../core/tool-scheduler/index.js";
import type {
  RunContext,
  RunHookContext,
  RunRecord,
  SandboxLease,
  RunStatus,
  RunWorkerDeps,
  RunWorkerResult,
  RunWorkerStartOptions,
} from "./types.js";

function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function abortReason(signal: AbortSignal): string {
  if (typeof signal.reason === "string" && signal.reason.length > 0) {
    return signal.reason;
  }
  return "run cancelled";
}

function withDefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}

function safeJsonValue(value: unknown): unknown {
  if (value instanceof Error) {
    return withDefined({
      message: value.message,
      name: value.name,
    });
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return String(value);
  }

  try {
    const encoded = JSON.stringify(value);
    return JSON.parse(encoded) as unknown;
  } catch {
    return String(value);
  }
}

function safeJsonRecord(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const safe = safeJsonValue(value);
  return typeof safe === "object" && safe !== null && !Array.isArray(safe)
    ? (safe as Record<string, unknown>)
    : { value: safe };
}

function serializableToolResult(
  result: ToolCallResult,
): Record<string, unknown> {
  return withDefined({
    callId: result.callId,
    duration: result.duration,
    error: result.error
      ? withDefined({
          details:
            result.error.details === undefined
              ? undefined
              : safeJsonValue(result.error.details),
          message: result.error.message,
          type: result.error.type,
        })
      : undefined,
    metadata: safeJsonRecord(result.metadata),
    output: result.output,
    status: result.status,
  });
}

function toToolExecutionEnvironment(
  lease: SandboxLease,
): ToolExecutionEnvironment | undefined {
  if (
    !lease.workdir ||
    typeof lease.resolvePath !== "function" ||
    typeof lease.resolvePathForExisting !== "function" ||
    typeof lease.resolvePathForWrite !== "function" ||
    typeof lease.resolveCommandContext !== "function"
  ) {
    return undefined;
  }

  return {
    workdir: lease.workdir,
    containsTrustedPath: lease.containsTrustedPath.bind(lease),
    resolveCommandContext: lease.resolveCommandContext.bind(lease),
    preflight: lease.preflight.bind(lease),
    resolvePath: lease.resolvePath.bind(lease),
    resolvePathForExisting: lease.resolvePathForExisting.bind(lease),
    resolvePathForWrite: lease.resolvePathForWrite.bind(lease),
    trustPath: lease.trustPath.bind(lease),
    trustedRoots: lease.trustedRoots.bind(lease),
  };
}

function hookContext(
  run: RunRecord,
  context: RunContext,
  patch: Partial<RunHookContext> = {},
): RunHookContext {
  return {
    run,
    runId: context.runId,
    sessionId: context.sessionId,
    triggerSource: context.triggerSource,
    permissionProfileId: context.permissionProfileId,
    sandboxLease: context.sandboxLease,
    ...patch,
  };
}

export class RunWorker {
  constructor(
    private readonly context: RunContext,
    private readonly deps: RunWorkerDeps,
  ) {}

  async start(options: RunWorkerStartOptions): Promise<RunWorkerResult> {
    await this.executeHook(
      "pre-run",
      hookContext(options.run, this.context, { status: "pending" }),
    );
    await options.onRunning();

    try {
      const result = await this.consumeLifecycle();
      const status = this.context.abortSignal.aborted
        ? "cancelled"
        : result.success
          ? "succeeded"
          : "failed";
      const error =
        status === "failed"
          ? result.finalResponse || "Lifecycle did not complete successfully"
          : status === "cancelled"
            ? abortReason(this.context.abortSignal)
            : undefined;
      const terminalReason = result.terminalReason;

      await this.executeHook(
        "post-run",
        hookContext(options.run, this.context, {
          status,
          result,
          error,
        }),
      );

      if (error) {
        return {
          status,
          result,
          error,
          ...(terminalReason === undefined ? {} : { terminalReason }),
        };
      }

      return {
        status,
        result,
        ...(terminalReason === undefined ? {} : { terminalReason }),
      };
    } catch (error) {
      const status: RunStatus = this.context.abortSignal.aborted
        ? "cancelled"
        : "failed";
      const message =
        status === "cancelled"
          ? abortReason(this.context.abortSignal)
          : errorToMessage(error);

      await this.executeHook(
        "post-run",
        hookContext(options.run, this.context, {
          status,
          error,
        }),
      );

      return { status, error: message };
    }
  }

  private async consumeLifecycle(): Promise<LifecycleResult> {
    const loop = this.createLifecycleLoop();
    let next = await loop.next();

    while (!next.done) {
      this.publishLifecycleEvent(next.value);
      next = await loop.next();
    }

    return next.value;
  }

  private createLifecycleLoop(): AsyncGenerator<
    LifecycleEvent,
    LifecycleResult,
    void
  > {
    return this.deps.lifecycle.run(this.lifecycleSessionParams());
  }

  private lifecycleSessionParams(): LifecycleSessionParams {
    const environment = toToolExecutionEnvironment(this.context.sandboxLease);
    if (!this.context.directory || !this.context.modelId) {
      throw new Error("Session run requires directory and model id");
    }

    return {
      directory: this.context.directory,
      modelId: this.context.modelId,
      sessionId: this.context.sessionId,
      signal: this.context.abortSignal,
      ...(this.context.agent === undefined
        ? {}
        : { agent: this.context.agent }),
      ...(this.context.isSubagent === undefined
        ? {}
        : { isSubagent: this.context.isSubagent }),
      ...(this.context.parentMessageId === undefined
        ? {}
        : { parentMessageId: this.context.parentMessageId }),
      ...(this.context.maxSteps === undefined
        ? {}
        : { maxSteps: this.context.maxSteps }),
      ...(environment === undefined ? {} : { environment }),
      ...(this.context.tools === undefined
        ? {}
        : { tools: this.context.tools }),
    };
  }

  private publishLifecycleEvent(event: LifecycleEvent): void {
    const scope = `run/${this.context.runId}` as const;

    if (event.type === "llm:delta") {
      this.publish(scope, "message.part.delta", {
        runId: this.context.runId,
        sessionId: this.context.sessionId,
        timestamp: event.timestamp,
        delta: event.delta,
        content: event.content,
      });
      return;
    }

    if (event.type === "llm:start") {
      this.publish(
        scope,
        "run.llm.start",
        withDefined({
          runId: this.context.runId,
          sessionId: this.context.sessionId,
          timestamp: event.timestamp,
          step: event.step,
        }),
      );
      return;
    }

    if (event.type === "turn:start") {
      this.publish(
        scope,
        "run.turn.start",
        withDefined({
          runId: this.context.runId,
          sessionId: this.context.sessionId,
          timestamp: event.timestamp,
          step: event.step,
          usage: safeJsonValue(event.usage),
          compaction:
            event.compaction === undefined
              ? undefined
              : safeJsonValue(event.compaction),
          hasSummary: event.hasSummary,
        }),
      );
      return;
    }

    if (event.type === "context:prepared") {
      this.publish(
        scope,
        "run.context.prepared",
        withDefined({
          runId: this.context.runId,
          sessionId: this.context.sessionId,
          timestamp: event.timestamp,
          step: event.step,
          usage: safeJsonValue(event.usage),
          compaction:
            event.compaction === undefined
              ? undefined
              : safeJsonValue(event.compaction),
          hasSummary: event.hasSummary,
        }),
      );
      return;
    }

    if (event.type === "turn:end") {
      this.publish(
        scope,
        "run.turn.end",
        withDefined({
          runId: this.context.runId,
          sessionId: this.context.sessionId,
          timestamp: event.timestamp,
          step: event.step,
          usage: safeJsonValue(event.usage),
          finishReason: event.finishReason,
          toolResults:
            event.toolResults === undefined
              ? undefined
              : safeJsonValue(event.toolResults),
        }),
      );
      return;
    }

    if (event.type === "llm:complete") {
      this.publish(
        scope,
        "run.llm.complete",
        withDefined({
          runId: this.context.runId,
          sessionId: this.context.sessionId,
          timestamp: event.timestamp,
          finishReason: event.finishReason,
        }),
      );
      return;
    }

    if (event.type === "llm:retrying") {
      this.publish(scope, "run.llm.retrying", {
        runId: this.context.runId,
        sessionId: this.context.sessionId,
        timestamp: event.timestamp,
        step: event.step,
        attempt: event.attempt,
        maxRetries: event.maxRetries,
        delayMs: event.delayMs,
        reason: event.reason,
      });
      return;
    }

    if (event.type === "tool:start") {
      this.publish(scope, "run.tool.start", {
        runId: this.context.runId,
        sessionId: this.context.sessionId,
        timestamp: event.timestamp,
        step: event.step,
        callId: event.callId,
        toolName: event.toolName,
        status: "executing",
        params: event.params,
      });
      return;
    }

    if (event.type === "tool:result") {
      this.publish(scope, "run.tool.result", {
        runId: this.context.runId,
        sessionId: this.context.sessionId,
        timestamp: event.timestamp,
        step: event.step,
        callId: event.callId,
        toolName: event.toolName,
        status: event.result.status,
        params: event.params,
        result: serializableToolResult(event.result),
      });
      return;
    }

    // Only "step:complete" remains after the early returns above.
    this.publish(
      scope,
      "run.step.complete",
      withDefined({
        runId: this.context.runId,
        sessionId: this.context.sessionId,
        timestamp: event.timestamp,
        step: event.step,
        finishReason: event.finishReason,
        toolResults:
          event.toolResults === undefined
            ? undefined
            : safeJsonValue(event.toolResults),
      }),
    );
  }

  private publish(
    scope: `run/${string}`,
    event: string,
    data: Record<string, unknown>,
  ): void {
    try {
      this.deps.streamBridge.publish(scope, event, data);
    } catch {
      // Stream observers must not break lifecycle execution.
    }
  }

  private async executeHook(
    point: "pre-run" | "post-run",
    context: RunHookContext,
  ): Promise<void> {
    try {
      await this.deps.hookExecutor?.execute(point, context);
    } catch (error) {
      if (error instanceof SnapshotHookExecutionError) {
        this.publish(`run/${context.runId}`, "snapshot.hook.failed", {
          point: error.point,
          error:
            error.cause instanceof Error
              ? error.cause.message
              : String(error.cause),
        });
      }
      // Hooks are observers in MVP; a hook failure must not stop the run.
    }
  }
}
