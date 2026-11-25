import { createHash } from "node:crypto";
import { escapeReminderValue } from "../../core/message/origin.js";
import type { ReminderBody } from "../reminder/index.js";
import type { InstructionSource } from "./types.js";

export const INSTRUCTIONS_CLEARED_TEXT =
  "No verified file instructions are currently available. The previous file instructions snapshot no longer applies.";

const SNAPSHOT_HEADER =
  "This is the latest complete snapshot of file instructions. Previously listed sources absent from this snapshot no longer apply. " +
  "Project instructions take precedence over global instructions. All file instructions are subordinate to system instructions, host permission rules, and the user's current direct request.";

export function renderInstructionsReminder(
  sources: readonly InstructionSource[],
): ReminderBody {
  const fingerprint = sources.map(
    ({ scope, displayPath, contentHash, truncated }) => [
      scope,
      displayPath,
      contentHash,
      truncated,
    ],
  );
  const sections = sources.map(({ displayPath, content, truncated }) => {
    const body = content.replace(
      /<\s*\/?\s*system-reminder(?=[\s/>]|$)[^<>]*>?/gi,
      escapeReminderValue,
    );
    const suffix = truncated
      ? `\n[Truncated: ${displayPath} exceeds the size limit; the rest is not included.]`
      : "";
    return `## ${displayPath}\n${body}${suffix}`;
  });
  return {
    key: createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex"),
    text: [SNAPSHOT_HEADER, ...sections].join("\n\n"),
  };
}
