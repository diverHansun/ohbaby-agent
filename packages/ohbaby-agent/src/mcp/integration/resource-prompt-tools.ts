import type {
  Tool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "../../core/tool-scheduler/index.js";
import type { McpGetPromptResult, McpReadResourceResult } from "../types.js";

export interface McpResourceReader {
  readResource(serverName: string, uri: string): Promise<McpReadResourceResult>;
}

export interface McpPromptReader {
  getPrompt(
    serverName: string,
    name: string,
    args?: Record<string, string>,
  ): Promise<McpGetPromptResult>;
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`MCP ${key} must be a non-empty string`);
  }
  return value;
}

function optionalStringRecord(
  value: unknown,
): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MCP prompt args must be an object of strings");
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new Error("MCP prompt args must be an object of strings");
    }
    result[key] = entry;
  }
  return result;
}

function resourceToText(result: McpReadResourceResult): string {
  return result.contents
    .map((content) => {
      if (content.text !== undefined) {
        return content.text;
      }
      if (content.blob !== undefined) {
        return `[Binary resource: ${content.uri} (${content.mimeType ?? "unknown"})]`;
      }
      return `[Resource: ${content.uri}]`;
    })
    .join("\n");
}

export function createMcpResourceTool(manager: McpResourceReader): Tool {
  return {
    category: "readonly",
    description: "Read a resource exposed by a connected MCP server.",
    name: "mcp_resource",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        server: { type: "string" },
        uri: { type: "string" },
      },
      required: ["server", "uri"],
      type: "object",
    },
    isTrusted: false,
    source: "mcp",
    async execute(
      params: Record<string, unknown>,
      _context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> {
      const serverName = requiredString(params, "server");
      const uri = requiredString(params, "uri");
      const result = await manager.readResource(serverName, uri);
      return {
        metadata: {
          contentCount: result.contents.length,
          server: serverName,
          source: "mcp",
          uri,
        },
        output: resourceToText(result),
      };
    },
  };
}

export function createMcpPromptTool(manager: McpPromptReader): Tool {
  return {
    category: "readonly",
    description: "Get a prompt exposed by a connected MCP server.",
    name: "mcp_prompt",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        args: {
          additionalProperties: { type: "string" },
          type: "object",
        },
        name: { type: "string" },
        server: { type: "string" },
      },
      required: ["server", "name"],
      type: "object",
    },
    isTrusted: false,
    source: "mcp",
    async execute(
      params: Record<string, unknown>,
      _context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> {
      const serverName = requiredString(params, "server");
      const name = requiredString(params, "name");
      const args = optionalStringRecord(params.args);
      const result = await manager.getPrompt(serverName, name, args);
      return {
        metadata: {
          messageCount: result.messages.length,
          name,
          server: serverName,
          source: "mcp",
        },
        output: JSON.stringify(result.messages, null, 2),
      };
    },
  };
}
