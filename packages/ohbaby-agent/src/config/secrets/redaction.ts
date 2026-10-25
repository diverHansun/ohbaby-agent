import type { McpServerConfig, McpStdioConfig } from "../mcp/types.js";

/** Project validated configuration URLs without changing their executable saved value. */
export function redactSettingsUrl(
  value: string,
  knownSecrets: readonly string[] = [],
): string {
  const url = new URL(value);
  let changed = false;
  if (url.username || url.password) {
    url.username = "[REDACTED]";
    url.password = "";
    changed = true;
  }
  // Match decoded query values as well: a header secret may occur under any key.
  const params = new URLSearchParams();
  for (const [key, queryValue] of url.searchParams) {
    const redacted = /key|token|password|secret|credential|authorization/i.test(
      key,
    )
      ? "[REDACTED]"
      : redactKnownSecrets(queryValue, knownSecrets);
    if (redacted !== queryValue) changed = true;
    params.append(key, redacted);
  }
  if (changed) url.search = params.toString();
  // Retain the previous masking of literal known secrets elsewhere in the URL.
  return redactKnownSecrets(changed ? url.toString() : value, knownSecrets);
}

export function redactSettingsError(
  error: string,
  configs: readonly McpServerConfig[] = [],
): string {
  return redactText(error, settingsSecrets(configs));
}

/** Mask credentials only in the public projection, never in executable args. */
export function redactSettingsArgs(config: McpStdioConfig): string[] {
  const secrets = settingsSecrets([config]);
  return config.args.map((argument) => {
    const urlsRedacted = argument.replace(/https?:\/\/[^\s"'<>]+/giu, (url) => {
      try {
        return redactSettingsUrl(url, secrets);
      } catch {
        // Args need not be valid URLs; an unparseable address is not safe to show.
        return "[REDACTED]";
      }
    });
    return redactText(urlsRedacted, secrets);
  });
}

function settingsSecrets(configs: readonly McpServerConfig[]): string[] {
  const secrets: string[] = [];
  for (const config of configs) {
    if (config.type === "stdio") {
      // Generic env values may be ports/flags. Explicit credential variables
      // remain sensitive even when their values are short.
      secrets.push(
        ...Object.entries(config.env ?? {})
          .filter(
            ([name, value]) =>
              /key|token|password|secret|credential|authorization/i.test(
                name,
              ) || value.length >= 8,
          )
          .map(([, value]) => value),
      );
      for (const [index, argument] of config.args.entries()) {
        const credentialArgument =
          /^--?(api[-_]?key|(?:access[-_]?|refresh[-_]?)?token|password|secret|credential|authorization|headers?)(?:=(.*))?$/i.exec(
            argument,
          );
        const shortHeader = argument.startsWith("-H");
        if (credentialArgument || shortHeader) {
          const value =
            credentialArgument?.at(2) ??
            (shortHeader && argument.length > 2
              ? argument.slice(2)
              : (config.args.at(index + 1) ?? ""));
          addArgumentSecrets(
            secrets,
            value,
            shortHeader || /^headers?$/i.test(credentialArgument?.at(1) ?? ""),
          );
          continue;
        }
        // A shell's -c command is one argument. Collect its sensitive values
        // here so args and errors, including value-only errors, share masking.
        for (const pattern of [
          /(?:^|\s)--?(api[-_]?key|(?:access[-_]?|refresh[-_]?)?token|password|secret|credential|authorization|headers?)(?:\s+|=)("(?:\\.|[^"\\])*"|'[^']*'|\S+)/giu,
          /(?:^|\s)-(H)\s*("(?:\\.|[^"\\])*"|'[^']*'|\S+)/gu,
        ]) {
          for (const [, flag, value] of argument.matchAll(pattern)) {
            addArgumentSecrets(secrets, value, /^(?:H|headers?)$/i.test(flag));
          }
        }
      }
    } else {
      secrets.push(...Object.values(config.headers ?? {}));
      const url = new URL(config.url);
      secrets.push(
        url.username,
        url.password,
        safeDecode(url.username),
        safeDecode(url.password),
      );
      for (const [key, value] of url.searchParams) {
        if (/key|token|password|secret|credential|authorization/i.test(key))
          secrets.push(value);
      }
    }
  }
  return secrets;
}

function addArgumentSecrets(
  secrets: string[],
  value: string,
  header: boolean,
): void {
  const unquoted = value.replace(/^(["'])([\s\S]*)\1$/, "$2");
  secrets.push(value, unquoted);
  const separator = header ? unquoted.indexOf(":") : -1;
  if (separator >= 0) {
    const credential = unquoted.slice(separator + 1).trim();
    secrets.push(credential, credential.replace(/^(?:Basic|Bearer)\s+/i, ""));
  }
}

function redactText(value: string, secrets: readonly string[]): string {
  return redactKnownSecrets(value, secrets)
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/(\bBearer\s+)[^\s,;"']+/gi, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|credential|authorization)["']?\s*[:=]\s*["']?)[^\s&,;"']+/gi,
      "$1[REDACTED]",
    );
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function redactKnownSecrets(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of secrets
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)) {
    result = result.replaceAll(secret, "[REDACTED]");
  }
  return result;
}
