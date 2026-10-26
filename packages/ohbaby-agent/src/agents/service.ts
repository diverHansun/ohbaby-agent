import { mergeReasoningIntent } from "ohbaby-llm";
import type { AgentInstanceFactory } from "../core/agents/index.js";
import {
  sessionTargetWorkingDirectory,
  type Session,
  type SessionManager,
} from "../services/session/index.js";
import { AgentManager } from "./manager.js";
import {
  assertNoStaticModelConfig,
  type AgentSessionStartResult,
  type StartSessionParams,
} from "./types.js";

export interface AgentServiceOptions {
  readonly agentManager: AgentManager;
  readonly instanceFactory: AgentInstanceFactory;
  readonly sessionManager: Pick<SessionManager, "create" | "get">;
}

export class AgentService {
  constructor(private readonly options: AgentServiceOptions) {}

  async startSession(
    params: StartSessionParams,
  ): Promise<AgentSessionStartResult> {
    params.preparationSignal?.throwIfAborted();
    const reasoning = mergeReasoningIntent(
      params.runModel.client.config.reasoning,
      params.reasoning,
    );
    const runtimeAgent = await this.options.agentManager.getRuntimeAgent(
      params.agentName,
      { isSubagent: false },
    );
    params.preparationSignal?.throwIfAborted();
    assertNoStaticModelConfig(runtimeAgent.config, "AgentService");
    if (runtimeAgent.config.mode === "subagent") {
      throw new Error(
        `Agent ${params.agentName} cannot be used as a primary agent`,
      );
    }
    const session = await this.resolvePrimarySession(params);
    params.preparationSignal?.throwIfAborted();
    const instance = this.options.instanceFactory.create({
      agentName: params.agentName,
      instanceId: session.id,
      maxSteps: params.maxSteps ?? runtimeAgent.config.maxSteps,
      modelId: params.runModel.client.config.model,
      // A pending project change takes effect with this turn.
      projectRoot: sessionTargetWorkingDirectory(session),
      sessionId: session.id,
      type: "primary",
    });
    const result = await instance.turn({
      runModel: params.runModel,
      reasoning,
      environment: params.environment,
      initialUserMessageId: params.initialUserMessageId,
      displayUserText: params.displayUserText,
      skillUsage: params.skillUsage,
      prompt: params.prompt,
      runId: params.runId,
      signal: params.signal,
      preparationSignal: params.preparationSignal,
      waitMode: "stream",
    });
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
