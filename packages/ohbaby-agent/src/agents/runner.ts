import type { ChatCompletionMessage } from "../core/llm-client/index.js";
import type { MessageManager } from "../core/message/index.js";
import type {
  ToolSchedulerInstance,
} from "../core/tool-scheduler/index.js";
import {
  runAgent,
  toOpenAiTools,
  type AgentRunCoordinator,
  type AgentSandboxEnvironmentManager,
} from "../core/agents/index.js";
import type { SubagentRunner, SubagentRunnerResult } from "./types.js";

export { toOpenAiTools };

export type SubagentSandboxEnvironmentManager = AgentSandboxEnvironmentManager;

export type SubagentPromptMessageBuilder = (input: {
  readonly agentName: string;
  readonly projectRoot: string;
  readonly sessionId: string;
}) => Promise<readonly ChatCompletionMessage[]>;

export interface CreateSubagentRunnerOptions {
  readonly buildSubagentPromptMessages: SubagentPromptMessageBuilder;
  readonly fallbackProjectRoot?: string;
  readonly messageManager: Pick<MessageManager, "listBySession">;
  readonly runManager: AgentRunCoordinator;
  readonly sandboxManager: SubagentSandboxEnvironmentManager;
  readonly toolScheduler: Pick<ToolSchedulerInstance, "getAvailableTools">;
}

export function createSubagentRunner(
  options: CreateSubagentRunnerOptions,
): SubagentRunner {
  return {
    async run(input): Promise<SubagentRunnerResult> {
      const projectRoot =
        input.projectRoot ?? options.fallbackProjectRoot ?? process.cwd();
      const result = await runAgent(
        {
          messageManager: options.messageManager,
          runCoordinator: options.runManager,
          sandboxManager: options.sandboxManager,
          toolScheduler: options.toolScheduler,
        },
        {
          agentName: input.agentName,
          buildPromptMessages: (builderInput) =>
            options.buildSubagentPromptMessages({
              agentName: builderInput.agentName,
              projectRoot: builderInput.projectRoot,
              sessionId: builderInput.sessionId,
            }),
          environment: input.environment,
          maxSteps: input.runtimeAgent.config.maxSteps,
          parentMessageId: input.parentMessageId,
          parentSessionId: input.parentSessionId,
          projectRoot,
          sessionId: input.sessionId,
          signal: input.signal,
          waitMode: "waitForCompletion",
        },
      );
      return {
        output: result.finalOutput ?? "",
        steps: result.steps,
        success: result.success,
        toolCalls: result.toolCalls,
      };
    },
  };
}
