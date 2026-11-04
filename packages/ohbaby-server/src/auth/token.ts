import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

const TOKEN_PREFIX = "ohbaby_";

export function createDaemonAuthToken(): string {
  return `${TOKEN_PREFIX}${randomUUID()}`;
}

export function daemonAuthHeader(token: string): string {
  return `Bearer ${token}`;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Fails closed: with no configured token nothing is authorized. Comparing
 * fixed-length digests keeps the check constant-time for any header length.
 */
export function isAuthorizedDaemonRequest(
  authorization: string | undefined,
  token: string | undefined,
): boolean {
  if (!token || authorization === undefined) {
    return false;
  }
  return timingSafeEqual(
    digest(authorization),
    digest(daemonAuthHeader(token)),
  );
}

export function redactDaemonAuthToken(token: string | undefined): string {
  if (!token) {
    return "";
  }
  return token.startsWith(TOKEN_PREFIX) ? `${TOKEN_PREFIX}...` : "...";
}
