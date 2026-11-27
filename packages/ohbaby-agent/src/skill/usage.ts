import { isSkillBodyPart } from "../core/message/origin.js";
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
  if (!part.text.trim() || (part.synthetic && !isSkillBodyPart(part)))
    return undefined;
  const usage = part.metadata?.skillUsage;
  if (typeof usage !== "object" || usage === null) return undefined;
  const value = usage as Record<string, unknown>;
  return value.source === "slash" &&
    typeof value.name === "string" &&
    value.name.trim() !== ""
    ? value.name
    : undefined;
}

/** Persisted marker for a backend-validated slash invocation (older records already contain the body). */
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

export interface SlashSubmission {
  text: string;
  namingSource?: UiPromptNamingSource;
}

export function slashSubmission(
  name: string,
  rawArgs: string,
  body?: string,
): SlashSubmission {
  const suffix = (rawArgs ? " " + rawArgs : "") + (body ? "\n" + body : "");
  return {
    text: "/" + name + suffix,
    namingSource: expandedSkillNamingSource({
      skillName: name,
      request: suffix.slice(1),
    }),
  };
}

export function legacySlashBody(prompt: SlashSubmission): boolean {
  return !!slashSkillUsage(prompt.namingSource) && !prompt.text.startsWith("/");
}

export function promptInputText(prompt: SlashSubmission): string {
  const source = prompt.namingSource;
  return source && legacySlashBody(prompt)
    ? "/" + source.skillName + (source.request ? " " + source.request : "")
    : prompt.text;
}
