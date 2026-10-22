import type {
  UiSettingsAgent,
  UiSettingsMcpServer,
  UiSettingsSkill,
} from "ohbaby-sdk";
import type { AgentManager } from "../../agents/manager.js";
import type { McpServerConfig } from "../../config/mcp/types.js";
import type { McpManager } from "../../mcp/core/manager.js";
import type { SkillRegistry } from "../../skill/registry.js";

/** Internal backend capability; HTTP only, outside the UI/JSON-RPC client contract. */
export interface InstanceSettingsReader {
  getSettingsMcpStatus(): Promise<readonly UiSettingsMcpServer[]>;
  getSettingsSkills(): Promise<readonly UiSettingsSkill[]>;
  getSettingsAgents(): Promise<readonly UiSettingsAgent[]>;
}

export function redactSettingsError(
  error: string,
  configs: readonly McpServerConfig[] = [],
): string {
  const secrets: string[] = [];
  for (const config of configs) {
    if (config.type === "stdio") {
      secrets.push(...Object.values(config.env ?? {}));
      for (const [index, argument] of config.args.entries()) {
        const credentialArgument =
          /^--?(api[-_]?key|(?:access[-_]?|refresh[-_]?)?token|password|secret|credential|authorization|headers?)(?:=(.*))?$/i.exec(
            argument,
          );
        if (credentialArgument) {
          const value =
            credentialArgument.at(2) ?? config.args.at(index + 1) ?? "";
          secrets.push(value);
          if (/^headers?$/i.test(credentialArgument.at(1) ?? "")) {
            const separator = value.indexOf(":");
            if (separator >= 0) secrets.push(value.slice(separator + 1).trim());
          }
        }
      }
    } else {
      secrets.push(...Object.values(config.headers ?? {}));
      const url = new URL(config.url);
      secrets.push(
        url.username,
        url.password,
        decodeURIComponent(url.username),
        decodeURIComponent(url.password),
      );
      for (const [key, value] of url.searchParams) {
        if (/key|token|password|secret|credential|authorization/i.test(key))
          secrets.push(value);
      }
    }
  }
  let message = error;
  for (const secret of secrets
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)) {
    message = message.replaceAll(secret, "[REDACTED]");
  }
  return message
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/(\bBearer\s+)[^\s,;"']+/gi, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|credential|authorization)["']?\s*[:=]\s*["']?)[^\s&,;"']+/gi,
      "$1[REDACTED]",
    );
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
