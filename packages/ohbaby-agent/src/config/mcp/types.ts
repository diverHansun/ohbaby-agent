import { z } from "zod";

export const DEFAULT_MCP_TIMEOUT = 10_000;
export const DEFAULT_MCP_ENABLED = true;
export const DEFAULT_MCP_TRUST = false;

export type McpConfigErrorCode =
  | "ACCESS_ERROR"
  | "INVALID_JSON"
  | "VALIDATION_FAILED";

export class McpConfigError extends Error {
  readonly code: McpConfigErrorCode;
  readonly context?: Record<string, unknown>;
  readonly path?: string;

  constructor(input: {
    readonly code: McpConfigErrorCode;
    readonly message: string;
    readonly path?: string;
    readonly context?: Record<string, unknown>;
    readonly cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = new.target.name;
    this.code = input.code;
    this.path = input.path;
    this.context = input.context;
  }
}

export class McpConfigParseError extends McpConfigError {
  constructor(path: string, cause: unknown) {
    super({
      code: "INVALID_JSON",
      message: `Invalid JSON in MCP configuration: ${path}`,
      path,
      cause,
    });
  }
}

export class McpConfigValidationError extends McpConfigError {
  readonly issues: z.ZodIssue[];

  constructor(path: string, issues: z.ZodIssue[]) {
    super({
      code: "VALIDATION_FAILED",
      context: { issues },
      message: `Invalid MCP configuration at ${path}: ${formatZodIssues(
        issues,
      )}`,
      path,
    });
    this.issues = issues;
  }
}

export class McpConfigAccessError extends McpConfigError {
  constructor(path: string, cause: unknown) {
    super({
      code: "ACCESS_ERROR",
      message: `Unable to read MCP configuration: ${path}`,
      path,
      cause,
    });
  }
}

function formatZodIssues(issues: readonly z.ZodIssue[]): string {
  return issues
    .map((issue) => {
      const issuePath = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${issuePath}: ${issue.message}`;
    })
    .join("; ");
}

const ToolFilterSchema = z.array(z.string().trim().min(1));

function addToolFilterOverlapIssue(
  config: {
    readonly includeTools?: readonly string[];
    readonly excludeTools?: readonly string[];
  },
  context: z.RefinementCtx,
): void {
  const included = new Set(config.includeTools ?? []);
  const overlap = (config.excludeTools ?? []).filter((toolName) =>
    included.has(toolName),
  );
  if (overlap.length === 0) {
    return;
  }
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: `includeTools and excludeTools must not overlap: ${overlap.join(
      ", ",
    )}`,
    path: ["excludeTools"],
  });
}

const CommonMcpServerConfigSchema = {
  enabled: z.boolean().optional().default(DEFAULT_MCP_ENABLED),
  excludeTools: ToolFilterSchema.optional(),
  includeTools: ToolFilterSchema.optional(),
  timeout: z.number().int().positive().optional().default(DEFAULT_MCP_TIMEOUT),
  trust: z.boolean().optional().default(DEFAULT_MCP_TRUST),
} as const;

export const McpStdioConfigSchema = z
  .object({
    ...CommonMcpServerConfigSchema,
    args: z.array(z.string()).optional().default([]),
    command: z.string().trim().min(1),
    cwd: z.string().trim().min(1).optional(),
    env: z.record(z.string()).optional(),
    type: z.literal("stdio").optional().default("stdio"),
  })
  .strict()
  .superRefine(addToolFilterOverlapIssue);

export const McpHttpConfigSchema = z
  .object({
    ...CommonMcpServerConfigSchema,
    headers: z.record(z.string()).optional(),
    type: z.literal("http"),
    url: z.string().url(),
  })
  .strict()
  .superRefine(addToolFilterOverlapIssue);

export const McpSseConfigSchema = z
  .object({
    ...CommonMcpServerConfigSchema,
    headers: z.record(z.string()).optional(),
    type: z.literal("sse"),
    url: z.string().url(),
  })
  .strict()
  .superRefine(addToolFilterOverlapIssue);

export const McpServerConfigSchema = z.union([
  McpHttpConfigSchema,
  McpSseConfigSchema,
  McpStdioConfigSchema,
]);

function addServerNameIssues(
  config: { readonly mcpServers: Record<string, McpServerConfig> },
  context: z.RefinementCtx,
): void {
  for (const serverName of Object.keys(config.mcpServers)) {
    if (serverName.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "MCP server name must not be empty",
        path: ["mcpServers"],
      });
    } else if (serverName.trim() !== serverName) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `MCP server name must not have leading or trailing whitespace: ${serverName}`,
        path: ["mcpServers"],
      });
    }
  }
}

export const McpServersConfigSchema = z
  .object({
    mcpServers: z.record(z.string(), McpServerConfigSchema),
  })
  .strict()
  .superRefine(addServerNameIssues);

export type McpStdioConfig = z.infer<typeof McpStdioConfigSchema>;
export type McpHttpConfig = z.infer<typeof McpHttpConfigSchema>;
export type McpSseConfig = z.infer<typeof McpSseConfigSchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type McpServersConfig = z.infer<typeof McpServersConfigSchema>;
