import type {
  Tool,
  ToolExecutionResult,
} from "../core/tool-scheduler/index.js";
import type { SkillContent, SkillInfo, SkillResourceContent } from "./types.js";

const DESCRIPTION_HEADER =
  "Load a skill to get detailed instructions for a specific task.";
const NO_SKILLS_DESCRIPTION = "No skills are currently available.";
const SKILL_BUDGET_CONTEXT_PERCENT = 0.01;
const CHARS_PER_TOKEN = 4;
const DEFAULT_CHAR_BUDGET = 8_000;
const MAX_LISTING_DESC_CHARS = 250;
const MIN_DESC_LENGTH = 20;

export interface SkillToolRegistry {
  get(name: string): Promise<SkillInfo | undefined>;
  listModelInvocable(): Promise<readonly SkillInfo[]>;
  load(name: string): Promise<SkillContent>;
}

export interface SkillResourceToolRegistry {
  get(name: string): Promise<SkillInfo | undefined>;
  readResource(
    name: string,
    resourcePath: string,
  ): Promise<SkillResourceContent>;
}

export interface SkillDescriptionOptions {
  readonly contextWindowTokens?: number;
}

function requiredString(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Expected parameter "${name}" to be a non-empty string.`);
  }
  return value;
}

function sortSkills(skills: readonly SkillInfo[]): readonly SkillInfo[] {
  return [...skills].sort((left, right) => left.name.localeCompare(right.name));
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  if (maxLength <= 3) {
    return value.slice(0, Math.max(0, maxLength));
  }
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function charBudget(options: SkillDescriptionOptions): number {
  if (!options.contextWindowTokens) {
    return DEFAULT_CHAR_BUDGET;
  }
  return Math.max(
    1,
    Math.floor(
      options.contextWindowTokens *
        CHARS_PER_TOKEN *
        SKILL_BUDGET_CONTEXT_PERCENT,
    ),
  );
}

function wrapListing(lines: readonly string[]): string {
  return [
    DESCRIPTION_HEADER,
    "",
    "<available_skills>",
    ...lines,
    "</available_skills>",
  ].join("\n");
}

function nameOnlyLines(skills: readonly SkillInfo[]): readonly string[] {
  return skills.map((skill) => `- ${skill.name}`);
}

async function assertModelInvocable(
  registry: { get(name: string): Promise<SkillInfo | undefined> },
  name: string,
): Promise<void> {
  const skill = await registry.get(name);
  if (!skill) {
    throw new Error(`Skill "${name}" not found.`);
  }
  if (skill.disableModelInvocation) {
    throw new Error(`Skill "${name}" is disabled for model invocation.`);
  }
}

export async function buildSkillToolDescription(
  registry: Pick<SkillToolRegistry, "listModelInvocable">,
  options: SkillDescriptionOptions = {},
): Promise<string> {
  const skills = sortSkills(
    (await registry.listModelInvocable()).filter(
      (skill) => !skill.disableModelInvocation,
    ),
  );
  if (skills.length === 0) {
    return `${DESCRIPTION_HEADER}\n\n${NO_SKILLS_DESCRIPTION}`;
  }

  const fullLines = skills.map(
    (skill) =>
      `- ${skill.name}: ${truncate(skill.description, MAX_LISTING_DESC_CHARS)}`,
  );
  const budget = charBudget(options);
  const fullListing = fullLines.join("\n");
  if (fullListing.length <= budget) {
    return wrapListing(fullLines);
  }

  const fixedNameChars = skills.reduce(
    (total, skill) => total + `- ${skill.name}: `.length + 1,
    0,
  );
  const averageDescriptionChars = Math.floor(
    (budget - fixedNameChars) / skills.length,
  );
  if (averageDescriptionChars < MIN_DESC_LENGTH) {
    return wrapListing(nameOnlyLines(skills));
  }

  return wrapListing(
    skills.map(
      (skill) =>
        `- ${skill.name}: ${truncate(
          skill.description,
          Math.min(averageDescriptionChars, MAX_LISTING_DESC_CHARS),
        )}`,
    ),
  );
}

export function formatSkillToolOutput(content: SkillContent): string {
  const lines = [
    `## Skill: ${content.info.name}`,
    "",
    `**Base directory**: ${content.baseDir}`,
    `**Source**: ${content.info.scope}`,
  ];

  if (content.files.length > 0) {
    lines.push("", "**Available files**:");
    for (const file of content.files) {
      lines.push(`- ${file}`);
    }
  }

  lines.push("", content.content.trim());
  return lines.join("\n").trimEnd();
}

export function formatSkillResourceToolOutput(
  content: SkillResourceContent,
): string {
  return [
    `## Skill resource: ${content.info.name}/${content.path}`,
    "",
    content.content.trimEnd(),
  ].join("\n");
}

async function activateSkillRoot(input: {
  readonly baseDir: string;
  readonly context: Parameters<Tool["execute"]>[1];
  readonly name: string;
}): Promise<void> {
  await input.context.environment?.trustPath?.({
    kind: "active-skill",
    path: input.baseDir,
    source: input.name,
  });
}

export async function createSkillTool(
  registry: SkillToolRegistry,
  options: SkillDescriptionOptions = {},
): Promise<Tool> {
  return {
    annotations: { readOnlyHint: true },
    category: "skill",
    description: await buildSkillToolDescription(registry, options),
    name: "skill",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        name: {
          description: 'The skill name to load, for example "code-review".',
          type: "string",
        },
      },
      required: ["name"],
      type: "object",
    },
    source: "module",
    async execute(params, context): Promise<ToolExecutionResult> {
      const name = requiredString(params, "name");
      await assertModelInvocable(registry, name);
      const content = await registry.load(name);
      await activateSkillRoot({
        baseDir: content.baseDir,
        context,
        name: content.info.name,
      });
      return {
        metadata: {
          dir: content.baseDir,
          files: [...content.files],
          name: content.info.name,
        },
        output: formatSkillToolOutput(content),
      };
    },
  };
}

export function createSkillResourceTool(
  registry: SkillResourceToolRegistry,
): Tool {
  return {
    annotations: { readOnlyHint: true },
    category: "skill",
    description:
      "Read a helper or reference file from a loaded skill directory by relative path.",
    name: "skill_resource",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        name: {
          description: 'The skill name, for example "code-review".',
          type: "string",
        },
        path: {
          description:
            'Relative helper file path from the skill directory, for example "references/guide.md".',
          type: "string",
        },
      },
      required: ["name", "path"],
      type: "object",
    },
    source: "module",
    async execute(params, context): Promise<ToolExecutionResult> {
      const name = requiredString(params, "name");
      await assertModelInvocable(registry, name);
      const content = await registry.readResource(
        name,
        requiredString(params, "path"),
      );
      await activateSkillRoot({
        baseDir: content.baseDir,
        context,
        name: content.info.name,
      });
      return {
        metadata: {
          dir: content.baseDir,
          name: content.info.name,
          path: content.path,
        },
        output: formatSkillResourceToolOutput(content),
      };
    },
  };
}
