/** The skill name the backend put on a slash call's visible text part. */
export function skillMarkerName(
  metadata: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const marker = metadata?.skillMarker;
  if (typeof marker !== "object" || marker === null) return undefined;
  const name = (marker as { readonly name?: unknown }).name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

/**
 * Splits `/name request` into the token and the request (frontend 06 §2). Only
 * a marked message splits, and only when its text starts exactly with the
 * name; anything else is shown as it is.
 */
export function splitSkillText(
  text: string,
  skillName: string | undefined,
): { readonly skill: string | null; readonly text: string } {
  if (skillName === undefined) return { skill: null, text };
  const head = `/${skillName}`;
  if (text === head) return { skill: skillName, text: "" };
  if (text.startsWith(`${head} `) || text.startsWith(`${head}\n`))
    return { skill: skillName, text: text.slice(head.length + 1) };
  return { skill: null, text };
}
