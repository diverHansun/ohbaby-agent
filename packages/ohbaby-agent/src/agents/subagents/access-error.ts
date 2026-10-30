/** Terminal access failures shared by the host and UI projections. */
export function subagentAccessError(
  code: "SUBAGENT_CLOSED" | "SUBAGENT_NOT_FOUND",
): Error & { readonly code: typeof code } {
  return Object.assign(
    new Error(
      code === "SUBAGENT_CLOSED"
        ? "Subagent instance is closed"
        : "Subagent instance does not belong to this session",
    ),
    { code },
  );
}
