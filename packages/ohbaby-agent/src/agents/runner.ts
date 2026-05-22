import type { ChatCompletionCreateParams } from "openai/resources/chat/completions/completions";
import type { ChatCompletionMessage } from "../core/llm-client/index.js";
import type {
  MessageManager,
  MessageWithParts,
} from "../core/message/index.js";
import type {
  ToolDefinition,
  ToolExecutionEnvironment,
  ToolSchedulerInstance,
} from "../core/tool-scheduler/index.js";
import type { RunManager } from "../runtime/run-manager/index.js";
import type { SubagentRunner, SubagentRunnerResult } from "./types.js";

export interface SubagentSandboxEnvironmentManager {
  setSessionEnvironment(
    sessionId: string,
    environment: ToolExecutionEnvironment | undefined,
  ): void;
}

export type SubagentPromptMessageBuilder = (input: {
  readonly agentName: string;
  readonly projectRoot: string;
  readonly sessionId: string;
}) => Promise<ChatCompletionMessage[]>;

export interface CreateSubagentRunnerOptions {
  readonly buildSubagentPromptMessages: SubagentPromptMessageBuilder;
  readonly fallbackProjectRoot?: string;
  readonly messageManager: Pick<MessageManager, "listBySession">;
  readonly runManager: Pick<
    RunManager,
    "cancel" | "create" | "waitForCompletion"
  >;
  readonly sandboxManager: SubagentSandboxEnvironmentManager;
  readonly toolScheduler: Pick<ToolSchedulerInstance, "getAvailableTools">;
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

function textFromMessage(message: MessageWithParts): string {
  return message.parts
    .map((part) => {
      if (part.type === "text" || part.type === "reasoning") {
        return part.text;
      }
      return "";
    })
    .join("");
}

function lastAssistantText(messages: readonly MessageWithParts[]): string {
  const assistant = [...messages]
    .reverse()
    .find((message) => message.info.role === "assistant");
  return assistant ? textFromMessage(assistant) : "";
}

function abortReason(signal: AbortSignal): string {
  return typeof signal.reason === "string" && signal.reason.length > 0
    ? signal.reason
    : "subagent run aborted";
}

function bindSubagentAbort(input: {
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
      // The child run may already be terminal.
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

export function createSubagentRunner(
  options: CreateSubagentRunnerOptions,
): SubagentRunner {
  return {
    async run(input): Promise<SubagentRunnerResult> {
      const tools = await options.toolScheduler.getAvailableTools({
        agentName: input.agentName,
        isSubagent: true,
      });
      options.sandboxManager.setSessionEnvironment(
        input.sessionId,
        input.environment,
      );
      try {
        const messages = await options.buildSubagentPromptMessages({
          agentName: input.agentName,
          projectRoot:
            input.projectRoot ?? options.fallbackProjectRoot ?? process.cwd(),
          sessionId: input.sessionId,
        });
        const record = await options.runManager.create({
          agent: input.agentName,
          isSubagent: true,
          maxSteps: input.runtimeAgent.config.maxSteps,
          messages,
          parentMessageId: input.parentMessageId,
          sessionId: input.sessionId,
          tools: toOpenAiTools(tools),
          triggerSource: "user",
        });
        const unbindAbort = bindSubagentAbort({
          cancel: options.runManager.cancel.bind(options.runManager),
          runId: record.runId,
          signal: input.signal,
        });
        try {
          const completion = await options.runManager.waitForCompletion(
            record.runId,
          );
          const childMessages = await options.messageManager.listBySession(
            input.sessionId,
          );
          const output = lastAssistantText(childMessages);
          return {
            output: output !== "" ? output : (completion.error ?? ""),
            steps: 0,
            success: completion.status === "succeeded",
            toolCalls: [],
          };
        } finally {
          unbindAbort();
        }
      } finally {
        options.sandboxManager.setSessionEnvironment(
          input.sessionId,
          undefined,
        );
      }
    },
  };
}
