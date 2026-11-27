/**
 * The text a skill call submits: `/name request`, or `/name` alone (frontend
 * 06 §2). Only the ends are trimmed, as before; line breaks stay as typed.
 */
export function composeSkillText(skill: string | null, text: string): string {
  if (skill === null) return text;
  const request = text.trim();
  return request === "" ? `/${skill}` : `/${skill} ${request}`;
}
