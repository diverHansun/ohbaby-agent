import type {
  UiSettingsGlobalMcpServer,
  UiSettingsMcpServer,
} from "ohbaby-sdk";

export type McpRowStatus =
  | "connected"
  | "failed"
  | "off"
  | "not-connected"
  | "unknown";

export interface McpServerRow {
  readonly name: string;
  readonly config: UiSettingsGlobalMcpServer;
  readonly status: McpRowStatus;
  /** The connected instance's view; absent when status is unknown or off. */
  readonly live?: UiSettingsMcpServer;
}

/**
 * Global config joined with the instance's actual state by name (06 §2.2).
 * Origin is ignored: a project override of the same name is what runs.
 * Names missing from the global list are not shown.
 */
export function mergeMcpRows(
  servers: readonly UiSettingsGlobalMcpServer[],
  status: readonly UiSettingsMcpServer[] | undefined,
): McpServerRow[] {
  const live = new Map(status?.map((server) => [server.name, server]));
  return servers.map((config) => {
    const actual = live.get(config.name);
    if (!config.enabled) return { name: config.name, config, status: "off" };
    if (!actual) return { name: config.name, config, status: "unknown" };
    const state: McpRowStatus =
      actual.status === "connected"
        ? "connected"
        : actual.status === "failed"
          ? "failed"
          : "not-connected";
    return { name: config.name, config, status: state, live: actual };
  });
}

export function mcpStatusText(row: McpServerRow): string {
  switch (row.status) {
    case "connected": {
      const count = row.live?.toolCount ?? 0;
      return `${String(count)} ${count === 1 ? "tool" : "tools"}`;
    }
    case "failed":
      return "Failed";
    case "off":
      return "Off";
    case "not-connected":
      return "Not connected";
    case "unknown":
      return "—";
  }
}

const TRANSPORTS: Readonly<
  Record<UiSettingsGlobalMcpServer["transport"], string>
> = {
  stdio: "stdio",
  http: "HTTP",
  http_streamable: "Streamable HTTP",
  sse: "SSE",
};

export function transportLabel(
  transport: UiSettingsGlobalMcpServer["transport"],
): string {
  return TRANSPORTS[transport];
}
