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
  if (
    typeof deps.messageManager.createMessage !== "function" ||
    typeof deps.messageManager.appendPart !== "function"
  ) {
    throw new Error("initialUserPrompt requires a writable MessageManager");
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

export async function runAgent(
  deps: AgentRunDeps,
  input: AgentRunInput,
): Promise<AgentRunResult> {
  if (input.waitMode === "stream") {
    throw new Error("stream mode not implemented until agents improve-2");
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
    try {
      const completion = await deps.runCoordinator.waitForCompletion(
        record.runId,
      );
      const finalOutput = extractFinalOutput(
        await deps.messageManager.listBySession(input.sessionId),
      );
      const success = completion.status === "succeeded";
      return {
        error: success
          ? undefined
          : completionError({
              completionError: completion.error,
              signal: input.signal,
            }),
        finalOutput: finalOutput !== "" ? finalOutput : completion.error,
        finishReason: success ? "stop" : "error",
        runId: record.runId,
        sessionId: input.sessionId,
        steps: 0,
        success,
        toolCalls: [] satisfies readonly AgentToolCallSummary[],
      };
    } finally {
      unbindAbort();
    }
  } finally {
    deps.sandboxManager?.setSessionEnvironment(input.sessionId, undefined);
  }
}
