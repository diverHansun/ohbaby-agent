import type {
  Tool,
  ToolExecutionResult,
} from "../core/tool-scheduler/index.js";
import { DEFAULT_SUBAGENT_ROLE, SUBAGENT_ROLES } from "../agents/roles.js";
import type { TaskExecutor } from "../agents/index.js";
import {
  getOptionalNonEmptyStringParam,
  getRequiredNonEmptyStringParam,
} from "./utils/params.js";
import { subagentRoleParam } from "./utils/subagent-role.js";

export function createTaskTool(executor: TaskExecutor): Tool {
  return {
    category: "subagent",
    description:
      "Run a short, synchronous subagent task (fast search, inspect, return a result) that fits within about 5 minutes. You block until the subagent finishes and hands back its output. Role is optional and defaults to generic. Allowed roles are generic, explore, research. Use name/description for UI metadata only; put behavioral instructions in prompt.",
    name: "task",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        role: {
          default: DEFAULT_SUBAGENT_ROLE,
          description:
            "Optional subagent behavior role. Allowed: generic, explore, research. Omit for generic.",
          enum: [...SUBAGENT_ROLES],
          type: "string",
        },
        name: {
          description:
            "Optional display name for this subagent instance. Metadata only.",
          type: "string",
        },
        description: {
          description:
            "Optional UI/log description. Metadata only; include behavioral instructions in prompt.",
          type: "string",
        },
        prompt: { type: "string" },
        resume_session_id: { type: "string" },
      },
      required: ["prompt"],
      type: "object",
    },
    source: "builtin",
    async execute(params, context): Promise<ToolExecutionResult> {
      const result = await executor.execute({
        role: subagentRoleParam(params),
        name: getOptionalNonEmptyStringParam(params, "name"),
        description: getOptionalNonEmptyStringParam(params, "description"),
        parentSessionId: context.sessionId,
        prompt: getRequiredNonEmptyStringParam(params, "prompt"),
        resumeSessionId: getOptionalNonEmptyStringParam(
          params,
          "resume_session_id",
        ),
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
