import type { UiNotice } from "ohbaby-sdk";
import { ConfigError, mergeReasoningIntent } from "ohbaby-llm";
import type { SessionSubagentHostOptions } from "../../agents/subagent-host.js";
import { resolveSubagentReasoning } from "../../config/llm/subagent-reasoning.js";
import { createRunModel } from "../ui-runtime/run-model.js";
import type { createModelClientPool } from "./model-client-pool.js";

export function createSubagentModelResolver(
  resolveModel: ReturnType<typeof createModelClientPool>["resolveSubagent"],
  projectDirectory: string,
  publishNotice: (notice: Omit<UiNotice, "id" | "createdAt">) => void,
): NonNullable<SessionSubagentHostOptions["resolveSubagentSetting"]> {
  return async () => {
    const model = await resolveModel(projectDirectory);
    if (!model) return undefined;
    if (model.status !== "configured") {
      publishNotice({
        key: "model:subagent-unavailable",
        level: "warning",
        title:
          model.status === "incomplete"
            ? "Subagent model needs setup"
            : "Unable to read subagent model settings",
        message: "This subagent execution is using the chat's model.",
      });
      return undefined;
    }
    const { client, entryId } = model;
    const runModel = createRunModel(entryId, client);
    if (model.reasoning !== undefined) {
      try {
        return {
          runModel,
          reasoning: resolveSubagentReasoning(client.config, model.reasoning),
        };
      } catch (error) {
        if (!(error instanceof ConfigError) || error.code !== "INVALID_FIELD")
          throw error;
        publishNotice({
          key: "model:subagent-reasoning-fallback",
          level: "warning",
          title: "Subagent reasoning preference unavailable",
          message:
            "The subagent model is using its default reasoning preference.",
        });
      }
    }
    return {
      runModel,
      reasoning: mergeReasoningIntent(client.config.reasoning),
    };
  };
}
