import type { CreatePartInput } from "../core/message/types.js";
import { SKILL_BODY_KIND } from "../core/message/origin.js";
import { SkillLoadError, SkillNotFoundError } from "./errors.js";
import { formatSkillToolOutput } from "./tool.js";
import type { SkillRegistryPort } from "./types.js";
import {
  type SlashSubmission,
  legacySlashBody,
  slashSkillUsage,
} from "./usage.js";

export type UserTextPartInput = Extract<CreatePartInput, { type: "text" }>;

/** Unmarked text stays on the ordinary prompt path. */
export async function expandSlashSkill(
  prompt: SlashSubmission,
  registry: () => Promise<SkillRegistryPort>,
): Promise<readonly UserTextPartInput[] | undefined> {
  const skillUsage = slashSkillUsage(prompt.namingSource);
  if (!skillUsage) return undefined;
  if (legacySlashBody(prompt))
    return [{ type: "text", text: prompt.text, metadata: { skillUsage } }];
  try {
    const content = await (await registry()).load(skillUsage.name);
    if (content.info.userInvocable) {
      const name = content.info.name;
      return [
        {
          type: "text",
          synthetic: true,
          metadata: { kind: SKILL_BODY_KIND, skillUsage },
          text: `<skill name="${name}">\n${formatSkillToolOutput(content)}\n</skill>\n\n`,
        },
        {
          type: "text",
          text: prompt.text.slice(name.length + 2),
          metadata: { displayText: prompt.text, skillMarker: { name } },
        },
      ];
    }
  } catch (error) {
    if (
      !(error instanceof SkillLoadError || error instanceof SkillNotFoundError)
    )
      throw error;
  }
  return [{ type: "text", text: prompt.text }];
}
