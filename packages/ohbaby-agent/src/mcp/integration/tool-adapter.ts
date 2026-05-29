import type {
  ToolCategory,
  ToolExecutionResult,
} from "../../core/tool-scheduler/index.js";
import { McpToolExecutionError } from "../errors.js";
import type {
  McpCallToolResult,
  McpClientLike,
  McpContentBlock,
  McpTool,
  McpToolDefinition,
} from "../types.js";

function sanitizeToolNamePart(value: string): string {
  let encoded = "";
  for (const character of value) {
    if (/^[a-zA-Z0-9-]$/u.test(character)) {
      encoded += character;
    } else if (character === "_") {
      encoded += "__";
    } else {
      encoded += `_x${character.codePointAt(0)?.toString(16) ?? "0"}_`;
    }
  }
  return encoded;
}

function localToolName(serverName: string, toolName: string): string {
  const serverPart = sanitizeToolNamePart(serverName);
  const toolPart = sanitizeToolNamePart(toolName);
  const serverLength = String(serverPart.length);
  const toolLength = String(toolPart.length);
  return `mcp_s${serverLength}_${serverPart}_t${toolLength}_${toolPart}`;
}

function inferCategory(tool: McpToolDefinition): ToolCategory {
  return tool.annotations?.readOnlyHint === true ? "readonly" : "write";
}

function contentBlocks(result: McpCallToolResult): readonly McpContentBlock[] {
  if (result.content) {
    return result.content;
  }
  if ("toolResult" in result) {
    return [
      {
        text: JSON.stringify(result.toolResult),
        type: "text",
      },
    ];
  }
  return [];
}

function blockToText(block: McpContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "image":
      return `![Image](data:${block.mimeType};base64,${block.data})`;
    case "audio":
      return `[Audio: data:${block.mimeType};base64,${block.data}]`;
    case "resource": {
      const parts = [`[Resource: ${block.resource.uri}]`];
      if (block.resource.text) {
        parts.push(block.resource.text);
      }
      return parts.join("\n");
    }
    case "resource_link":
      return `[Resource: ${block.uri}]`;
  }
}

export function transformMcpResult(
  result: McpCallToolResult,
  context: { readonly serverName: string; readonly toolName: string },
): ToolExecutionResult {
  const blocks = contentBlocks(result);
  const contentTypes = blocks.map((block) => block.type);
  const output = blocks.map(blockToText).filter(Boolean).join("\n");
  const metadata: Record<string, unknown> = {
    contentTypes,
    server: context.serverName,
    source: "mcp",
    tool: context.toolName,
  };

  if (blocks.some((block) => block.type === "image")) {
    metadata.hasImage = true;
  }
  if (result.structuredContent) {
    metadata.structuredContent = result.structuredContent;
  }
  if (result.isError) {
    metadata.isError = true;
  }

  return { metadata, output };
}

export function adaptMcpTool(
  mcpTool: McpToolDefinition,
  client: McpClientLike,
): McpTool {
  const name = localToolName(client.name, mcpTool.name);
  const category = inferCategory(mcpTool);

  return {
    annotations: {
      readOnlyHint: mcpTool.annotations?.readOnlyHint,
    },
    category,
    description:
      mcpTool.description ?? `MCP tool ${client.name}.${mcpTool.name}`,
    isTrusted: client.config.trust,
    mcpAnnotations: mcpTool.annotations,
    mcpServer: client.name,
    mcpToolName: mcpTool.name,
    name,
    parametersJsonSchema: mcpTool.inputSchema,
    requireExplicitApproval: !client.config.trust,
    source: "mcp",
    async execute(params, context): Promise<ToolExecutionResult> {
      const result = await client.callTool(
        {
          arguments: params,
          name: mcpTool.name,
        },
        {
          signal: context.signal,
          timeout: client.config.timeout,
        },
      );
      const output = transformMcpResult(result, {
        serverName: client.name,
        toolName: mcpTool.name,
      });
      if (result.isError) {
        throw new McpToolExecutionError(
          client.name,
          mcpTool.name,
          new Error(output.output ?? "MCP tool execution failed"),
        );
      }
      return output;
    },
  };
}
