function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class McpConnectionError extends Error {
  constructor(
    readonly serverName: string,
    readonly originalError: unknown,
  ) {
    super(
      `Failed to connect to MCP server "${serverName}": ${errorMessage(
        originalError,
      )}`,
      { cause: originalError },
    );
    this.name = "McpConnectionError";
  }
}

export class McpToolDiscoveryError extends Error {
  constructor(
    readonly serverName: string,
    readonly originalError: unknown,
  ) {
    super(
      `Failed to discover tools from MCP server "${serverName}": ${errorMessage(
        originalError,
      )}`,
      { cause: originalError },
    );
    this.name = "McpToolDiscoveryError";
  }
}

export class McpToolExecutionError extends Error {
  constructor(
    readonly serverName: string,
    readonly toolName: string,
    readonly originalError: unknown,
  ) {
    super(
      `MCP tool "${serverName}.${toolName}" execution failed: ${errorMessage(
        originalError,
      )}`,
      { cause: originalError },
    );
    this.name = "McpToolExecutionError";
  }
}
