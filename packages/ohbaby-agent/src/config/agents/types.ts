import { z } from "zod";

export type AgentConfigErrorCode =
  | "ACCESS_ERROR"
  | "INVALID_JSON"
  | "VALIDATION_FAILED";

export class AgentConfigError extends Error {
  readonly code: AgentConfigErrorCode;
  readonly context?: Record<string, unknown>;
  readonly path?: string;

  constructor(input: {
    readonly code: AgentConfigErrorCode;
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

export class AgentConfigParseError extends AgentConfigError {
  constructor(path: string, cause: unknown) {
    super({
      code: "INVALID_JSON",
      message: `Invalid JSON in agent configuration: ${path}`,
      path,
      cause,
    });
  }
}

export class AgentConfigValidationError extends AgentConfigError {
  readonly issues: z.ZodIssue[];

  constructor(path: string, issues: z.ZodIssue[]) {
    super({
      code: "VALIDATION_FAILED",
      message: `Invalid agent configuration at ${path}: ${formatZodIssues(
        issues,
      )}`,
      path,
      context: { issues },
    });
    this.issues = issues;
  }
}

export class AgentConfigAccessError extends AgentConfigError {
  constructor(path: string, cause: unknown) {
    super({
      code: "ACCESS_ERROR",
      message: `Unable to read agent configuration: ${path}`,
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

export const AgentModeSchema = z.enum(["primary", "subagent", "all"]);
export const PermissionValueSchema = z.enum(["allow", "deny", "ask"]);

export const HexColorSchema = z.string().regex(
  /^#[0-9a-fA-F]{6}$/u,
  "Invalid hex color format (expected #RRGGBB)",
);

export const ModelIdSchema = z.string().regex(
  /^[^\s/]+\/[^\s/]+$/u,
  "Invalid model ID format (expected providerID/modelID)",
);

export const ToolsConfigSchema = z
  .object({
    include: z.array(z.string().min(1)).optional(),
    exclude: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const CriticalOperationsConfigSchema = z
  .object({
    bashPatterns: z.array(z.string().min(1)).optional(),
    disableDefaults: z.boolean().optional().default(false),
  })
  .strict();

export const PermissionConfigSchema = z
  .object({
    edit: PermissionValueSchema.optional(),
    bash: z
      .union([PermissionValueSchema, z.record(z.string(), PermissionValueSchema)])
      .optional(),
    web: PermissionValueSchema.optional(),
    mcp: PermissionValueSchema.optional(),
    externalDirectory: PermissionValueSchema.optional(),
    doomLoop: PermissionValueSchema.optional(),
    critical: CriticalOperationsConfigSchema.optional(),
  })
  .strict();

export const AgentConfigSchema = z
  .object({
    name: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    mode: AgentModeSchema,
    hidden: z.boolean().optional().default(false),
    default: z.boolean().optional().default(false),
    color: HexColorSchema.optional(),
    disabled: z.boolean().optional().default(false),
    maxSteps: z.number().int().positive().optional(),
    timeout: z.number().int().positive().optional(),
    allowDoomLoop: z.boolean().optional().default(false),
    model: ModelIdSchema.optional(),
    temperature: z.number().min(0).max(2).optional(),
    topP: z.number().min(0).max(1).optional(),
    maxTokens: z.number().int().positive().optional(),
    tools: ToolsConfigSchema.optional(),
    permission: PermissionConfigSchema.optional(),
    prompt: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((config, context) => {
    if (
      config.mode === "subagent" &&
      !config.disabled &&
      config.description === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Subagent must have a description",
        path: ["description"],
      });
    }
  });

export const AgentsConfigSchema = z
  .object({
    agents: z.record(z.string(), AgentConfigSchema),
  })
  .strict();

export type AgentMode = z.infer<typeof AgentModeSchema>;
export type PermissionValue = z.infer<typeof PermissionValueSchema>;
export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;
export type CriticalOperationsConfig = z.infer<
  typeof CriticalOperationsConfigSchema
>;
export type PermissionConfig = z.infer<typeof PermissionConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;
