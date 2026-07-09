type ToolMetadata = Record<string, unknown>;

function hasOwnMetadataValue(metadata: ToolMetadata, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(metadata, key);
}

function copyMetadataFields(
  metadata: ToolMetadata,
  fields: readonly string[],
): ToolMetadata {
  const projected: ToolMetadata = {};
  for (const field of fields) {
    if (hasOwnMetadataValue(metadata, field) && metadata[field] !== undefined) {
      projected[field] = metadata[field];
    }
  }
  return projected;
}

function nestedMetadata(
  metadata: ToolMetadata,
  key: string,
): ToolMetadata | undefined {
  const value = metadata[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as ToolMetadata;
}

export function projectToolMetadataForModel(
  tool: string,
  metadata?: ToolMetadata,
): ToolMetadata {
  if (metadata === undefined) {
    return {};
  }

  if (metadata.source === "mcp") {
    return copyMetadataFields(metadata, [
      "server",
      "tool",
      "isError",
      "contentTypes",
      "structuredContent",
    ]);
  }

  switch (tool) {
    case "bash":
      return copyMetadataFields(metadata, ["exitCode", "signal", "truncated"]);
    case "read":
      return copyMetadataFields(metadata, [
        "path",
        "mtimeMs",
        "hasMore",
        "nextOffset",
        "lineCount",
      ]);
    case "write":
      return copyMetadataFields(metadata, [
        "path",
        "mtimeMs",
        "created",
        "dryRun",
      ]);
    case "edit":
      return copyMetadataFields(metadata, [
        "path",
        "mtimeMs",
        "replacementCount",
        "dryRun",
      ]);
    case "list":
    case "glob":
    case "grep":
      return copyMetadataFields(metadata, [
        "count",
        "truncated",
        "skippedBinaryFiles",
        "skippedLargeFiles",
      ]);
    case "web_search":
    case "web_fetch":
      return copyMetadataFields(metadata, [
        "count",
        "successCount",
        "failedCount",
        "truncated",
      ]);
    case "subagent_run": {
      const subagent = nestedMetadata(metadata, "subagent");
      const item =
        subagent === undefined ? undefined : nestedMetadata(subagent, "item");
      return subagent === undefined || item === undefined
        ? {}
        : {
            ...copyMetadataFields(item, [
              "subagentId",
              "sessionId",
              "contextScopeId",
              "role",
              "name",
              "description",
              "status",
              "error",
            ]),
            ...copyMetadataFields(subagent, ["success"]),
          };
    }
    case "subagent_status": {
      const status = nestedMetadata(metadata, "subagentStatus");
      const items = status?.items;
      return Array.isArray(items)
        ? {
            items: items.map((item) =>
              typeof item === "object" && item !== null && !Array.isArray(item)
                ? copyMetadataFields(item as ToolMetadata, [
                    "subagentId",
                    "sessionId",
                    "contextScopeId",
                    "role",
                    "name",
                    "description",
                    "status",
                    "error",
                  ])
                : {},
            ),
          }
        : {};
    }
    case "subagent_close": {
      const close = nestedMetadata(metadata, "subagentClose");
      const item = close === undefined ? undefined : nestedMetadata(close, "item");
      return item === undefined
        ? copyMetadataFields(metadata, ["error"])
        : {
            ...copyMetadataFields(close ?? {}, ["previousStatus"]),
            ...copyMetadataFields(item, [
              "subagentId",
              "sessionId",
              "contextScopeId",
              "role",
              "name",
              "description",
              "status",
              "error",
            ]),
          };
    }
    default:
      return {};
  }
}

function toolMetadataBlock(metadata: ToolMetadata): string | undefined {
  if (Object.keys(metadata).length === 0) {
    return undefined;
  }
  return `<tool_metadata>\n${JSON.stringify(metadata)}\n</tool_metadata>`;
}

export function formatToolResultContentForModel(input: {
  readonly content: string;
  readonly metadata?: ToolMetadata;
  readonly tool: string;
}): string {
  const block = toolMetadataBlock(
    projectToolMetadataForModel(input.tool, input.metadata),
  );
  if (block === undefined) {
    return input.content;
  }
  return input.content === "" ? block : `${input.content}\n\n${block}`;
}
