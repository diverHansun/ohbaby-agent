import {
  runAgent,
  type AgentRunCoordinator,
  type AgentRunEventSource,
} from "../core/agents/index.js";
import type { MessageManager } from "../core/message/index.js";
import type { ToolSchedulerInstance } from "../core/tool-scheduler/index.js";
import type { Session, SessionManager } from "../services/session/index.js";
import { AgentManager } from "./manager.js";
import type {
  AgentSessionStartResult,
  StartSessionParams,
} from "./types.js";

export interface AgentServiceOptions {
  readonly agentManager: AgentManager;
  readonly messageManager: MessageManager;
  readonly modelId: string;
  readonly runCoordinator: AgentRunCoordinator;
  readonly runEventSource?: AgentRunEventSource;
  readonly sessionManager: Pick<SessionManager, "create" | "get">;
  readonly toolScheduler: Pick<ToolSchedulerInstance, "getAvailableTools">;
}

export class AgentService {
  constructor(private readonly options: AgentServiceOptions) {}

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
        toolScheduler: this.options.toolScheduler,
      },
      {
        agentName: params.agentName,
        environment: params.environment,
        initialUserPrompt: params.prompt,
        maxSteps: params.maxSteps ?? runtimeAgent.config.maxSteps,
        modelId: this.options.modelId,
        projectRoot: session.projectRoot,
        runId: params.runId,
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
