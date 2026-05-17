import { AgentManager } from "./manager.js";
import type {
  SubagentExecuteParams,
  SubagentMessageWriter,
  SubagentResult,
  SubagentRunner,
  SubagentSession,
  SubagentSessionManager,
  TaskExecutor,
} from "./types.js";

const DEFAULT_MAX_CONCURRENCY = 3;

export interface SubagentExecutorOptions {
  readonly agentManager: AgentManager;
  readonly sessionManager: SubagentSessionManager;
  readonly runner: SubagentRunner;
  readonly messageWriter?: SubagentMessageWriter;
  readonly maxConcurrency?: number;
  readonly now?: () => number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SubagentExecutor implements TaskExecutor {
  private readonly now: () => number;
  private readonly maxConcurrency: number;
  private runningCount = 0;

  constructor(private readonly options: SubagentExecutorOptions) {
    this.maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this.now = options.now ?? Date.now;
  }

  getConcurrentCount(): number {
    return this.runningCount;
  }

  async execute(params: SubagentExecuteParams): Promise<SubagentResult> {
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
      await this.options.messageWriter?.writeUserMessage({
        agentName: params.agentName,
        parentSessionId: params.parentSessionId,
        prompt: params.prompt,
        sessionId: session.id,
      });
      try {
        const result = await this.options.runner.run({
          agentName: params.agentName,
          environment: params.environment,
          parentSessionId: params.parentSessionId,
          prompt: params.prompt,
          runtimeAgent,
          sessionId: session.id,
          signal: params.signal,
        });
        return {
          output: result.output,
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
  ): Promise<SubagentSession> {
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
}
