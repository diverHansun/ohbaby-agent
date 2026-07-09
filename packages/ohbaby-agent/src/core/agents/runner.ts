import type { ChatCompletionCreateParams } from "openai/resources/chat/completions/completions";
import type { LifecycleEvent } from "../lifecycle/index.js";
import type { ToolDefinition } from "../tool-scheduler/index.js";
import { extractFinalOutput } from "./output.js";
import type {
  AgentRunDeps,
  AgentRunEventSource,
  AgentRunInput,
  AgentRunResult,
  AgentToolCallSummary,
} from "./types.js";

interface ResolvedRunScope {
  readonly agentInstanceId?: string;
  readonly contextScopeId?: string;
  readonly isSubagent: boolean;
  readonly parentSessionId?: string;
  readonly sessionId: string;
}

export function toOpenAiTools(
  definitions: readonly ToolDefinition[],
): ChatCompletionCreateParams["tools"] {
  return definitions.map((definition) => ({
    type: "function",
    function: {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    },
  }));
}

function abortReason(signal: AbortSignal | undefined): string {
  if (signal && typeof signal.reason === "string" && signal.reason.length > 0) {
    return signal.reason;
  }
  return "agent run aborted";
}

function bindAgentAbort(input: {
  readonly cancel: (runId: string, reason?: string) => void;
  readonly runId: string;
  readonly signal?: AbortSignal;
}): () => void {
  const signal = input.signal;
  if (!signal) {
    return () => undefined;
  }
  const abort = (): void => {
    try {
      input.cancel(input.runId, abortReason(signal));
    } catch {
      // The run may already be terminal.
    }
  };
  if (signal.aborted) {
    abort();
    return () => undefined;
  }
  signal.addEventListener("abort", abort, { once: true });
  return () => {
    signal.removeEventListener("abort", abort);
  };
}

async function writeInitialUserMessage(
  deps: Pick<AgentRunDeps, "messageManager">,
  input: Pick<
    AgentRunInput,
    "agentName" | "contextScopeId" | "initialUserPrompt" | "sessionId"
  >,
): Promise<string | undefined> {
  if (!input.initialUserPrompt) {
    return undefined;
  }

  const message = await deps.messageManager.createMessage({
    agent: input.agentName,
    ...(input.contextScopeId === undefined
      ? {}
      : { contextScopeId: input.contextScopeId }),
    role: "user",
    sessionId: input.sessionId,
  });
  await deps.messageManager.appendPart(message.id, {
    text: input.initialUserPrompt,
    type: "text",
  });
  return message.id;
}

function completionError(input: {
  readonly completionError?: string;
  readonly signal?: AbortSignal;
}): string | undefined {
  return (
    input.completionError ??
    (input.signal?.aborted ? abortReason(input.signal) : undefined)
  );
}

function preSubscribeRunEvents(input: {
  readonly runEventSource: AgentRunEventSource;
  readonly runId: string;
}): {
  readonly events: AsyncIterable<LifecycleEvent>;
  close(): Promise<void>;
} {
  const iterator = input.runEventSource
    .subscribeRunEvents(input.runId)
    [Symbol.asyncIterator]();
  return {
    events: {
      [Symbol.asyncIterator](): AsyncIterator<LifecycleEvent> {
        return iterator;
      },
    },
    async close(): Promise<void> {
      await iterator.return?.();
    },
  };
}

function resolveRunScope(input: AgentRunInput): ResolvedRunScope {
  const scope = input.contextScope;
  if (scope === undefined) {
    return {
      agentInstanceId: input.agentInstanceId,
      contextScopeId: input.contextScopeId,
      isSubagent: input.isSubagent ?? input.parentSessionId !== undefined,
      parentSessionId: input.parentSessionId,
      sessionId: input.sessionId,
    };
  }
  scope.assertSession({
    agentName: input.agentName,
    contextScopeId: input.contextScopeId,
    instanceId: input.agentInstanceId,
    parentSessionId: input.parentSessionId,
    sessionId: input.sessionId,
  });
  return scope.toRunCreateOptions();
}

