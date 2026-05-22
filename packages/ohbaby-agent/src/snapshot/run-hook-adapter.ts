import type {
  HookExecutor,
  RunHookContext,
} from "../runtime/run-manager/index.js";
import {
  createSnapshotRunWorkerHook,
  type SnapshotService,
} from "./service.js";
import type {
  MessageCursor,
  SnapshotRunWorkerHookContext,
  SnapshotRunWorkerHookState,
  WorkspaceSource,
} from "./types.js";

export interface SnapshotHookExecutorOptions {
  readonly service: SnapshotService;
  readonly createTurnId?: (context: SnapshotRunWorkerHookContext) => string;
  readonly getMessageCursor?: (
    context: RunHookContext,
  ) => MessageCursor | undefined | Promise<MessageCursor | undefined>;
  readonly resolveWorkdir?: (
    context: RunHookContext,
  ) => string | undefined | Promise<string | undefined>;
  readonly workspaceSource?: WorkspaceSource;
}

function runContextToSnapshotContext(input: {
  readonly cursor?: MessageCursor;
  readonly hookContext: RunHookContext;
  readonly options: SnapshotHookExecutorOptions;
  readonly workdir?: string;
}): SnapshotRunWorkerHookContext {
  return {
    sessionId: input.hookContext.sessionId,
    runId: input.hookContext.runId,
    workdir: input.workdir,
    workspaceSource: input.options.workspaceSource,
    messageCursor: input.cursor,
  };
}

export function createSnapshotHookExecutor(
  options: SnapshotHookExecutorOptions,
): HookExecutor {
  const hook = createSnapshotRunWorkerHook({
    createTurnId: options.createTurnId,
    resolveWorkdir(context) {
      return context.workdir;
    },
    service: options.service,
  });
  const states = new Map<string, SnapshotRunWorkerHookState>();

  async function workdirFor(
    context: RunHookContext,
  ): Promise<string | undefined> {
    return options.resolveWorkdir?.(context) ?? context.sandboxLease?.workdir;
  }

  async function cursorFor(
    context: RunHookContext,
  ): Promise<MessageCursor | undefined> {
    return options.getMessageCursor?.(context);
  }

  return {
    async execute(point, context): Promise<void> {
      if (point === "pre-run") {
        const checkpoint = await hook.track(
          runContextToSnapshotContext({
            cursor: await cursorFor(context),
            hookContext: context,
            options,
            workdir: await workdirFor(context),
          }),
        );
        if (checkpoint) {
          states.set(context.runId, {
            checkpointId: checkpoint.checkpointId,
          });
        }
        return;
      }

      const state = states.get(context.runId);
      if (!state) {
        return;
      }
      try {
        await hook.capture(
          runContextToSnapshotContext({
            cursor: await cursorFor(context),
            hookContext: context,
            options,
            workdir: await workdirFor(context),
          }),
          state,
        );
      } finally {
        states.delete(context.runId);
      }
    },
  };
}
