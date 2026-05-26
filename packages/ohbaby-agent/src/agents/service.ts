import {
  runAgent,
  type AgentPromptMessageBuilder,
  type AgentRunCoordinator,
  type AgentRunEventSource,
  type AgentSandboxEnvironmentManager,
} from "../core/agents/index.js";
import type { MessageManager } from "../core/message/index.js";
import type { ToolSchedulerInstance } from "../core/tool-scheduler/index.js";
import type { Session, SessionManager } from "../services/session/index.js";
import { AgentManager } from "./manager.js";
import type {
  AgentSessionStartResult,
  StartSessionParams,
  SubagentExecuteParams,
  SubagentResult,
  TaskExecutor,
} from "./types.js";

const DEFAULT_MAX_CONCURRENCY = 3;

export interface AgentServiceOptions {
  readonly agentManager: AgentManager;
  readonly buildPromptMessages: AgentPromptMessageBuilder;
  readonly messageManager: MessageManager;
  readonly runCoordinator: AgentRunCoordinator;
  readonly runEventSource?: AgentRunEventSource;
  readonly sandboxManager?: AgentSandboxEnvironmentManager;
  readonly sessionManager: Pick<SessionManager, "create" | "get">;
  readonly toolScheduler: Pick<ToolSchedulerInstance, "getAvailableTools">;
  readonly maxConcurrency?: number;
  readonly now?: () => number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AgentService implements TaskExecutor {
  private readonly maxConcurrency: number;
  private readonly now: () => number;
  private runningCount = 0;

  constructor(private readonly options: AgentServiceOptions) {
    this.maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this.now = options.now ?? Date.now;
  }

  getConcurrentCount(): number {
    return this.runningCount;
  }

  execute(params: SubagentExecuteParams): Promise<SubagentResult> {
    return this.executeTask(params);
  }

  async startSession(
    params: StartSessionParams,
  ): Promise<AgentSessionStartResult> {
    const runtimeAgent = await this.options.agentManager.getRuntimeAgent(
      params.agentName,
      { isSubagent: false },
    );
    if (runtimeAgent.config.mode === "subagent") {
      throw new Error(
        `Agent ${params.agentName} cannot be used as a primary agent`,
      );
    }
    const session = await this.resolvePrimarySession(params);
    const result = await runAgent(
      {
        messageManager: this.options.messageManager,
        runCoordinator: this.options.runCoordinator,
        runEventSource: this.options.runEventSource,
        sandboxManager: this.options.sandboxManager,
        toolScheduler: this.options.toolScheduler,
      },
      {
        agentName: params.agentName,
        buildPromptMessages: this.options.buildPromptMessages,
        environment: params.environment,
        initialUserPrompt: params.prompt,
        maxSteps: params.maxSteps ?? runtimeAgent.config.maxSteps,
        projectRoot: session.projectRoot,
        sessionId: session.id,
        signal: params.signal,
        waitMode: "stream",
      },
    );
    if (result.mode !== "stream") {
      throw new Error("Primary session expected a streaming agent run");
    }
    return result;
  }

  async executeTask(params: SubagentExecuteParams): Promise<SubagentResult> {
    if (this.runningCount >= this.maxConcurrency) {
      throw new Error("Maximum concurrent subagents reached");
    }
    this.runningCount += 1;
    const startedAt = this.now();
    try {
      const runtimeAgent = await this.options.agentManager.getRuntimeAgent(
        params.agentName,
        { isSubagent: true },
      );
      if (runtimeAgent.config.mode === "primary") {
        throw new Error(
          `Agent ${params.agentName} cannot be used as a subagent`,
        );
      }
      const session = await this.resolveSession(params);
      try {
        const result = await runAgent(
          {
            messageManager: this.options.messageManager,
            runCoordinator: this.options.runCoordinator,
            sandboxManager: this.options.sandboxManager,
            toolScheduler: this.options.toolScheduler,
          },
          {
            agentName: params.agentName,
            buildPromptMessages: this.options.buildPromptMessages,
            environment: params.environment,
            initialUserPrompt: params.prompt,
            maxSteps: runtimeAgent.config.maxSteps,
            parentSessionId: params.parentSessionId,
            projectRoot: session.projectRoot,
            sessionId: session.id,
            signal: params.signal,
            waitMode: "waitForCompletion",
          },
        );
        if (result.mode !== "waitForCompletion") {
          throw new Error("Task execution expected a completed agent run");
        }
        const output = result.success
          ? result.finalOutput
          : result.finalOutput ?? result.error;
        return {
          output,
          sessionId: session.id,
          success: result.success,
          summary: {
            duration: this.now() - startedAt,
            steps: result.steps ?? 0,
            toolCalls: result.toolCalls ?? [],
          },
        };
      } catch (error) {
        return {
          output: errorMessage(error),
          sessionId: session.id,
          success: false,
          summary: {
            duration: this.now() - startedAt,
            steps: 0,
            toolCalls: [],
          },
        };
      }
    } finally {
      this.runningCount = Math.max(0, this.runningCount - 1);
    }
  }

  private async resolveSession(
    params: SubagentExecuteParams,
  ): Promise<Session> {
    if (params.resumeSessionId) {
      const resumed = await this.options.sessionManager.get(
        params.resumeSessionId,
      );
      if (!resumed) {
        throw new Error(
          `Subagent session not found: ${params.resumeSessionId}`,
        );
      }
      if (!resumed.isSubagent || resumed.parentId !== params.parentSessionId) {
        throw new Error(
          `Session ${params.resumeSessionId} is not a child of ${params.parentSessionId}`,
        );
      }
      if (resumed.agentName !== params.agentName) {
        throw new Error(
          `Session ${params.resumeSessionId} belongs to agent ${resumed.agentName}, not ${params.agentName}`,
        );
      }
      return resumed;
    }

    const parent = await this.options.sessionManager.get(
      params.parentSessionId,
    );
    if (!parent) {
      throw new Error(`Parent session not found: ${params.parentSessionId}`);
    }
    return this.options.sessionManager.create(parent.projectRoot, {
      agentName: params.agentName,
      parentId: parent.id,
      title: params.description,
    });
  }

  private async resolvePrimarySession(
    params: StartSessionParams,
  ): Promise<Session> {
    const existing = await this.options.sessionManager.get(params.sessionId);
    if (existing) {
      if (existing.isSubagent) {
        throw new Error(
          `Cannot start primary agent in subagent session: ${params.sessionId}`,
        );
      }
      return existing;
    }
    return this.options.sessionManager.create(params.projectRoot, {
      agentName: params.agentName,
      id: params.sessionId,
      title: params.title,
    });
  }
}
