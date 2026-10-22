import type { SettingsDomain } from "../../config/llm/config-coordination.js";
import type {
  UiSettingsAgent,
  UiSettingsMcpServer,
  UiSettingsSkill,
} from "ohbaby-sdk";
import type { AgentManager } from "../../agents/manager.js";
import { redactSettingsError } from "../../config/secrets/redaction.js";
export { redactSettingsError } from "../../config/secrets/redaction.js";
import type { McpManager } from "../../mcp/core/manager.js";
import type { SkillRegistry } from "../../skill/registry.js";

/** Internal backend capability; HTTP only, outside the UI/JSON-RPC client contract. */
export interface InstanceSettingsReader {
  getSettingsMcpStatus(): Promise<readonly UiSettingsMcpServer[]>;
  getSettingsSkills(): Promise<readonly UiSettingsSkill[]>;
  getSettingsAgents(): Promise<readonly UiSettingsAgent[]>;
}

export async function readSettingsMcpStatus(
  manager: McpManager,
): Promise<readonly UiSettingsMcpServer[]> {
  const tools = await manager.getAllTools();
  const statuses = await manager.getStatus();
  const servers = await manager.getServerDetails();
  return servers.map(({ name, config, origin }) => {
    const status = statuses[name] ?? { status: "disconnected" as const };
    const serverTools = tools
      .filter((tool) => tool.mcpServer === name)
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        mcpToolName: tool.mcpToolName,
      }));
    return {
      name,
      origin,
      enabled: config.enabled,
      status: status.status,
      ...(status.status === "failed"
        ? {
            error: redactSettingsError(
              status.error,
              servers.map((server) => server.config),
            ),
          }
        : {}),
      toolCount: serverTools.length,
      tools: serverTools,
    };
  });
}

export async function readSettingsSkills(
  registry: SkillRegistry,
): Promise<readonly UiSettingsSkill[]> {
  await registry.refresh();
  return (await registry.all()).map((skill) => ({
    name: skill.name,
    description: skill.description,
    source: skill.source,
    scope: skill.scope,
    location: skill.location,
    userInvocable: skill.userInvocable,
    modelInvocable: !skill.disableModelInvocation,
  }));
}

export function readSettingsAgents(
  manager: AgentManager,
): readonly UiSettingsAgent[] {
  return manager.listWithOrigins().map((agent) => ({
    name: agent.name,
    description: agent.description ?? "",
    mode: agent.mode,
    hidden: agent.hidden ?? false,
    origin: agent.origin,
  }));
}

/** Internal HTTP/event capabilities, deliberately absent from JSON-RPC. */
export interface InstanceSettingsControl {
  notifySettingsChanged(domains: readonly SettingsDomain[]): Promise<void>;
  reconnectSettingsMcp(): Promise<readonly UiSettingsMcpServer[]>;
}
