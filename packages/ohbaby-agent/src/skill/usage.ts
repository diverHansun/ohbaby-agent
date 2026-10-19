import type { UiPromptNamingSource } from "ohbaby-sdk";
import type { TextPart } from "../core/message/index.js";

/** Identity of a successfully expanded slash body, stored with that exact body. */
export interface SlashSkillUsage {
  readonly name: string;
  readonly source: "slash";
}

export function slashSkillUsage(
  source: { readonly skillName: string } | undefined,
): SlashSkillUsage | undefined {
  return source !== undefined &&
    "skillBodyExpanded" in source &&
    source.skillBodyExpanded === true
    ? { name: source.skillName, source: "slash" }
    : undefined;
}

export function slashSkillName(part: TextPart): string | undefined {
  const usage = part.metadata?.skillUsage;
  if (typeof usage !== "object" || usage === null) return undefined;
  const value = usage as Record<string, unknown>;
  return value.source === "slash" &&
    typeof value.name === "string" &&
    value.name.trim() !== ""
    ? value.name
    : undefined;
}

/** Only the backend command callback has just successfully expanded this body. */
export function expandedSkillNamingSource(
  source: UiPromptNamingSource | undefined,
): (UiPromptNamingSource & { readonly skillBodyExpanded: true }) | undefined {
  return source === undefined
    ? undefined
    : { ...source, skillBodyExpanded: true };
}

/** Keep public naming behavior, discarding any claimed internal body identity. */
export function publicNamingSource(
  source: UiPromptNamingSource | undefined,
): UiPromptNamingSource | undefined {
  return source === undefined
    ? undefined
    : { skillName: source.skillName, request: source.request };
}
