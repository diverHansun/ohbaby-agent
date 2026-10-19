import { createHash } from "node:crypto";
import { generateMcpToolMenuPrompt } from "../../mcp/system-prompt.js";
import type {
  ReminderBody,
  ReminderContext,
  ReminderProvider,
} from "./index.js";

type McpMenuScope = Pick<
  ReminderContext,
  "agentName" | "contextScopeId" | "isSubagent" | "sessionId"
>;

export function createMcpCatalogReminderProvider(
  resolveToolNames: (scope: McpMenuScope) => Promise<readonly string[]>,
): ReminderProvider {
  return {
    type: "mcp-catalog",
    kind: "snapshot",
    audience: "both",
    async collect(context): Promise<ReminderBody | undefined> {
      const toolNames = await resolveToolNames(context);
      const text = generateMcpToolMenuPrompt({ toolNames });
      if (text === "") return undefined;
      // Include names beyond the displayed twenty so every menu change is observed.
      const key = JSON.stringify(
        [...new Set(toolNames)].filter((name) => name.trim() !== "").sort(),
      );
      return { key: createHash("sha256").update(key).digest("hex"), text };
    },
  };
}
