import { createAgentContextScope } from "./context-scope.js";
import { runAgent } from "./runner.js";
import type {
  AgentInstance,
  AgentInstanceFactory,
  AgentInstanceIdentity,
  AgentRunDeps,
  AgentRunner,
  AgentTurnInput,
} from "./types.js";

export interface AgentInstanceFactoryOptions {
  readonly deps: AgentRunDeps;
  readonly runner?: AgentRunner;
}

class DefaultAgentInstance implements AgentInstance {
  readonly contextScope;

  constructor(
    readonly identity: AgentInstanceIdentity,
    private readonly deps: AgentRunDeps,
    private readonly runner: AgentRunner,
  ) {
    this.contextScope = createAgentContextScope(identity);
  }

  turn(input: AgentTurnInput): ReturnType<AgentInstance["turn"]> {
    return this.runner(this.deps, {
      agentName: this.identity.agentName,
      contextScope: this.contextScope,
      environment: input.environment,
      initialUserPrompt: input.prompt,
      maxSteps: this.identity.maxSteps,
      modelId: this.identity.modelId,
      projectRoot: this.identity.projectRoot,
      runId: input.runId,
      signal: input.signal,
      sessionId: this.contextScope.sessionId,
      waitMode: input.waitMode,
    });
  }
}

export function createAgentInstanceFactory(
  options: AgentInstanceFactoryOptions,
): AgentInstanceFactory {
  const runner = options.runner ?? runAgent;
  return {
    create(identity: AgentInstanceIdentity): AgentInstance {
      return new DefaultAgentInstance(identity, options.deps, runner);
    },
  };
}
