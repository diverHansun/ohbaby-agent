import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig } from "../../config/index.js";
import type { McpTransport } from "../types.js";

function inheritedEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

function requestInit(
  headers: Record<string, string> | undefined,
): { readonly headers?: Record<string, string> } | undefined {
  return headers ? { headers } : undefined;
}

export function createTransport(config: McpServerConfig): McpTransport {
  if (config.type === "stdio") {
    return new StdioClientTransport({
      args: config.args,
      command: config.command,
      cwd: config.cwd,
      env: { ...inheritedEnvironment(), ...config.env },
      stderr: "pipe",
    });
  }

  if (config.type === "http" || config.type === "http_streamable") {
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: requestInit(config.headers),
    });
  }

  // SSE is deprecated by the SDK but remains part of the documented MCP config
  // surface for older servers that have not moved to streamable HTTP.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  return new SSEClientTransport(new URL(config.url), {
    requestInit: requestInit(config.headers),
  });
}
