import type { ZodIssue } from "zod";

export class SkillNotFoundError extends Error {
  constructor(
    readonly skillName: string,
    readonly availableSkills: readonly string[],
  ) {
    super(
      `Skill "${skillName}" not found. Available skills: ${
        availableSkills.length > 0 ? availableSkills.join(", ") : "none"
      }`,
    );
    this.name = "SkillNotFoundError";
  }
}

export class SkillLoadError extends Error {
  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    super(
      `Failed to load skill from ${path}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = "SkillLoadError";
  }
}

export interface SkillInvalidError {
  readonly path: string;
  readonly message: string;
  readonly issues?: readonly ZodIssue[];
}
