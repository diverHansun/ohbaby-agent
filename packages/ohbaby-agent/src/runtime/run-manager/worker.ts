import type {
  LifecycleEvent,
  LifecycleResult,
  LifecycleRunParams,
} from "../../core/lifecycle/index.js";
import type {
  RunContext,
  RunHookContext,
  RunRecord,
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
    permissionProfile: context.permissionProfile,
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
          ? "Lifecycle did not complete successfully"
          : status === "cancelled"
            ? abortReason(this.context.abortSignal)
            : undefined;

      await this.executeHook(
        "post-run",
        hookContext(options.run, this.context, {
          status,
          result,
          error,
        }),
      );

      if (error) {
        return { status, result, error };
      }

      return { status, result };
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
    const loop = this.deps.lifecycle.run(this.lifecycleParams());
    let next = await loop.next();

    while (!next.done) {
      this.publishLifecycleEvent(next.value);
      next = await loop.next();
    }

    return next.value;
  }

  private lifecycleParams(): LifecycleRunParams {
    return withDefined({
      sessionId: this.context.sessionId,
      agent: this.context.agent,
      parentMessageId: this.context.parentMessageId,
      messages: this.context.messages,
      signal: this.context.abortSignal,
      tools: this.context.tools,
    }) as unknown as LifecycleRunParams;
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
    }
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
    } catch {
      // Hooks are observers in MVP; a hook failure must not stop the run.
    }
  }
}
