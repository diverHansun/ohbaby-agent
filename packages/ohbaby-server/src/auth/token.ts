import { randomUUID } from "node:crypto";

const TOKEN_PREFIX = "ohbaby_";

export function createDaemonAuthToken(): string {
  return `${TOKEN_PREFIX}${randomUUID()}`;
}

export function daemonAuthHeader(token: string): string {
  return `Bearer ${token}`;
}

export function isAuthorizedDaemonRequest(
  authorization: string | undefined,
  token: string | undefined,
): boolean {
  if (!token) {
    return true;
  }
  return authorization === daemonAuthHeader(token);
}

export function redactDaemonAuthToken(token: string | undefined): string {
  if (!token) {
    return "";
  }
  return token.startsWith(TOKEN_PREFIX) ? `${TOKEN_PREFIX}...` : "...";
}
