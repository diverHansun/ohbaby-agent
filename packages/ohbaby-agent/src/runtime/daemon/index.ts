export { Supervisor } from "./supervisor.js";
export type { SupervisorOptions } from "./supervisor.js";
export { PermissionRouter } from "./permission-router.js";
export {
  createDaemonAuthToken,
  daemonAuthHeader,
  isAuthorizedDaemonRequest,
  redactDaemonAuthToken,
} from "./auth.js";
export * from "./protocol.js";
export {
  DaemonPromptQueue,
  DaemonPromptQueueShutdownError,
} from "./prompt-queue.js";
export type {
  DaemonPromptQueueItem,
  DaemonPromptQueueOptions,
} from "./prompt-queue.js";
export { ensureDaemonRunning } from "./spawn.js";
export type {
  EnsureDaemonRunningOptions,
  RunningDaemonConnection,
} from "./spawn.js";
export { createDaemonHttpServer } from "./server.js";
export type {
  DaemonHttpServerHandle,
  DaemonHttpServerOptions,
} from "./server.js";
export {
  createRemoteCoreApiHost,
  createRemoteUiBackendClient,
} from "./client.js";
export type { RemoteDaemonClientOptions } from "./client.js";
export {
  readDaemonStatus,
  startDaemonServer,
  stopDaemonFromState,
} from "./main.js";
export type {
  RunningDaemonServer,
  StartDaemonServerOptions,
} from "./main.js";
export type { DaemonState } from "./types.js";
