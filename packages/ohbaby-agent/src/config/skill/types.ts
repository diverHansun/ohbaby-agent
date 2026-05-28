import { z } from "zod";

export type SkillConfigErrorCode =
  | "ACCESS_ERROR"
  | "INVALID_JSON"
  | "VALIDATION_FAILED";

export class SkillConfigError extends Error {
  readonly code: SkillConfigErrorCode;
  readonly context?: Record<string, unknown>;
  readonly path?: string;

  constructor(input: {
    readonly code: SkillConfigErrorCode;
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

export class SkillConfigParseError extends SkillConfigError {
  constructor(path: string, cause: unknown) {
    super({
      cause,
      code: "INVALID_JSON",
      message: `Invalid JSON in skill configuration: ${path}`,
      path,
    });
  }
}

export class SkillConfigValidationError extends SkillConfigError {
  readonly issues: z.ZodIssue[];

  constructor(path: string, issues: z.ZodIssue[]) {
    super({
      code: "VALIDATION_FAILED",
      context: { issues },
      message: `Invalid skill configuration at ${path}: ${formatZodIssues(
        issues,
      )}`,
      path,
    });
    this.issues = issues;
  }
}

export class SkillConfigAccessError extends SkillConfigError {
  constructor(path: string, cause: unknown) {
    super({
      cause,
      code: "ACCESS_ERROR",
      message: `Unable to read skill configuration: ${path}`,
      path,
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

export const SkillDirectorySourceSchema = z.enum([
  "agents-compatible",
  "claude-compatible",
  "codex-home",
  "plugin",
  "project-native",
  "user-native",
]);

export const SkillDirectoryConfigSchema = z
  .object({
    path: z.string().trim().min(1),
    pluginId: z.string().trim().min(1).optional(),
    priority: z.number().int().optional(),
    scope: z.enum(["project", "user"]),
    source: SkillDirectorySourceSchema.optional(),
  })
  .strict();

export const SkillConfigSchema = z
  .object({
    directories: z.array(SkillDirectoryConfigSchema).optional().default([]),
  })
  .strict();

export type SkillDirectoryConfig = z.infer<typeof SkillDirectoryConfigSchema>;
export type SkillConfig = z.infer<typeof SkillConfigSchema>;
