export function matchesPattern(command: string, pattern: string): boolean {
  const escapeRegex = pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&");
  const regex = new RegExp(
    `^${escapeRegex.replaceAll("*", ".*").replace(/\s+/gu, "\\s+")}$`,
    "u",
  );
  return regex.test(command.trim());
}
