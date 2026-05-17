import type {
  Tool,
  ToolExecutionResult,
} from "../core/tool-scheduler/index.js";
import type { TaskExecutor } from "../agents/index.js";
import { ToolParameterError } from "./utils/params.js";

function requiredString(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolParameterError(
      `Expected parameter "${name}" to be a non-empty string.`,
    );
  }
  return value;
}

function optionalString(
  params: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = params[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolParameterError(
      `Expected parameter "${name}" to be a non-empty string when provided.`,
    );
  }
  return value;
}

export function createTaskTool(executor: TaskExecutor): Tool {
  return {
    category: "subagent",
    description:
      "Run a focused task in an isolated subagent session. Use this for bounded exploration or research without polluting the parent context.",
    name: "task",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        agent_name: { type: "string" },
        description: { type: "string" },
        prompt: { type: "string" },
        resume_session_id: { type: "string" },
      },
      required: ["agent_name", "prompt"],
      type: "object",
    },
    source: "builtin",
    async execute(params, context): Promise<ToolExecutionResult> {
      const result = await executor.execute({
        agentName: requiredString(params, "agent_name"),
        description: optionalString(params, "description"),
        parentSessionId: context.sessionId,
        prompt: requiredString(params, "prompt"),
        resumeSessionId: optionalString(params, "resume_session_id"),
        signal: context.signal,
        environment: context.environment,
      });
      return {
        output: result.output,
        metadata: { subagent: result },
      };
    },
  };
}
