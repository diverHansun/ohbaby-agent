/**
 * What the user reads when a fork or an edit (rewind) is refused (session
 * actions frontend design §7). The Web notices, the Web edit box and the TUI
 * status line share these texts.
 */
const TEXTS: Readonly<
  Partial<Record<string, { readonly fork?: string; readonly edit?: string }>>
> = {
  FORK_TARGET_INVALID: { fork: "Nothing to fork yet" },
  REWIND_TARGET_INVALID: { edit: "This message can no longer be edited" },
  REWIND_BEFORE_COMPACTION: {
    edit: "This message was compacted and can't be edited",
  },
  SESSION_RUNNING: { edit: "The session is busy, try again in a moment" },
  SESSION_ARCHIVED: {
    fork: "Archived sessions can't be forked",
    edit: "Archived sessions can't be edited",
  },
  SESSION_MOVED: {
    fork: "This chat moved to another folder. Open it there to fork",
    edit: "This chat moved to another folder. Open it there to edit",
  },
  SESSION_NOT_FOUND: {
    fork: "This chat no longer exists",
    edit: "This chat no longer exists",
  },
};

export function sessionActionErrorText(
  action: "fork" | "edit" | "rewind",
  error: unknown,
): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;
  const key = action === "rewind" ? "edit" : action;
  const known = typeof code === "string" ? TEXTS[code]?.[key] : undefined;
  if (known) return known;
  const detail = error instanceof Error ? error.message : String(error);
  return `Something went wrong: ${detail}`;
}
