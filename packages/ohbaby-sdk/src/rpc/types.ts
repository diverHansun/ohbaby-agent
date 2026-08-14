import type { UiBackendClient, UiQueryClient } from "../client.js";

type CoreApiMethod =
  | "getSnapshot"
  | "getContextWindowUsage"
  | "listCommands"
  | "submitPrompt"
  | "compactSession"
  | "archiveSession"
  | "getCurrentModel"
  | "probeModelContextWindow"
  | "connectModel"
  | "setSearchApiKey"
  | "setPermission"
  | "executeCommand"
  | "respondPermission"
  | "respondInteraction"
  | "abortRun";

/** Improve-1 fake-RPC forward seam, derived from the authoritative backend. */
export type CoreAPI = Pick<UiBackendClient, CoreApiMethod>;

/** Improve-1 fake-RPC callback seam, derived from the authoritative query API. */
export type SDKAPI = Pick<UiQueryClient, "subscribeEvents">;
