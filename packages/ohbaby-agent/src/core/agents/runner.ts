import type { ChatCompletionCreateParams } from "openai/resources/chat/completions/completions";
import type { ToolDefinition } from "../tool-scheduler/index.js";
import { extractFinalOutput } from "./output.js";
import type {
  AgentRunDeps,
  AgentRunInput,
  AgentRunResult,
  AgentToolCallSummary,
} from "./types.js";

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
  if (
    signal &&
    typeof signal.reason === "string" &&
    signal.reason.length > 0
  ) {
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
  input: Pick<AgentRunInput, "agentName" | "initialUserPrompt" | "sessionId">,
): Promise<string | undefined> {
  if (!input.initialUserPrompt) {
    return undefined;
  }

  const message = await deps.messageManager.createMessage({
    agent: input.agentName,
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
  return input.completionError ?? (input.signal?.aborted ? abortReason(input.signal) : undefined);
}

function cleanupSessionEnvironment(
  deps: Pick<AgentRunDeps, "sandboxManager">,
  sessionId: string,
): () => void {
  let cleaned = false;
  return () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    deps.sandboxManager?.setSessionEnvironment(sessionId, undefined);
  };
}

export async function runAgent(
  deps: AgentRunDeps,
  input: AgentRunInput,
): Promise<AgentRunResult> {
  const runEventSource = deps.runEventSource;
  if (input.waitMode === "stream" && !runEventSource) {
    throw new Error("Agent run event source is required for stream mode");
  }

  const isSubagent = input.parentSessionId !== undefined;
  const tools = await deps.toolScheduler.getAvailableTools({
    agentName: input.agentName,
    isSubagent,
  });
  deps.sandboxManager?.setSessionEnvironment(
    input.sessionId,
    input.environment,
  );
  const cleanupEnvironment = cleanupSessionEnvironment(deps, input.sessionId);

  try {
    const userMessageId = await writeInitialUserMessage(deps, input);
    const messages = await input.buildPromptMessages({
      agentName: input.agentName,
      isSubagent,
      projectRoot: input.projectRoot,
      sessionId: input.sessionId,
    });
    const record = await deps.runCoordinator.create({
      agent: input.agentName,
      isSubagent,
      maxSteps: input.maxSteps,
      messages,
      parentMessageId: userMessageId ?? input.parentMessageId,
      sessionId: input.sessionId,
      tools: toOpenAiTools(tools),
      triggerSource: "user",
    });
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
        const events = runEventSource.subscribeRunEvents(record.runId);
        void deps.runCoordinator
          .waitForCompletion(record.runId)
          .finally(() => {
            unbindAbort();
            cleanupEnvironment();
          })
          .catch(() => undefined);
        return {
          events,
          mode: "stream",
          runId: record.runId,
          sessionId: record.sessionId,
        };
      } catch (error) {
        unbindAbort();
        cleanupEnvironment();
        throw error;
      }
    }

    try {
      const completion = await deps.runCoordinator.waitForCompletion(
        record.runId,
      );
      const finalOutput = extractFinalOutput(
        await deps.messageManager.listBySession(input.sessionId),
      );
      const success = completion.status === "succeeded";
      const output = finalOutput !== "" ? finalOutput : completion.error;
      const base = {
        mode: "waitForCompletion" as const,
        runId: record.runId,
        sessionId: input.sessionId,
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
        finalOutput: output,
        finishReason: "error" as const,
        success: false,
      };
    } finally {
      unbindAbort();
      cleanupEnvironment();
    }
  } catch (error) {
    cleanupEnvironment();
    throw error;
  }
}
