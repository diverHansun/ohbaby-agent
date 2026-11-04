import { isLoopbackHost } from "ohbaby-sdk";

/** Parse the HTTP authority without URL's permissive numeric-IP normalization. */
function hostname(authority: string | undefined): string | undefined {
  if (!authority) return undefined;
  const match = /^(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+)(?::([0-9]+))?$/u.exec(
    authority,
  );
  if (!match || (match[2] && Number(match[2]) > 65535)) return undefined;
  return match[1].toLowerCase();
}

export function isAllowedDaemonHost(
  host: string | undefined,
  boundHost: string,
): boolean {
  if (!isLoopbackHost(boundHost)) return true;
  const name = hostname(host);
  const bound = boundHost === "::1" ? "[::1]" : boundHost;
  return (
    name !== undefined &&
    ["localhost", "127.0.0.1", "[::1]", bound].includes(name)
  );
}

export function isAllowedTerminalOrigin(
  origin: string | undefined,
  boundHost: string,
): boolean {
  if (origin === undefined) return true;
  // An Origin is a scheme and authority, without credentials, path, or query.
  const match = /^https?:\/\/([^/?#]+)$/u.exec(origin);
  return match !== null && isAllowedDaemonHost(match[1], boundHost);
}
