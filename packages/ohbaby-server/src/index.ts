export {
  createDaemonServerApp,
  type DaemonServerAppHandle,
  type DaemonServerAppOptions,
} from "./app/create-app.js";
export {
  createDaemonAuthToken,
  daemonAuthHeader,
  isAuthorizedDaemonRequest,
  redactDaemonAuthToken,
} from "./auth/token.js";
export * from "./protocols/jsonrpc/protocol.js";
export { PermissionRouter } from "./coordination/permission-router.js";
export {
  createRemoteCoreApiHost,
  createRemoteUiBackendClient,
} from "./protocols/jsonrpc/client.js";
export type { RemoteDaemonClientOptions } from "./protocols/jsonrpc/client.js";
export {
  listDaemonConnections,
  readDaemonStatus,
  startDaemonServer,
  stopDaemonFromState,
} from "./runtime/daemon/main.js";
export {
  InstanceStore,
  type DisposableWorkspaceInstance,
  type InstanceStoreOptions,
} from "./runtime/instance-store.js";
export {
  resolveWorkspaceScope,
  WorkspaceScopeError,
  type WorkspaceScopeErrorCode,
} from "./runtime/workspace-scope.js";
export type {
  DaemonConnectionInfo,
  ListDaemonConnectionsOptions,
  RunningDaemonServer,
  StartDaemonServerOptions,
} from "./runtime/daemon/main.js";
export type { DaemonState } from "./runtime/daemon/types.js";
export type { CoreApiHost } from "ohbaby-agent";
