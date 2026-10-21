function isStrictIpv4Literal(host: string): boolean {
  const segments = host.split(".");
  return (
    segments.length === 4 &&
    segments.every((segment) => {
      if (!/^(?:0|[1-9][0-9]{0,2})$/u.test(segment)) {
        return false;
      }
      return Number(segment) <= 255;
    })
  );
}

/**
 * Returns whether a bind host is an unambiguous loopback IP literal.
 *
 * Hostnames are deliberately rejected: resolving them can bind a daemon to a
 * non-loopback interface even when their text resembles a loopback address.
 */
export function isLoopbackHost(host: string): boolean {
  const normalized =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isStrictIpv4Literal(normalized)) {
    return normalized.split(".", 1)[0] === "127";
  }
  return normalized === "::1";
}
