import type { UiBackendClient, UiQueryClient } from "../client.js";

/** Fake-RPC forward seam: the backend contract without its reverse event port. */
export type CoreAPI = Omit<UiBackendClient, "subscribeEvents">;

/** Fake-RPC callback seam, derived from the authoritative query API. */
export type SDKAPI = Pick<UiQueryClient, "subscribeEvents">;
