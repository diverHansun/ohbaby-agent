export function stripMatchingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

export function stripRedirectionPrefix(token: string): string {
  return token.replace(/^(?:\d+|&)?[<>]+/u, "");
}

export function normalizeOptionName(token: string): string {
  const equalsIndex = token.indexOf("=");
  const colonIndex = token.indexOf(":");
  const endIndexes = [equalsIndex, colonIndex].filter((index) => index > 0);
  const end = endIndexes.length > 0 ? Math.min(...endIndexes) : token.length;
  return token.slice(0, end).toLowerCase();
}

export function optionValue(token: string): string | null {
  const equalsIndex = token.indexOf("=");
  if (equalsIndex > 0) {
    return token.slice(equalsIndex + 1);
  }
  const colonIndex = token.indexOf(":");
  if ((token.startsWith("/") || token.startsWith("-")) && colonIndex > 1) {
    return token.slice(colonIndex + 1);
  }

  return null;
}

export function candidatePathFromToken(token: string): string | null {
  const normalized = stripMatchingQuotes(stripRedirectionPrefix(token));
  const value = optionValue(normalized) ?? normalized;
  return value.length > 0 ? value : null;
}

export function msysPathToWindowsPath(target: string): string | null {
  const match = /^\/([A-Za-z])(?:\/(.*))?$/u.exec(target);
  if (!match || process.platform !== "win32") {
    return null;
  }
  const drive = match[1].toUpperCase();
  const rest = match[2] ? match[2].replace(/\//gu, "\\") : "";
  return `${drive}:\\${rest}`;
}
