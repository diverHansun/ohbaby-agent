import { daemonAuthHeader } from "../../auth/token.js";
import type { DaemonState } from "./types.js";

export type DaemonHealthCheck = (state: DaemonState) => Promise<boolean>;

export const DAEMON_HEALTH_TIMEOUT_MS = 2_000;

export const fetchDaemonHealth: DaemonHealthCheck = async (
  state,
): Promise<boolean> => {
  if (!state.host || !state.port || !state.authToken) {
    return false;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, DAEMON_HEALTH_TIMEOUT_MS);

  try {
    const response = await fetch(
      `http://${state.host}:${String(state.port)}/api/health`,
      {
        headers: { authorization: daemonAuthHeader(state.authToken) },
        signal: controller.signal,
      },
    );
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
};
