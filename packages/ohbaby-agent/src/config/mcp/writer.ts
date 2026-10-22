import type {
  UiSettingsGlobalMcpServer,
  UiSettingsMcpServerUpdate,
} from "ohbaby-sdk";
import { z } from "zod";
import { resolveReadPathWithLegacy } from "../../paths/index.js";
import { coordinateModelConfig } from "../llm/config-coordination.js";
import { writeFileAtomically } from "../secrets/atomic-file.js";
import { redactSettingsUrl } from "../secrets/redaction.js";
import {
  getGlobalMcpConfigPath,
  getLegacyGlobalMcpConfigPath,
  getProjectMcpConfigPath,
  getLegacyProjectMcpConfigPath,
  loadMcpConfigFromPath,
  validateMcpConfig,
} from "./loaders.js";
import type { McpServerConfig, McpServersConfig } from "./types.js";

const SecretPatchSchema = z
  .object({
    set: z.record(z.string()).optional(),
    unset: z.array(z.string()).optional(),
  })
  .strict();
export const McpServerPatchSchema = z
  .object({
    transport: z.enum(["stdio", "http", "http_streamable", "sse"]).optional(),
    enabled: z.boolean().optional(),
    trust: z.boolean().optional(),
    timeout: z.number().int().positive().optional(),
    includeTools: z.array(z.string()).optional(),
    excludeTools: z.array(z.string()).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    url: z.string().url().optional(),
    env: SecretPatchSchema.optional(),
    headers: SecretPatchSchema.optional(),
  })
  .strict();
export type McpServerPatch = UiSettingsMcpServerUpdate;
export class McpServerNotFoundError extends Error {
  readonly code = "MCP_SERVER_NOT_FOUND";
  constructor() {
    super("Global MCP server not found");
  }
}

async function readGlobal(): Promise<McpServersConfig> {
  return loadMcpConfigFromPath(
    await resolveReadPathWithLegacy(getGlobalMcpConfigPath(), [
      getLegacyGlobalMcpConfigPath(),
    ]),
  );
}
function projectServer(
  name: string,
  config: McpServerConfig,
): UiSettingsGlobalMcpServer {
  const { type: transport, ...common } = config;
  // URLs may contain credentials; args deliberately remain unchanged by contract.
  if (config.type === "stdio") {
    const { env, ...fields } = common as Omit<typeof config, "type">;
    return {
      name,
      ...fields,
      transport,
      envKeys: Object.keys(env ?? {}),
      headerKeys: [] as string[],
    };
  }
  const { headers, url, ...fields } = common as Omit<
    Exclude<McpServerConfig, { type: "stdio" }>,
    "type"
  >;
  return {
    name,
    ...fields,
    url: redactSettingsUrl(url, Object.values(headers ?? {})),
    transport,
    envKeys: [] as string[],
    headerKeys: Object.keys(headers ?? {}),
  };
}
export function readGlobalMcpServers(): Promise<UiSettingsGlobalMcpServer[]> {
  return coordinateModelConfig(undefined, async () =>
    Object.entries((await readGlobal()).mcpServers).map(([name, config]) =>
      projectServer(name, config),
    ),
  );
}
function applySecretPatch(
  existing: unknown,
  patch: z.infer<typeof SecretPatchSchema>,
): Record<string, string> {
  const values = {
    ...(existing as Record<string, string> | undefined),
    ...patch.set,
  };
  for (const key of patch.unset ?? []) Reflect.deleteProperty(values, key);
  return values;
}
export function updateGlobalMcpServer(
  name: string,
  input: McpServerPatch,
): Promise<UiSettingsGlobalMcpServer> {
  return coordinateModelConfig(undefined, async () => {
    const patch = McpServerPatchSchema.parse(input);
    const current = await readGlobal();
    const existing = Object.hasOwn(current.mcpServers, name)
      ? current.mcpServers[name]
      : undefined;
    const { transport, env, headers, ...fields } = patch;
    const next: Record<string, unknown> = {
      ...existing,
      ...fields,
      type: transport ?? existing?.type ?? "stdio",
    };
    if (
      transport !== undefined &&
      existing !== undefined &&
      (transport === "stdio") !== (existing.type === "stdio")
    ) {
      for (const key of transport === "stdio"
        ? ["url", "headers"]
        : ["command", "args", "cwd", "env"])
        Reflect.deleteProperty(next, key);
      Object.assign(next, fields);
    }
    if (env !== undefined) next.env = applySecretPatch(next.env, env);
    if (headers !== undefined)
      next.headers = applySecretPatch(next.headers, headers);
    const config = validateMcpConfig(
      { mcpServers: { ...current.mcpServers, [name]: next } },
      getGlobalMcpConfigPath(),
    );
    await writeFileAtomically(
      getGlobalMcpConfigPath(),
      `${JSON.stringify(config, null, 2)}\n`,
    );
    return projectServer(name, config.mcpServers[name]);
  });
}
export function deleteGlobalMcpServer(name: string): Promise<void> {
  return coordinateModelConfig(undefined, async () => {
    const current = await readGlobal();
    if (!Object.hasOwn(current.mcpServers, name))
      throw new McpServerNotFoundError();
    const servers = { ...current.mcpServers };
    Reflect.deleteProperty(servers, name);
    const config = validateMcpConfig(
      { mcpServers: servers },
      getGlobalMcpConfigPath(),
    );
    await writeFileAtomically(
      getGlobalMcpConfigPath(),
      `${JSON.stringify(config, null, 2)}\n`,
    );
  });
}
export async function globalMcpOverriddenIn(
  name: string,
  directories: readonly string[],
): Promise<string[]> {
  const overridden = await Promise.allSettled(
    directories.map(async (directory) => {
      const path = await resolveReadPathWithLegacy(
        getProjectMcpConfigPath(directory),
        [getLegacyProjectMcpConfigPath(directory)],
      );
      const project = await loadMcpConfigFromPath(path);
      return Object.hasOwn(project.mcpServers, name) ? directory : undefined;
    }),
  );
  return overridden.flatMap((result) =>
    result.status === "fulfilled" && result.value !== undefined
      ? [result.value]
      : [],
  );
}