export async function runAgent(
  deps: AgentRunDeps,
  input: AgentRunInput,
): Promise<AgentRunResult> {
  const runEventSource = deps.runEventSource;
  if (input.waitMode === "stream" && !runEventSource) {
    throw new Error("Agent run event source is required for stream mode");
  }

  const scope = resolveRunScope(input);
  const tools = await deps.toolScheduler.getAvailableTools({
    agentName: input.agentName,
    isSubagent: scope.isSubagent,
  });

  const userMessageId = await writeInitialUserMessage(deps, {
    agentName: input.agentName,
    contextScopeId: scope.contextScopeId,
    initialUserPrompt: input.initialUserPrompt,
    sessionId: scope.sessionId,
  });
  const preSubscribed =
    input.waitMode === "stream" && input.runId && runEventSource
      ? preSubscribeRunEvents({ runEventSource, runId: input.runId })
      : undefined;
  let record: Awaited<ReturnType<AgentRunDeps["runCoordinator"]["create"]>>;
  try {
    record = await deps.runCoordinator.create({
      ...(scope.agentInstanceId === undefined
        ? {}
        : { agentInstanceId: scope.agentInstanceId }),
      agent: input.agentName,
      ...(scope.contextScopeId === undefined
        ? {}
        : { contextScopeId: scope.contextScopeId }),
      directory: input.environment?.workdir ?? input.projectRoot,
      isSubagent: scope.isSubagent,
      maxSteps: input.maxSteps,
      modelId: input.modelId,
      parentMessageId: userMessageId ?? input.parentMessageId,
      runId: input.runId,
      sessionId: scope.sessionId,
      tools: toOpenAiTools(tools),
      triggerSource: "user",
    });
  } catch (error) {
    await preSubscribed?.close();
    if (userMessageId) {
      try {
        await deps.messageManager.removeMessage(userMessageId);
      } catch {
        // Preserve the run creation error so callers can still classify busy sessions.
      }
    }
    throw error;
  }
  const unbindAbort = bindAgentAbort({
    cancel: deps.runCoordinator.cancel.bind(deps.runCoordinator),
    runId: record.runId,
    signal: input.signal,
  });
  if (input.waitMode === "stream") {
    try {
      if (!runEventSource) {
        throw new Error("Agent run event source is required for stream mode");
      }
      if (input.runId && record.runId !== input.runId) {
        throw new Error(
          `Agent run coordinator created unexpected run id: ${record.runId}`,
        );
      }
      const events =
        preSubscribed?.events ?? runEventSource.subscribeRunEvents(record.runId);
      void deps.runCoordinator
        .waitForCompletion(record.runId)
        .finally(() => {
          unbindAbort();
        })
        .catch(() => undefined);
      return {
        events,
        mode: "stream",
        runId: record.runId,
        sessionId: record.sessionId,
      };
    } catch (error) {
      await preSubscribed?.close();
      unbindAbort();
      throw error;
    }
  }

  try {
    const completion = await deps.runCoordinator.waitForCompletion(record.runId);
    const history =
      scope.contextScopeId === undefined
        ? await deps.messageManager.listBySession(scope.sessionId)
        : await deps.messageManager.listBySession(scope.sessionId, {
            contextScopeId: scope.contextScopeId,
          });
    const finalOutput = extractFinalOutput(history);
    const success = completion.status === "succeeded";
    const output = finalOutput !== "" ? finalOutput : completion.error;
    const base = {
      mode: "waitForCompletion" as const,
      runId: record.runId,
      sessionId: scope.sessionId,
      steps: 0,
      toolCalls: [] satisfies readonly AgentToolCallSummary[],
    };
    if (success) {
      return {
        ...base,
        finalOutput: output ?? "",
        finishReason: "stop" as const,
        success: true,
      };
    }
    return {
      ...base,
      error:
        completionError({
          completionError: completion.error,
          signal: input.signal,
        }) ?? "agent run failed",
      finishReason: "error" as const,
      success: false,
    };
  } finally {
    unbindAbort();
  }
}
